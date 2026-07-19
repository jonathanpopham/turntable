// View-model proofs, offline. The VM_GRID below IS the spec for the UI: every
// ViewState variant maps to exactly one render decision (label, tone, detail,
// button, cadence, spinner), and the loop asserts the full grid so nothing is
// checked by accident or skipped. Guard tests mirror the server's posture:
// wire data is untrusted, and an unrecognized future state degrades instead
// of crashing.
import { describe, expect, it } from "vitest";
import type { ViewState } from "../src/transitions.js";
import {
  POLL_AT_REST_MS,
  POLL_FAST_MS,
  POLL_SETTLED_MS,
  nextPollDelay,
  observedAgoText,
  parseCommandResponse,
  parseStatusResponse,
  shouldAcceptVersion,
  toViewModel,
  viewModelFromState,
  type StatusResponse,
  type ViewModel,
} from "../src/view-model.js";

function status(view: ViewState): StatusResponse {
  return { view, intent: null, observedAt: 1_000, version: 1, bootId: "boot-a", serviceId: null };
}

// --- the render grid: one row per ViewState variant -----------------------

type GridRow = { name: string; view: ViewState; expected: ViewModel };

const VM_GRID: GridRow[] = [
  {
    name: "idle",
    view: { state: "idle" },
    expected: {
      stateLabel: "Idle",
      stateTone: "neutral",
      detail: "",
      buttonLabel: "Spin up",
      buttonCommand: "up",
      buttonEnabled: true,
      pollMs: POLL_AT_REST_MS,
      showSpinner: false,
    },
  },
  {
    name: "creating shows the phase verbatim and keeps cancel enabled",
    view: { state: "creating", rawPhase: "BUILDING" },
    expected: {
      stateLabel: "Creating",
      stateTone: "active",
      detail: "BUILDING",
      buttonLabel: "Spin down",
      buttonCommand: "down",
      buttonEnabled: true,
      pollMs: POLL_FAST_MS,
      showSpinner: true,
    },
  },
  {
    name: "running",
    view: { state: "running" },
    expected: {
      stateLabel: "Running",
      stateTone: "good",
      detail: "",
      buttonLabel: "Spin down",
      buttonCommand: "down",
      buttonEnabled: true,
      pollMs: POLL_SETTLED_MS,
      showSpinner: false,
    },
  },
  {
    name: "sleeping",
    view: { state: "sleeping" },
    expected: {
      stateLabel: "Sleeping",
      stateTone: "neutral",
      detail: "",
      buttonLabel: "Spin down",
      buttonCommand: "down",
      buttonEnabled: true,
      pollMs: POLL_SETTLED_MS,
      showSpinner: false,
    },
  },
  {
    name: "failed surfaces the reason and offers Spin up",
    view: { state: "failed", reason: "deployment CRASHED" },
    expected: {
      stateLabel: "Failed",
      stateTone: "bad",
      detail: "deployment CRASHED",
      buttonLabel: "Spin up",
      buttonCommand: "up",
      buttonEnabled: true,
      pollMs: POLL_AT_REST_MS,
      showSpinner: false,
    },
  },
  {
    name: "deleting at attempt 0 stays quiet",
    view: { state: "deleting", attempts: 0 },
    expected: {
      stateLabel: "Deleting",
      stateTone: "active",
      detail: "",
      buttonLabel: "Spin down",
      buttonCommand: "down",
      buttonEnabled: false,
      pollMs: POLL_FAST_MS,
      showSpinner: true,
    },
  },
  {
    name: "deleting with retries surfaces the attempt count",
    view: { state: "deleting", attempts: 3 },
    expected: {
      stateLabel: "Deleting",
      stateTone: "active",
      detail: "retrying, attempt 3",
      buttonLabel: "Spin down",
      buttonCommand: "down",
      buttonEnabled: false,
      pollMs: POLL_FAST_MS,
      showSpinner: true,
    },
  },
  {
    name: "delete_stuck names the fight",
    view: { state: "delete_stuck", attempts: 7 },
    expected: {
      stateLabel: "Delete stuck",
      stateTone: "warn",
      detail: "delete failing, retrying - attempt 7",
      buttonLabel: "Spin down",
      buttonCommand: "down",
      buttonEnabled: false,
      pollMs: POLL_FAST_MS,
      showSpinner: true,
    },
  },
  {
    name: "unknown disables the button and polls fast",
    view: { state: "unknown", reason: "probe failed" },
    expected: {
      stateLabel: "Unknown",
      stateTone: "warn",
      detail: "probe failed",
      buttonLabel: "Spin up",
      buttonCommand: "up",
      buttonEnabled: false,
      pollMs: POLL_FAST_MS,
      showSpinner: false,
    },
  },
];

describe("toViewModel", () => {
  for (const row of VM_GRID) {
    it(row.name, () => {
      expect(toViewModel(status(row.view))).toEqual(row.expected);
    });
  }

  it("agrees with viewModelFromState for every variant", () => {
    for (const row of VM_GRID) {
      expect(viewModelFromState(row.view)).toEqual(toViewModel(status(row.view)));
    }
  });
});

// --- parseStatusResponse ---------------------------------------------------

