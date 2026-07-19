// The bridge from Railway reality to the pure model in transitions.ts. Two
// jobs live here: turning one read of the API into an Observation (observe),
// and turning durable intent plus one observation into the boot snapshot and
// its resume action (reconcileOnBoot). All IO arrives through injected deps,
// so every path - including every failure path - is testable offline.
//
// Style: explicit loops over array-method chains; single pass, zero
// intermediate allocations (see README "Decisions").

import type { GqlConfig } from "./gql-request.js";
import type { ProjectServicesResult, ServiceSnapshot } from "./gql-guards.js";
import { parseDeploymentStatus } from "./gql-guards.js";
import { MANAGED_SERVICE_NAME } from "./operations.js";
import type { Target } from "./operations.js";
import type { Intent, Observation, Snapshot } from "./transitions.js";
import type { StoredIntent } from "./intent-store.js";

/** Everything observe needs; production wires the real client, tests stub it. */
export interface ObserveDeps {
  config: GqlConfig;
  target: Target;
  /** The project read (operations.getProjectServices in production). */
  getProjectServices: (config: GqlConfig, target: Target) => Promise<ProjectServicesResult>;
  /** Monotonic version source: every observation, failed reads included, gets the next value. */
  nextVersion: () => number;
  /** Injected clock (ms) so observedAt is deterministic under test. */
  clock: () => number;
}

/** Monotonic per-process observation counter: 1, 2, 3, ... */
export function makeVersionCounter(): () => number {
  let version = 0;
  return () => {
    version += 1;
    return version;
  };
}

/**
 * One read of Railway, classified into exactly one Observation shape.
 * ANY thrown error - auth, rate limit, timeout, shape mismatch - becomes
 * kind "unknown": a failed read is never evidence of absence. This function
 * itself never throws; not-knowing is a value, not an exception.
 */
export async function observe(deps: ObserveDeps): Promise<Observation> {
  let result: ProjectServicesResult;
  try {
    result = await deps.getProjectServices(deps.config, deps.target);
  } catch (e: unknown) {
    return {
      kind: "unknown",
      reason: describeError(e),
      observedAt: deps.clock(),
      version: deps.nextVersion(),
    };
  }

  // Find the managed service by its deterministic name. Railway rejects
  // duplicate names inside a project, so a name match is never ambiguous.
  let managed: ServiceSnapshot | null = null;
  for (const service of result.services) {
    if (service.name === MANAGED_SERVICE_NAME) {
      managed = service;
      break;
    }
  }

  const observedAt = deps.clock();
  const version = deps.nextVersion();
  if (managed === null) {
    return { kind: "absent", observedAt, version };
  }
  // null = the service exists with zero deployments: a first-class observable
  // fact (docs/schema-notes.md), not an error. Otherwise classify the raw
  // status; unrecognized values flow through wrapped, raw string intact.
  const phase =
    managed.latestDeployment === null ? null : parseDeploymentStatus(managed.latestDeployment.status);
  return { kind: "present", serviceId: managed.id, phase, observedAt, version };
}

// Class name plus message, never the token: the transport already scrubs the
// token out of every message it constructs (gql-request redactedSnippet), and
// this layer adds nothing beyond the error's own name and message.
function describeError(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  return `non-Error thrown: ${String(e)}`;
}

/** What boot reconciliation asks the engine to pick back up, if anything. */
export type ResumeAction =
  | "none"
  | "resume-create"
  | "trigger-deploy"
  | "resume-delete"
  | "retry-observe";

export interface BootDeps extends ObserveDeps {
  /** Durable intent source (IntentStore in production; structural so tests stub load). */
  intentStore: { load(): Promise<StoredIntent | null> };
}

/**
 * Boot reconciliation: load durable intent, take one observation, and decide
 * what a restarted process must resume. The rules live in deriveResumeAction;
 * this function just assembles the inputs and the initial Snapshot.
 */
export async function reconcileOnBoot(
  deps: BootDeps,
): Promise<{ snapshot: Snapshot; resumeAction: ResumeAction }> {
  // Independent IO (local disk vs Railway API): run in parallel.
  const [stored, observation] = await Promise.all([deps.intentStore.load(), observe(deps)]);
  const intent: Intent | null = stored === null ? null : stored.desired;
  const snapshot: Snapshot = { intent, observation, deleteAttempts: 0 };
  return { snapshot, resumeAction: deriveResumeAction(intent, observation) };
}

/** Intent x observation -> resume action. First matching rule wins, top to bottom. */
export function deriveResumeAction(intent: Intent | null, observation: Observation): ResumeAction {
  // No intent ever recorded: adopt reality as found and never auto-delete without recorded intent.
  if (intent === null) return "none";
  // Teardown was requested and the service survived a restart: the no-leak guarantee resumes the fight.
  if (intent === "ABSENT" && observation.kind === "present") return "resume-delete";
  // Create ran but the process died before serviceInstanceDeploy: project-token creates never auto-deploy (docs/schema-notes.md).
  if (intent === "PRESENT" && observation.kind === "present" && observation.phase === null) {
    return "trigger-deploy";
  }
  // Presence was requested and nothing is there: pick the create back up.
  if (intent === "PRESENT" && observation.kind === "absent") return "resume-create";
  // The read failed, so we cannot know what to resume: observe again, never act blind.
  if (observation.kind === "unknown") return "retry-observe";
  // Every remaining pairing is already converged or converging on its own.
  return "none";
}
