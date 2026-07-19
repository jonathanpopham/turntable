// The UI's brain, DOM-free on purpose: wire JSON in, render-ready values out.
// Everything decidable is decided here so it can be proven in node tests
// without a browser; src/client.ts only moves these values into elements.
//
// Wire data enters as `unknown` and leaves through parseStatusResponse /
// parseCommandResponse or not at all, the same rule the server applies to
// Railway responses. One deliberate asymmetry: an unrecognized `view.state`
// value is NOT a malformed body. The server's own enum handling proves wire
// enums grow, so a future state degrades to the "unknown" view (rendered,
// button disabled, fast poll) instead of crashing the page.
//
// Style: explicit loops, string-literal unions, exhaustive switches sealed
// with assertNever (see README "Decisions").

import { assertNever, type Command, type Intent, type ViewState } from "./transitions.js";

/** GET /api/status, after the guard. */
export type StatusResponse = {
  view: ViewState;
  intent: Intent | null;
  observedAt: number;
  version: number;
  /** Per-process id; versions restart with the controller, so the version floor resets when this changes. */
  bootId: string;
  /** Managed service id when observed present; shows the live Railway effect. */
  serviceId: string | null;
};

/** POST /api/up | /api/down, after the guard. 409 bodies carry "conflict". */
export type CommandResponse = {
  outcome: "started" | "coalesced" | "conflict";
  view: ViewState;
};

export type StateTone = "neutral" | "active" | "good" | "bad" | "warn";

/** Everything the DOM needs, precomputed. */
export type ViewModel = {
  stateLabel: string;
  stateTone: StateTone;
  /** Phase verbatim, failure reason, attempts text, or "" when there is nothing to add. */
  detail: string;
  buttonLabel: "Spin up" | "Spin down";
  buttonCommand: Command;
  buttonEnabled: boolean;
  pollMs: number;
  showSpinner: boolean;
};

// Poll cadences. Fast only while something is actually moving (or unknown,
// where fast resolution matters); at rest the UI is quota-bounded.
export const POLL_FAST_MS = 2_000;
export const POLL_SETTLED_MS = 15_000;
export const POLL_AT_REST_MS = 60_000;

