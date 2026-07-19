// Transition table proofs. The EXPECTED_VIEW grid below IS the spec: every
// observation kind x every phase (13 known + unknown-wrapped + null) x every
// intent (PRESENT / ABSENT / none) has exactly one expected view, and the
// loops enumerate the full grid so nothing is asserted by accident or skipped.
import { describe, expect, it } from "vitest";
import {
  DELETE_STUCK_THRESHOLD,
  decide,
  deriveView,
  type Decision,
  type Intent,
  type Observation,
  type Phase,
  type Snapshot,
  type ViewState,
} from "../src/transitions.js";

const T = 1_000;
const V = 1;
const SID = "svc-1";

const PHASES: Phase[] = [
  "BUILDING",
  "CRASHED",
  "DEPLOYING",
  "FAILED",
  "INITIALIZING",
  "NEEDS_APPROVAL",
  "QUEUED",
  "REMOVED",
  "REMOVING",
  "SKIPPED",
  "SLEEPING",
  "SUCCESS",
  "WAITING",
];

const INTENTS: (Intent | null)[] = ["PRESENT", "ABSENT", null];

// --- observation builders -------------------------------------------------

function absent(): Observation {
  return { kind: "absent", observedAt: T, version: V };
}
function readFailed(): Observation {
  return { kind: "unknown", reason: "probe failed", observedAt: T, version: V };
}
function present(phase: Phase | { kind: "unknown"; raw: string } | null): Observation {
  return { kind: "present", serviceId: SID, phase, observedAt: T, version: V };
}
function snap(intent: Intent | null, observation: Observation, deleteAttempts = 0): Snapshot {
  return { intent, observation, deleteAttempts };
}

// --- view literals --------------------------------------------------------

const idle: ViewState = { state: "idle" };
const running: ViewState = { state: "running" };
const sleeping: ViewState = { state: "sleeping" };
function creating(rawPhase: string): ViewState {
  return { state: "creating", rawPhase };
}
function failed(reason: string): ViewState {
  return { state: "failed", reason };
}
function deleting(attempts: number): ViewState {
  return { state: "deleting", attempts };
}
function stuck(attempts: number): ViewState {
  return { state: "delete_stuck", attempts };
}
const unknownView: ViewState = { state: "unknown", reason: "probe failed" };

// --- the deriveView spec grid ---------------------------------------------
// One row per observation, one column per intent. Read it like a table.

type IntentColumns = { PRESENT: ViewState; ABSENT: ViewState; NONE: ViewState };

function everyIntent(view: ViewState): IntentColumns {
  return { PRESENT: view, ABSENT: view, NONE: view };
}

// Teardown intent dominates EVERY present observation (review finding: the
// previous grid canonized per-phase exceptions, which left a failed or
// building service showing a button that could change intent mid-teardown).
function presentRow(view: ViewState): IntentColumns {
  return { PRESENT: view, ABSENT: deleting(0), NONE: view };
}

const EXPECTED_VIEW: Record<string, IntentColumns> = {
  "read-failed": everyIntent(unknownView),
  "absent": { PRESENT: creating("REQUESTED"), ABSENT: idle, NONE: idle },
  "present:QUEUED": presentRow(creating("QUEUED")),
  "present:WAITING": presentRow(creating("WAITING")),
  "present:INITIALIZING": presentRow(creating("INITIALIZING")),
  "present:BUILDING": presentRow(creating("BUILDING")),
  "present:DEPLOYING": presentRow(creating("DEPLOYING")),
  "present:SUCCESS": presentRow(running),
  "present:SLEEPING": presentRow(sleeping),
  "present:FAILED": presentRow(failed("deployment FAILED")),
  "present:CRASHED": presentRow(failed("deployment CRASHED")),
  "present:REMOVING": everyIntent(deleting(0)),
  "present:REMOVED": everyIntent(deleting(0)),
  "present:NEEDS_APPROVAL": presentRow(failed("unexpected status NEEDS_APPROVAL for an image deploy")),
  "present:SKIPPED": presentRow(failed("unexpected status SKIPPED for an image deploy")),
  "present:unknown-raw": {
    PRESENT: failed("unrecognized status HIBERNATING"),
    ABSENT: deleting(0),
    NONE: failed("unrecognized status HIBERNATING"),
  },
  "present:no-deployment": presentRow(creating("PENDING")),
};

type ObsCase = { key: string; observation: Observation };

function buildObservationCases(): ObsCase[] {
  const cases: ObsCase[] = [];
  cases.push({ key: "read-failed", observation: readFailed() });
  cases.push({ key: "absent", observation: absent() });
  for (const phase of PHASES) {
    cases.push({ key: `present:${phase}`, observation: present(phase) });
  }
  cases.push({ key: "present:unknown-raw", observation: present({ kind: "unknown", raw: "HIBERNATING" }) });
  cases.push({ key: "present:no-deployment", observation: present(null) });
  return cases;
}

describe("deriveView: full observation x intent grid", () => {
  const observationCases = buildObservationCases();

  it("the spec grid covers every enumerated observation, exactly", () => {
    const enumerated = new Set<string>();
    for (const oc of observationCases) enumerated.add(oc.key);
    const specced = new Set<string>();
    for (const key of Object.keys(EXPECTED_VIEW)) specced.add(key);
    expect([...specced].sort()).toEqual([...enumerated].sort());
  });

  for (const oc of observationCases) {
    const columns = EXPECTED_VIEW[oc.key];
    if (columns === undefined) throw new Error(`no spec row for ${oc.key}`);
    for (const intent of INTENTS) {
      const expected = intent === null ? columns.NONE : columns[intent];
      it(`${oc.key} / intent ${intent ?? "none"} -> ${expected.state}`, () => {
        expect(deriveView(snap(intent, oc.observation))).toEqual(expected);
      });
    }
  }
});

