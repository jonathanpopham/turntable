// Delete-loop proofs, all offline and all instant: observations come from a
// scripted stub, sleeps are recorded instead of waited, and jitter is pinned.
// The properties under test: observed absence is the only success, delete
// re-fires only while the service is still observed present, and the loop
// outlives any number of failed delete calls.
import { describe, expect, it } from "vitest";
import { DELETE_BACKOFF_CAP_MS, runDeleteLoop } from "../src/delete-loop.js";
import type { DeleteLoopDeps } from "../src/delete-loop.js";
import { RailwayApiError } from "../src/gql-request.js";
import type { Observation } from "../src/transitions.js";

const SERVICE_ID = "svc-managed";

function presentObs(version: number): Observation {
  return { kind: "present", serviceId: SERVICE_ID, phase: "SUCCESS", observedAt: version, version };
}

function absentObs(version: number): Observation {
  return { kind: "absent", observedAt: version, version };
}

function unknownObs(version: number): Observation {
  return { kind: "unknown", reason: "GqlTimeoutError: read timed out", observedAt: version, version };
}

interface Recorded {
  deleteCalls: number;
  observeCalls: number;
  sleeps: number[];
  updates: number[];
}

/**
 * Harness: observations play back in order (the script must cover every poll
 * the test expects; running past the end is a harness bug and throws).
 */
function makeHarness(
  script: Observation[],
  opts: {
    deleteImpl?: () => Promise<boolean>;
    shouldContinue?: () => boolean;
    random?: () => number;
  } = {},
): { deps: DeleteLoopDeps; rec: Recorded } {
  const rec: Recorded = { deleteCalls: 0, observeCalls: 0, sleeps: [], updates: [] };
  const deps: DeleteLoopDeps = {
    config: { endpoint: "http://fake.local/graphql", token: "tok-irrelevant" },
    target: { projectId: "proj-1", environmentId: "env-1" },
    deleteService: async () => {
      rec.deleteCalls += 1;
      if (opts.deleteImpl !== undefined) return await opts.deleteImpl();
      return true;
    },
    observe: async () => {
      const obs = script[rec.observeCalls];
      rec.observeCalls += 1;
      if (obs === undefined) throw new Error("observation script exhausted");
      return obs;
    },
    sleep: async (ms: number) => {
      rec.sleeps.push(ms); // recorded, never waited: tests run in zero time
    },
    random: opts.random ?? (() => 0),
    shouldContinue: opts.shouldContinue ?? (() => true),
  };
  return { deps, rec };
}

function collectUpdates(rec: Recorded): (attempts: number) => void {
  return (attempts) => {
    rec.updates.push(attempts);
  };
}

describe("runDeleteLoop", () => {
  it("happy path: one delete, next observation absent, done without sleeping", async () => {
    const { deps, rec } = makeHarness([absentObs(1)]);
    await runDeleteLoop(deps, SERVICE_ID, collectUpdates(rec));
    expect(rec.deleteCalls).toBe(1);
    expect(rec.observeCalls).toBe(1);
    expect(rec.updates).toEqual([]);
    expect(rec.sleeps).toEqual([]);
  });

  it("accepted but visible for 3 polls: re-fires the delete on every poll that still shows present", async () => {
    const { deps, rec } = makeHarness([presentObs(1), presentObs(2), presentObs(3), absentObs(4)]);
    await runDeleteLoop(deps, SERVICE_ID, collectUpdates(rec));
    // Present at the top of four passes, so the delete fired four times...
    expect(rec.deleteCalls).toBe(4);
    // ...and each present observation bumped attempts exactly once.
    expect(rec.updates).toEqual([1, 2, 3]);
    expect(rec.sleeps.length).toBe(3);
  });

  it("does NOT re-fire the delete after an unknown observation, only after present", async () => {
    const { deps, rec } = makeHarness([presentObs(1), unknownObs(2), presentObs(3), absentObs(4)]);
    await runDeleteLoop(deps, SERVICE_ID, collectUpdates(rec));
    // Four polls, but the pass following the unknown observation held fire:
    // pass 1 (entered present), pass 2 (observed present), pass 4 (observed
    // present again). Pass 3 followed unknown and only re-observed.
    expect(rec.observeCalls).toBe(4);
    expect(rec.deleteCalls).toBe(3);
    // Unknown never increments attempts: only present observations count.
    expect(rec.updates).toEqual([1, 2]);
  });

  it("delete throws but the next observation is absent: success without a second delete", async () => {
    const { deps, rec } = makeHarness([absentObs(1)], {
      deleteImpl: async () => {
        // The ambiguity case: a timed-out delete may still have applied.
        throw new RailwayApiError("delete failed before a response arrived", { retryable: true });
      },
    });
    await runDeleteLoop(deps, SERVICE_ID, collectUpdates(rec));
    expect(rec.deleteCalls).toBe(1);
    expect(rec.updates).toEqual([]);
  });

  it("delete failing forever: attempts climb past 5, backoff caps at 30s, the loop never gives up", async () => {
    const script: Observation[] = [];
    for (let i = 1; i <= 8; i += 1) script.push(presentObs(i));
    script.push(absentObs(9));
    const { deps, rec } = makeHarness(script, {
      deleteImpl: async () => {
        throw new RailwayApiError("Railway returned HTTP 500", { status: 500, retryable: true });
      },
    });
    await runDeleteLoop(deps, SERVICE_ID, collectUpdates(rec));
    // Rising attempts, well past the delete_stuck threshold, still fighting.
    expect(rec.updates).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(rec.deleteCalls).toBe(9);
    // Deterministic backoff (jitter pinned to 0): doubles then caps at 30s.
    expect(rec.sleeps).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000]);
    for (const ms of rec.sleeps) {
      expect(ms).toBeLessThanOrEqual(DELETE_BACKOFF_CAP_MS);
    }
  });

  it("jitter never pushes a delay past the 30s cap", async () => {
    const script: Observation[] = [];
    for (let i = 1; i <= 7; i += 1) script.push(presentObs(i));
    script.push(absentObs(8));
    // Worst-case jitter: random pinned just under 1.
    const { deps, rec } = makeHarness(script, { random: () => 0.999999 });
    await runDeleteLoop(deps, SERVICE_ID, collectUpdates(rec));
    for (const ms of rec.sleeps) {
      expect(ms).toBeLessThanOrEqual(DELETE_BACKOFF_CAP_MS);
    }
  });

  it("shouldContinue false mid-flight: exits promptly without sleeping again", async () => {
    let keepGoing = true;
    const { deps, rec } = makeHarness([presentObs(1), presentObs(2)], {
      shouldContinue: () => keepGoing,
    });
    await runDeleteLoop(deps, SERVICE_ID, (attempts) => {
      rec.updates.push(attempts);
      keepGoing = false; // shutdown lands while a pass is in progress
    });
    // One full pass ran, then the loop noticed shutdown before the backoff sleep.
    expect(rec.deleteCalls).toBe(1);
    expect(rec.updates).toEqual([1]);
    expect(rec.sleeps).toEqual([]);
  });

  it("shouldContinue false from the start: exits before any mutation", async () => {
    const { deps, rec } = makeHarness([], { shouldContinue: () => false });
    await runDeleteLoop(deps, SERVICE_ID, collectUpdates(rec));
    expect(rec.deleteCalls).toBe(0);
    expect(rec.observeCalls).toBe(0);
  });
});