describe("parseStatusResponse", () => {
  it("accepts every known view variant round-trip", () => {
    for (const row of VM_GRID) {
      const wire: unknown = JSON.parse(
        JSON.stringify({ view: row.view, intent: "PRESENT", observedAt: 5, version: 2, bootId: "b", serviceId: null }),
      );
      expect(parseStatusResponse(wire)).toEqual({
        view: row.view,
        intent: "PRESENT",
        observedAt: 5,
        version: 2,
        bootId: "b",
        serviceId: null,
      });
    }
  });

  it("accepts null and ABSENT intents", () => {
    const base = { view: { state: "idle" }, observedAt: 1, version: 1, bootId: "b", serviceId: null };
    expect(parseStatusResponse({ ...base, intent: null })?.intent).toBeNull();
    expect(parseStatusResponse({ ...base, intent: "ABSENT" })?.intent).toBe("ABSENT");
  });

  it("degrades a future unknown state value instead of rejecting", () => {
    const parsed = parseStatusResponse({
      view: { state: "hibernating", depth: 3 },
      intent: null,
      observedAt: 1,
      version: 1,
      bootId: "b",
      serviceId: null,
    });
    expect(parsed).not.toBeNull();
    expect(parsed?.view).toEqual({ state: "unknown", reason: 'unrecognized state "hibernating"' });
    // And the degraded view still renders safely: disabled button, fast poll.
    const vm = toViewModel(parsed as StatusResponse);
    expect(vm.buttonEnabled).toBe(false);
    expect(vm.pollMs).toBe(POLL_FAST_MS);
    expect(vm.detail).toBe('unrecognized state "hibernating"');
  });

  it("rejects malformed shapes", () => {
    const good = { view: { state: "idle" }, intent: null, observedAt: 1, version: 1, bootId: "b", serviceId: null };
    const bad: unknown[] = [
      null,
      undefined,
      42,
      "idle",
      [],
      {},
      { ...good, view: null },
      { ...good, view: "idle" },
      { ...good, view: { state: 7 } },
      { ...good, view: { state: "creating" } }, // rawPhase missing
      { ...good, view: { state: "creating", rawPhase: 9 } },
      { ...good, view: { state: "failed" } }, // reason missing
      { ...good, view: { state: "deleting" } }, // attempts missing
      { ...good, view: { state: "deleting", attempts: "3" } },
      { ...good, view: { state: "delete_stuck", attempts: Number.NaN } },
      { ...good, view: { state: "unknown" } }, // reason missing
      { ...good, intent: "MAYBE" },
      { ...good, intent: undefined },
      { ...good, observedAt: "now" },
      { ...good, observedAt: Number.POSITIVE_INFINITY },
      { ...good, version: null },
      { view: { state: "idle" }, intent: null, observedAt: 1 }, // version missing
    ];
    for (const body of bad) {
      expect(parseStatusResponse(body)).toBeNull();
    }
  });
});

// --- parseCommandResponse --------------------------------------------------

describe("parseCommandResponse", () => {
  it("accepts all three outcomes", () => {
    const outcomes = ["started", "coalesced", "conflict"] as const;
    for (const outcome of outcomes) {
      expect(parseCommandResponse({ outcome, view: { state: "running" } })).toEqual({
        outcome,
        view: { state: "running" },
      });
    }
  });

  it("degrades a future view state inside a command response too", () => {
    const parsed = parseCommandResponse({ outcome: "started", view: { state: "warping" } });
    expect(parsed?.view.state).toBe("unknown");
  });

  it("rejects malformed shapes", () => {
    const bad: unknown[] = [
      null,
      {},
      { outcome: "exploded", view: { state: "idle" } },
      { outcome: "started" },
      { outcome: "started", view: { state: "creating" } }, // rawPhase missing
      { view: { state: "idle" } },
    ];
    for (const body of bad) {
      expect(parseCommandResponse(body)).toBeNull();
    }
  });
});

// --- nextPollDelay ---------------------------------------------------------

describe("nextPollDelay", () => {
  it("returns null for a hidden tab regardless of state", () => {
    for (const row of VM_GRID) {
      expect(nextPollDelay(row.expected, true)).toBeNull();
    }
  });

  it("returns the view model cadence when visible", () => {
    for (const row of VM_GRID) {
      expect(nextPollDelay(row.expected, false)).toBe(row.expected.pollMs);
    }
  });
});

// --- shouldAcceptVersion (the click-vs-stale-poll race) --------------------

describe("shouldAcceptVersion", () => {
  const v = (bootId: string, version: number) => ({ bootId, version });

  it("accepts anything before a first version is seen", () => {
    expect(shouldAcceptVersion(null, v("a", 0))).toBe(true);
    expect(shouldAcceptVersion(null, v("a", 99))).toBe(true);
  });

  it("accepts equal and newer, discards older, within one boot", () => {
    expect(shouldAcceptVersion(v("a", 5), v("a", 6))).toBe(true);
    expect(shouldAcceptVersion(v("a", 5), v("a", 5))).toBe(true);
    expect(shouldAcceptVersion(v("a", 5), v("a", 4))).toBe(false);
  });

  it("a changed bootId resets the floor: v1 after a redeploy is accepted", () => {
    // Review finding: versions restart per process; a long-lived tab must not
    // discard fresh observations after the controller redeploys.
    expect(shouldAcceptVersion(v("a", 68), v("b", 1))).toBe(true);
  });
});

// --- observedAgoText -------------------------------------------------------

describe("observedAgoText", () => {
  it("floors to whole seconds", () => {
    expect(observedAgoText(1_000, 4_999)).toBe("observed 3s ago");
    expect(observedAgoText(1_000, 1_000)).toBe("observed 0s ago");
  });

  it("clamps clock skew at zero", () => {
    expect(observedAgoText(10_000, 8_000)).toBe("observed 0s ago");
  });
});
