// The sacred path (README "Teardown"): drive a service from observed present
// to observed absence. Delete acceptance is not completion, so the only
// success exit is an observation that the service is gone; the only other
// exit is cooperative shutdown. The loop never gives up, never trusts
// acceptance, and never mutates blind.
//
// Scheduling is awaited sleeps inside one loop - the same guarantee as
// recursive setTimeout, and the opposite of setInterval: the next tick cannot
// start until the current delete-and-observe pass has finished, so slow API
// calls can never stack overlapping requests.

import type { GqlConfig } from "./gql-request.js";
import type { Target } from "./operations.js";
import type { Observation } from "./transitions.js";

/** First retry waits about this long; each present observation doubles it. */
export const DELETE_BACKOFF_BASE_MS = 1_000;
/** Backoff ceiling, jitter included: the loop never waits longer than this. */
export const DELETE_BACKOFF_CAP_MS = 30_000;

export interface DeleteLoopDeps {
  config: GqlConfig;
  target: Target;
  /** The delete request (operations.deleteService in production). Acceptance only. */
  deleteService: (config: GqlConfig, target: Target, serviceId: string) => Promise<boolean>;
  /** The reconciler's observe, pre-bound; classifies failures itself and never throws. */
  observe: () => Promise<Observation>;
  /** Backoff sleep; tests inject a recorder that resolves immediately. */
  sleep: (ms: number) => Promise<void>;
  /** Jitter source returning a float in [0, 1). */
  random: () => number;
  /** Cooperative shutdown: the loop exits promptly once this returns false. */
  shouldContinue: () => boolean;
}

/**
 * Fight until the service identified by serviceId is observed absent.
 *
 * Each pass: fire deleteService (only while the service was last observed
 * present), then observe regardless of what the delete call did - a delete
 * that timed out or threw may still have applied server-side, so the
 * observation is the verdict, never the mutation's own result. Absent ends
 * the loop as success, even right after a failed delete call: the side
 * effect landed, and that is all we ever wanted. Present increments the
 * attempt counter, reports it through onUpdate, and backs off. Unknown
 * means the read failed: we do NOT re-fire the delete against a world we
 * cannot see - we sleep and look again.
 */
export async function runDeleteLoop(
  deps: DeleteLoopDeps,
  serviceId: string,
  onUpdate: (attempts: number) => void,
): Promise<void> {
  let attempts = 0;
  // The caller starts this loop against a service it observed present, so the
  // first pass is entitled to fire the delete.
  let lastSeen: "present" | "unknown" = "present";

  while (deps.shouldContinue()) {
    if (lastSeen === "present") {
      try {
        await deps.deleteService(deps.config, deps.target, serviceId);
      } catch {
        // Deliberately swallowed: acceptance failure vs applied-but-lost
        // response is ambiguous, and the observation below - not this error -
        // decides what actually happened.
      }
    }

    const observation = await deps.observe();
    if (observation.kind === "absent") {
      // Observed absence is the one and only definition of success.
      return;
    }
    if (observation.kind === "present") {
      attempts += 1;
      onUpdate(attempts);
      lastSeen = "present";
    } else {
      // Read failed. Not absence, not permission to mutate: hold fire.
      lastSeen = "unknown";
    }

    if (!deps.shouldContinue()) return;
    await deps.sleep(backoffDelayMs(attempts, deps.random));
  }
}

// Exponential from the attempt count, plus up to one base unit of jitter so
// restarts do not stampede in phase, capped (jitter included) at 30s. Before
// any present re-observation (attempts 0) it waits one base unit. 2**n runs
// away to Infinity for large n; Math.min makes that harmless.
function backoffDelayMs(attempts: number, random: () => number): number {
  const retryIndex = attempts > 0 ? attempts - 1 : 0;
  const exponential = DELETE_BACKOFF_BASE_MS * 2 ** retryIndex;
  const jitter = Math.floor(random() * DELETE_BACKOFF_BASE_MS);
  return Math.min(DELETE_BACKOFF_CAP_MS, exponential + jitter);
}