describe("deriveView: named rules", () => {
  it("a failed read is NEVER idle: unknown in, unknown out, for every intent", () => {
    for (const intent of INTENTS) {
      const view = deriveView(snap(intent, readFailed()));
      expect(view.state).not.toBe("idle");
      expect(view).toEqual(unknownView);
    }
  });

  it("REMOVED while the service is still present is deleting, NOT idle", () => {
    for (const intent of INTENTS) {
      expect(deriveView(snap(intent, present("REMOVED")))).toEqual(deleting(0));
    }
  });

  it("intent ABSENT overrides SUCCESS: a healthy container we are tearing down shows deleting", () => {
    expect(deriveView(snap("ABSENT", present("SUCCESS")))).toEqual(deleting(0));
    expect(deriveView(snap("PRESENT", present("SUCCESS")))).toEqual(running);
  });

  it("deleting becomes delete_stuck at the attempt threshold, not before", () => {
    const deletingSnaps: Snapshot[] = [
      snap(null, present("REMOVING")),
      snap("ABSENT", present("REMOVED")),
      snap("ABSENT", present("SUCCESS")),
      snap("ABSENT", present({ kind: "unknown", raw: "HIBERNATING" })),
    ];
    for (const base of deletingSnaps) {
      for (let attempts = 0; attempts < DELETE_STUCK_THRESHOLD; attempts++) {
        const view = deriveView({ ...base, deleteAttempts: attempts });
        expect(view).toEqual(deleting(attempts));
      }
      for (let attempts = DELETE_STUCK_THRESHOLD; attempts < DELETE_STUCK_THRESHOLD + 2; attempts++) {
        const view = deriveView({ ...base, deleteAttempts: attempts });
        expect(view).toEqual(stuck(attempts));
      }
    }
  });

  it("attempt count does not touch non-deleting views", () => {
    expect(deriveView(snap("PRESENT", present("SUCCESS"), 9))).toEqual(running);
    expect(deriveView(snap("PRESENT", present("BUILDING"), 9))).toEqual(creating("BUILDING"));
  });
});

// --- the decide spec table ------------------------------------------------
// One row per reachable view, both commands as columns. Every ViewState
// variant appears at least once; the coverage test below proves it.

type DecideRow = { name: string; snapshot: Snapshot; up: Decision; down: Decision };

const DECIDE_ROWS: DecideRow[] = [
  {
    name: "idle: up creates, down coalesces (already down)",
    snapshot: snap("ABSENT", absent()),
    up: { action: "create" },
    down: { action: "coalesce", view: idle },
  },
  {
    name: "creating (service visible): up coalesces, down cancels with a delete",
    snapshot: snap("PRESENT", present("QUEUED")),
    up: { action: "coalesce", view: creating("QUEUED") },
    down: { action: "delete", serviceId: SID },
  },
  {
    name: "creating (intent only, nothing visible yet): up coalesces, down RECORDS absent",
    snapshot: snap("PRESENT", absent()),
    up: { action: "coalesce", view: creating("REQUESTED") },
    down: { action: "record-absent", view: creating("REQUESTED") },
  },
  {
    name: "running: up coalesces, down deletes",
    snapshot: snap("PRESENT", present("SUCCESS")),
    up: { action: "coalesce", view: running },
    down: { action: "delete", serviceId: SID },
  },
  {
    name: "sleeping: up coalesces, down deletes",
    snapshot: snap("PRESENT", present("SLEEPING")),
    up: { action: "coalesce", view: sleeping },
    down: { action: "delete", serviceId: SID },
  },
  {
    name: "failed: up recreates, down deletes (cancel saves money)",
    snapshot: snap("PRESENT", present("CRASHED")),
    up: { action: "create" },
    down: { action: "delete", serviceId: SID },
  },
  {
    name: "failed on an unknown phase: up recreates, down deletes",
    snapshot: snap("PRESENT", present({ kind: "unknown", raw: "HIBERNATING" })),
    up: { action: "create" },
    down: { action: "delete", serviceId: SID },
  },
  {
    name: "deleting: up is the 409, down coalesces (already going down)",
    snapshot: snap("ABSENT", present("REMOVING"), 1),
    up: { action: "conflict", view: deleting(1) },
    down: { action: "coalesce", view: deleting(1) },
  },
  {
    name: "delete_stuck: up is the 409, down coalesces (still fighting)",
    snapshot: snap("ABSENT", present("REMOVING"), DELETE_STUCK_THRESHOLD),
    up: { action: "conflict", view: stuck(DELETE_STUCK_THRESHOLD) },
    down: { action: "coalesce", view: stuck(DELETE_STUCK_THRESHOLD) },
  },
  {
    name: "unknown, no serviceId known: both commands conflict (cannot act on what we cannot see)",
    snapshot: snap("PRESENT", readFailed()),
    up: { action: "conflict", view: unknownView },
    down: { action: "conflict", view: unknownView },
  },
];

describe("decide: full view x command table", () => {
  it("the table reaches every ViewState variant", () => {
    const covered = new Set<string>();
    for (const row of DECIDE_ROWS) covered.add(deriveView(row.snapshot).state);
    const all = ["idle", "creating", "running", "sleeping", "failed", "deleting", "delete_stuck", "unknown"];
    expect([...covered].sort()).toEqual([...all].sort());
  });

  for (const row of DECIDE_ROWS) {
    it(`${row.name} [up]`, () => {
      expect(decide("up", row.snapshot)).toEqual(row.up);
    });
    it(`${row.name} [down]`, () => {
      expect(decide("down", row.snapshot)).toEqual(row.down);
    });
  }
});