/** Narrow to a plain object usable with string-key indexing. Arrays excluded. */
function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function isFiniteNumber(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

/**
 * Guard one wire ViewState. Known states get their payloads checked strictly
 * (a "creating" without a string rawPhase is malformed, not salvageable).
 * A state string this build has never heard of degrades to the unknown view
 * with the raw value preserved in the reason.
 */
function parseViewState(x: unknown): ViewState | null {
  if (!isRecord(x)) return null;
  const state = x["state"];
  if (typeof state !== "string") return null;
  switch (state) {
    case "idle":
      return { state: "idle" };
    case "creating": {
      const rawPhase = x["rawPhase"];
      if (typeof rawPhase !== "string") return null;
      return { state: "creating", rawPhase };
    }
    case "running":
      return { state: "running" };
    case "sleeping":
      return { state: "sleeping" };
    case "failed": {
      const reason = x["reason"];
      if (typeof reason !== "string") return null;
      return { state: "failed", reason };
    }
    case "deleting":
    case "delete_stuck": {
      const attempts = x["attempts"];
      if (!isFiniteNumber(attempts)) return null;
      return { state, attempts };
    }
    case "unknown": {
      const reason = x["reason"];
      if (typeof reason !== "string") return null;
      return { state: "unknown", reason };
    }
    default:
      // Future server, older UI. Degrade, never crash: unknown disables the
      // button and polls fast, which is safe against any state we cannot read.
      return { state: "unknown", reason: `unrecognized state "${state}"` };
  }
}

/** Guard GET /api/status. null means "do not render from this body". */
export function parseStatusResponse(x: unknown): StatusResponse | null {
  if (!isRecord(x)) return null;
  const view = parseViewState(x["view"]);
  if (view === null) return null;
  const intent = x["intent"];
  if (intent !== "PRESENT" && intent !== "ABSENT" && intent !== null) return null;
  const observedAt = x["observedAt"];
  const version = x["version"];
  if (!isFiniteNumber(observedAt) || !isFiniteNumber(version)) return null;
  const bootId = x["bootId"];
  if (typeof bootId !== "string" || bootId === "") return null;
  const serviceId = x["serviceId"];
  if (typeof serviceId !== "string" && serviceId !== null) return null;
  return { view, intent, observedAt, version, bootId, serviceId };
}

/** Guard POST /api/up | /api/down bodies (200 and 409 share the shape). */
export function parseCommandResponse(x: unknown): CommandResponse | null {
  if (!isRecord(x)) return null;
  const outcome = x["outcome"];
  if (outcome !== "started" && outcome !== "coalesced" && outcome !== "conflict") return null;
  const view = parseViewState(x["view"]);
  if (view === null) return null;
  return { outcome, view };
}

function make(
  stateLabel: string,
  stateTone: StateTone,
  detail: string,
  buttonCommand: Command,
  buttonEnabled: boolean,
  pollMs: number,
  showSpinner: boolean,
): ViewModel {
  return {
    stateLabel,
    stateTone,
    detail,
    buttonLabel: buttonCommand === "up" ? "Spin up" : "Spin down",
    buttonCommand,
    buttonEnabled,
    pollMs,
    showSpinner,
  };
}

/**
 * ViewState -> ViewModel. Total over the union. The policy, in one table:
 *
 *   view          | button                 | poll  | spinner | detail
 *   --------------+------------------------+-------+---------+---------------------------
 *   idle          | Spin up, enabled       | 60s   | no      |
 *   creating      | Spin down, ENABLED     | 2s    | yes     | phase verbatim
 *   running       | Spin down, enabled     | 15s   | no      |
 *   sleeping      | Spin down, enabled     | 15s   | no      |
 *   failed        | Spin up, enabled       | 60s   | no      | reason
 *   deleting      | Spin down, disabled    | 2s    | yes     | attempts once retrying
 *   delete_stuck  | Spin down, disabled    | 2s    | yes     | delete failing, attempt N
 *   unknown       | Spin up, disabled      | 2s    | no      | reason
 *
 * Creating keeps its button enabled on purpose: cancelling a build saves
 * money. Deleting disables it because conflict is the only thing "up" can do
 * against teardown. Failed sits at the at-rest cadence: it does not change
 * until an operator acts.
 */
export function viewModelFromState(view: ViewState): ViewModel {
  switch (view.state) {
    case "idle":
      return make("Idle", "neutral", "", "up", true, POLL_AT_REST_MS, false);
    case "creating":
      return make("Creating", "active", view.rawPhase, "down", true, POLL_FAST_MS, true);
    case "running":
      return make("Running", "good", "", "down", true, POLL_SETTLED_MS, false);
    case "sleeping":
      return make("Sleeping", "neutral", "", "down", true, POLL_SETTLED_MS, false);
    case "failed":
      return make("Failed", "bad", view.reason, "up", true, POLL_AT_REST_MS, false);
    case "deleting":
      return make(
        "Deleting",
        "active",
        view.attempts > 0 ? `retrying, attempt ${view.attempts}` : "",
        "down",
        false,
        POLL_FAST_MS,
        true,
      );
    case "delete_stuck":
      return make(
        "Delete stuck",
        "warn",
        `delete failing, retrying - attempt ${view.attempts}`,
        "down",
        false,
        POLL_FAST_MS,
        true,
      );
    case "unknown":
      return make("Unknown", "warn", view.reason, "up", false, POLL_FAST_MS, false);
    default:
      return assertNever(view);
  }
}

/** StatusResponse -> ViewModel. The command path renders via viewModelFromState. */
export function toViewModel(status: StatusResponse): ViewModel {
  return viewModelFromState(status.view);
}

/**
 * When to poll next. null = do not schedule: a hidden tab spends zero quota,
 * and the visibilitychange handler restarts the loop on return.
 */
export function nextPollDelay(vm: ViewModel, documentHidden: boolean): number | null {
  return documentHidden ? null : vm.pollMs;
}

/**
 * The click-vs-stale-poll race: a status response can arrive AFTER a command
 * response that reflects a later world. Versions are monotonic on the server
 * WITHIN one process, so anything below the last accepted version is
 * discarded; equal versions pass (same observation, harmless re-render).
 * Versions restart at 1 when the controller redeploys, so a changed bootId
 * resets the floor entirely: without that, a long-lived tab would discard
 * every fresh observation after a redeploy (review finding).
 */
export function shouldAcceptVersion(
  last: { bootId: string; version: number } | null,
  incoming: { bootId: string; version: number },
): boolean {
  if (last === null || last.bootId !== incoming.bootId) return true;
  return incoming.version >= last.version;
}

/** Footer text. Clamped at zero so clock skew never reads "observed -3s ago". */
export function observedAgoText(observedAt: number, now: number): string {
  const seconds = Math.floor(Math.max(0, now - observedAt) / 1000);
  return `observed ${seconds}s ago`;
}
