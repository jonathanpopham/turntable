// The core state model. Three things are kept separate on purpose and never
// collapsed: what we WANT (Intent, durable), what we last SAW (Observation,
// from the Railway read path), and what we SHOW (ViewState, derived). Every
// function here is pure: no IO, no clocks, everything from arguments.
//
// Style: explicit loops and exhaustive switches sealed with assertNever;
// string-literal unions, never enums (see README style note).

/** What the operator asked for. Durable. null = no intent recorded yet. */
export type Intent = "PRESENT" | "ABSENT";

/** The 13 known Railway DeploymentStatus values (docs/schema-notes.md). */
export type Phase =
  | "BUILDING"
  | "CRASHED"
  | "DEPLOYING"
  | "FAILED"
  | "INITIALIZING"
  | "NEEDS_APPROVAL"
  | "QUEUED"
  | "REMOVED"
  | "REMOVING"
  | "SKIPPED"
  | "SLEEPING"
  | "SUCCESS"
  | "WAITING";

/**
 * A wire status outside the known 13. The enum grew before and will grow
 * again, so an unrecognized status is data, not a crash: the read path wraps
 * it before it gets here, and it flows through with the raw string intact.
 */
export type UnknownPhase = { kind: "unknown"; raw: string };

/**
 * What the last read of Railway told us. Exactly one of three shapes:
 * - "absent":  the read SUCCEEDED and the service was not there.
 * - "present": the read SUCCEEDED and the service was there. phase is null
 *              during the real window where a service exists with zero
 *              deployments yet.
 * - "unknown": the read FAILED. An unreachable API is never evidence of
 *              absence, so this is its own kind, not "absent".
 */
export type Observation =
  | { kind: "absent"; observedAt: number; version: number }
  | {
      kind: "present";
      serviceId: string;
      phase: Phase | UnknownPhase | null;
      observedAt: number;
      version: number;
    }
  | { kind: "unknown"; reason: string; observedAt: number; version: number };

/** Everything the engine knows, in one immutable value. */
export type Snapshot = {
  intent: Intent | null;
  observation: Observation;
  deleteAttempts: number;
};

/** What the UI shows. Derived, never stored. */
export type ViewState =
  | { state: "idle" }
  | { state: "creating"; rawPhase: string }
  | { state: "running" }
  | { state: "sleeping" }
  | { state: "failed"; reason: string }
  | { state: "deleting"; attempts: number }
  | { state: "delete_stuck"; attempts: number }
  | { state: "unknown"; reason: string };

export type Command = "up" | "down";

/** What the engine should do about a command, given a snapshot. */
export type Decision =
  | { action: "create" }
  | { action: "delete"; serviceId: string }
  // "down" during the create-visibility gap: nothing visible to delete yet,
  // but the desire must be PERSISTED, not swallowed (review finding: a
  // coalesce here looked like a cancel while the service could still appear
  // and run). The engine records ABSENT; reconciliation deletes any
  // late-visible service.
  | { action: "record-absent"; view: ViewState }
  | { action: "coalesce"; view: ViewState }
  | { action: "conflict"; view: ViewState };

/** Delete retries at or beyond this count surface as delete_stuck. */
export const DELETE_STUCK_THRESHOLD = 5;

/** Seals exhaustive switches over INTERNAL unions. Wire data never reaches this. */
export function assertNever(x: never): never {
  throw new Error(`unreachable: ${JSON.stringify(x)}`);
}

/**
 * Snapshot -> ViewState. Total: every observation kind, every phase (known,
 * unknown-wrapped, and null), every intent value maps to exactly one view.
 */
export function deriveView(snapshot: Snapshot): ViewState {
  const view = baseView(snapshot);
  if (view.state === "deleting" && snapshot.deleteAttempts >= DELETE_STUCK_THRESHOLD) {
    return { state: "delete_stuck", attempts: snapshot.deleteAttempts };
  }
  return view;
}

function baseView(snapshot: Snapshot): ViewState {
  const { intent, observation, deleteAttempts } = snapshot;
  switch (observation.kind) {
    case "unknown":
      // The last read failed. We do not know, so we say so. NEVER idle:
      // idle invites "up", and "up" against an unobserved world double-creates.
      return { state: "unknown", reason: observation.reason };
    case "absent":
      // We asked for it and it is not visible yet: that is creating, not idle.
      if (intent === "PRESENT") return { state: "creating", rawPhase: "REQUESTED" };
      return { state: "idle" };
    case "present":
      return presentView(intent, observation.phase, deleteAttempts);
    default:
      return assertNever(observation);
  }
}

function presentView(
  intent: Intent | null,
  phase: Phase | UnknownPhase | null,
  attempts: number,
): ViewState {
  // Teardown intent dominates EVERY present observation. A building, failed,
  // sleeping, or not-yet-deployed service we have been asked to remove is
  // teardown in progress; anything else (review finding) shows a state whose
  // button can change intent mid-teardown.
  if (intent === "ABSENT") {
    return { state: "deleting", attempts };
  }
  if (phase === null) {
    // Real observable window: service exists, zero deployments yet.
    return { state: "creating", rawPhase: "PENDING" };
  }
  if (typeof phase === "object") {
    // Unrecognized wire status, pre-wrapped by the read path. Surface the raw
    // status and let reconciliation sort it out.
    return { state: "failed", reason: `unrecognized status ${phase.raw}` };
  }
  switch (phase) {
    case "QUEUED":
    case "WAITING":
    case "INITIALIZING":
    case "BUILDING":
    case "DEPLOYING":
      // Surface the phase verbatim so the UI shows real progress, not a spinner.
      return { state: "creating", rawPhase: phase };
    case "SUCCESS":
      // ABSENT was handled above; a present SUCCESS here is simply running.
      return { state: "running" };
    case "SLEEPING":
      // Railway app-sleep: a running variant, surfaced honestly.
      return { state: "sleeping" };
    case "FAILED":
    case "CRASHED":
      return { state: "failed", reason: `deployment ${phase}` };
    case "REMOVING":
      return { state: "deleting", attempts };
    case "REMOVED":
      // Deployment removed but the service is still visible: teardown has not
      // finished. NOT idle; idle is earned by observed absence only.
      return { state: "deleting", attempts };
    case "NEEDS_APPROVAL":
    case "SKIPPED":
      // Should not occur for image deploys; if it does, say exactly that.
      return { state: "failed", reason: `unexpected status ${phase} for an image deploy` };
    default:
      return assertNever(phase);
  }
}

/**
 * Command x view -> decision. The table below is the whole policy:
 *
 *   view          | up       | down
 *   --------------+----------+-------------------------------
 *   idle          | create   | coalesce (already down)
 *   creating      | coalesce | delete if a service is visible,
 *                 |          | else coalesce (intent flip suffices)
 *   running       | coalesce | delete
 *   sleeping      | coalesce | delete
 *   failed        | create   | delete (cancel saves money)
 *   deleting      | conflict | coalesce (already going down)
 *   delete_stuck  | conflict | coalesce (still fighting)
 *   unknown       | conflict | delete if a serviceId is known,
 *                 |          | else conflict (cannot act on what we cannot see)
 *
 * Same-direction commands coalesce: no mutation, no error, current view back.
 * "up" while teardown is in flight is the only true conflict on the up side;
 * creating into a half-deleted slot is how orphans are born.
 */
export function decide(command: Command, snapshot: Snapshot): Decision {
  const view = deriveView(snapshot);
  const observation = snapshot.observation;
  const serviceId = observation.kind === "present" ? observation.serviceId : null;

  switch (view.state) {
    case "idle":
      return command === "up" ? { action: "create" } : { action: "coalesce", view };
    case "creating":
      if (command === "up") return { action: "coalesce", view };
      return deleteIfVisible(serviceId, view);
    case "running":
    case "sleeping":
      return command === "up" ? { action: "coalesce", view } : deleteIfVisible(serviceId, view);
    case "failed":
      return command === "up" ? { action: "create" } : deleteIfVisible(serviceId, view);
    case "deleting":
    case "delete_stuck":
      return command === "up" ? { action: "conflict", view } : { action: "coalesce", view };
    case "unknown":
      if (command === "down" && serviceId !== null) return { action: "delete", serviceId };
      return { action: "conflict", view };
    default:
      return assertNever(view);
  }
}

/**
 * "down" against a view that permits deletion. If a service is visible we
 * delete it by id. If the view is intent-only (creating derived from
 * absent + intent PRESENT), there is nothing visible to delete yet: recording
 * intent ABSENT durably is the whole job, and reconciliation deletes any
 * service that appears later.
 */
function deleteIfVisible(serviceId: string | null, view: ViewState): Decision {
  if (serviceId !== null) return { action: "delete", serviceId };
  return { action: "record-absent", view };
}
