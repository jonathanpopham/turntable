// Hardening proofs: the real Engine composed with the real operations.ts
// client, pointed at the in-process fake Railway, with a real IntentStore on a
// throwaway state directory. Every test here is the evidence behind a row of
// the README "Decisions" table: restart survival (State, Teardown), delete
// semantics (Teardown), never-blind reads (State, Mutations), command
// discipline (Concurrency), the auth boundary (Auth), and observation hygiene
// (State). Where the HTTP boundary is the guarantee, the engine sits behind a
// real createApp server on an ephemeral port and is driven with fetch.
//
// Determinism: injected clock (advanced past the 2s status-cache TTL between
// polls), zero jitter, instant gql retry sleeps, and a GATED delete-loop sleep.
// The gate matters: the loop re-fires delete while the service is observed
// present, and the fake restarts its deletion countdown on every accepted
// delete, so a free-spinning loop would livelock. Parking the loop in its
// backoff sleep makes each pass observable and every teardown test exact.
//
// Style: explicit loops over array-method chains; single pass, zero
// intermediate allocations (see README "Decisions").

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Engine } from "../src/engine.js";
import type { EngineDeps, StatusResult } from "../src/engine.js";
import { createApp } from "../src/server.js";
import type { GqlConfig, GqlRequestDeps } from "../src/gql-request.js";
import { isRecord } from "../src/gql-guards.js";
import { IntentStore } from "../src/intent-store.js";
import {
  MANAGED_SERVICE_NAME,
  createService,
  deleteService,
  deployService,
  getProjectServices,
} from "../src/operations.js";
import type { Target } from "../src/operations.js";
import type { ResumeAction } from "../src/reconciler.js";
import { DELETE_STUCK_THRESHOLD } from "../src/transitions.js";
import { startFakeRailway } from "./fake-railway.js";
import type { FakeOp, FakeRailway, FakeService } from "./fake-railway.js";

const TOKEN = "fake-project-token";
const PASSWORD = "correct-horse-battery-staple";
const TARGET: Target = { projectId: "proj-int", environmentId: "env-int" };
// Mirrors STATUS_TTL_MS in src/engine.ts: advancing past it forces a real poll.
const CACHE_TTL_MS = 2_000;

// Instant sleep and zero jitter for the transport's read retries.
const fastDeps: GqlRequestDeps = {
  sleep: (): Promise<void> => Promise.resolve(),
  random: (): number => 0,
};

function realDelay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * The delete loop's sleep, controllable: each backoff parks the loop until the
 * test releases it, so passes are counted exactly and mid-fight state can be
 * inspected without racing the loop.
 */
class SleepGate {
  #parked: Array<() => void> = [];

  readonly sleep = (_ms: number): Promise<void> =>
    new Promise<void>((resolve) => {
      this.#parked.push(resolve);
    });

  /** Let every parked sleeper run one more pass. No-op when none are parked. */
  release(): void {
    const parked = this.#parked;
    this.#parked = [];
    for (const resolve of parked) resolve();
  }

  /** Resolves once the loop has finished a pass and parked in its backoff. */
  async whenParked(timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.#parked.length === 0) {
      if (Date.now() > deadline) {
        throw new Error("delete loop never parked in its backoff sleep");
      }
      await realDelay(2);
    }
  }
}

interface Harness {
  fake: FakeRailway;
  config: GqlConfig;
  stateDir: string;
  now: { ms: number };
}

interface Booted {
  engine: Engine;
  gate: SleepGate;
  resumed: ResumeAction;
  warns: Array<Record<string, unknown>>;
}

const harnesses: Harness[] = [];
const booted: Booted[] = [];

afterEach(async () => {
  for (const b of booted) {
    b.engine.stop();
    b.gate.release();
  }
  booted.length = 0;
  // Let stopped delete loops finish any in-flight pass before the fake closes.
  await realDelay(10);
  const cleanups: Promise<void>[] = [];
  for (const h of harnesses) {
    cleanups.push(h.fake.close());
    cleanups.push(rm(h.stateDir, { recursive: true, force: true }));
  }
  harnesses.length = 0;
  await Promise.all(cleanups);
});

async function makeHarness(): Promise<Harness> {
  const [fake, stateDir] = await Promise.all([
    startFakeRailway(),
    mkdtemp(join(tmpdir(), "roundhouse-state-")),
  ]);
  const h: Harness = {
    fake,
    stateDir,
    now: { ms: 0 },
    config: { endpoint: fake.url, token: TOKEN, auth: "project", timeoutMs: 1_000 },
  };
  harnesses.push(h);
  return h;
}

/** Real Engine.boot on the harness's state dir and fake, with a fresh gate. */
async function makeEngine(h: Harness): Promise<Booted> {
  const gate = new SleepGate();
  const warns: Array<Record<string, unknown>> = [];
  const deps: EngineDeps = {
    config: h.config,
    target: TARGET,
    ops: {
      createService: (config, target) => createService(config, target, fastDeps),
      deployService: (config, target, serviceId) =>
        deployService(config, target, serviceId, fastDeps),
      deleteService: (config, target, serviceId) =>
        deleteService(config, target, serviceId, fastDeps),
      getProjectServices: (config, target) => getProjectServices(config, target, fastDeps),
    },
    intentStore: new IntentStore(h.stateDir),
    clock: () => h.now.ms,
    sleep: gate.sleep,
    random: () => 0,
    warn: (event) => {
      warns.push(event);
    },
  };
  const { engine, resumed } = await Engine.boot(deps);
  const b: Booted = { engine, gate, resumed, warns };
  booted.push(b);
  return b;
}

function advance(h: Harness, ms = CACHE_TTL_MS + 1): void {
  h.now.ms += ms;
}

/** Advance past the cache TTL, then take one real status poll. */
async function pollView(h: Harness, b: Booted): Promise<StatusResult> {
  advance(h);
  return b.engine.status();
}

async function untilView(h: Harness, b: Booted, want: string, maxPolls = 15): Promise<StatusResult> {
  let last = "(none)";
  for (let i = 0; i < maxPolls; i += 1) {
    const s = await pollView(h, b);
    if (s.view.state === want) return s;
    last = s.view.state;
    await realDelay(2); // give background loops a beat between polls
  }
  throw new Error(`view never reached ${want} within ${String(maxPolls)} polls; last saw ${last}`);
}

async function reachRunning(h: Harness, b: Booted): Promise<void> {
  const result = await b.engine.up();
  expect(result.outcome).toBe("started");
  await untilView(h, b, "running");
}

function countOps(h: Harness, op: FakeOp): number {
  let n = 0;
  for (const entry of h.fake.handle.requests) {
    if (entry.op === op) n += 1;
  }
  return n;
}

function mutationCount(h: Harness): number {
  return (
    countOps(h, "serviceCreate") + countOps(h, "serviceInstanceDeploy") + countOps(h, "serviceDelete")
  );
}

function managedInFake(h: Harness): FakeService | undefined {
  return h.fake.state.getService(TARGET.projectId, MANAGED_SERVICE_NAME);
}

function bearerAuth(password: string): Record<string, string> {
  return { authorization: `Bearer ${password}` };
}

function outcomeOf(body: unknown): string {
  if (isRecord(body) && typeof body["outcome"] === "string") return body["outcome"];
  throw new Error(`response body had no outcome: ${JSON.stringify(body)}`);
}

/** Wrap the real engine in the real HTTP shell on an ephemeral loopback port. */
async function withApp(engine: Engine, fn: (base: string) => Promise<void>): Promise<void> {
  const server = createApp(engine, {
    password: PASSWORD,
    publicDir: "/nonexistent-roundhouse-public", // static routes are not under test here
    log: () => {},
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected a TCP listen address");
  }
  try {
    await fn(`http://127.0.0.1:${String(address.port)}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((e) => {
        if (e === undefined) resolve();
        else reject(e);
      });
    });
  }
}

describe("restart survival (Decisions: State, Teardown - durable intent survives process death)", () => {
  it("a create applied but its response lost survives process death: reboot resumes toward PRESENT and reaches running without a second create", async () => {
    const h = await makeHarness();
    const a = await makeEngine(h);
    expect(a.resumed).toBe("none");
    const s0 = await a.engine.status(); // primes the cache with observed absence
    expect(s0.view.state).toBe("idle");
    // The create's side effect lands upstream but the response is dropped, and
    // the recovery read is down too: engine A dies inside the ambiguity.
    h.fake.handle.failNext("serviceCreate", "drop-after-effect");
    for (let i = 0; i < 3; i += 1) {
      h.fake.handle.failNext("projectServices", "http500"); // all three read attempts fail
    }
    await expect(a.engine.up()).rejects.toThrow(/after effect applied/);
    a.engine.stop(); // process death
    expect(managedInFake(h)).toBeDefined(); // the side effect really applied
    expect(countOps(h, "serviceInstanceDeploy")).toBe(0); // died before the deploy trigger

    // Fresh process, SAME state dir, same Railway: durable PRESENT intent plus
    // one observation resumes the create where it died.
    const b = await makeEngine(h);
    expect(b.resumed).toBe("trigger-deploy");
    const status = await untilView(h, b, "running");
    expect(status.intent).toBe("PRESENT");
    expect(countOps(h, "serviceCreate")).toBe(1); // reconciled by observing, never re-fired
    expect(h.fake.state.listServices(TARGET.projectId).length).toBe(1);
  });

  it("a failed delete survives process death: the no-leak fight resumes on reboot and reaches observed absence once the API recovers", async () => {
    const h = await makeHarness();
    const a = await makeEngine(h);
    await reachRunning(h, a);
    h.fake.handle.setDeleteDelay(0); // once accepted, absence is observable on the next poll
    h.fake.handle.failDeleteTimes(3);
    const down = await a.engine.down();
    expect(down.outcome).toBe("started");
    await a.gate.whenParked(); // pass 1: delete rejected upstream, service still present
    expect(countOps(h, "serviceDelete")).toBe(1);
    a.engine.stop(); // process death mid-fight, service leaked for now
    a.gate.release();
    expect(managedInFake(h)).toBeDefined();

    // Fresh process, same state dir: durable ABSENT intent resumes the delete.
    const b = await makeEngine(h);
    expect(b.resumed).toBe("resume-delete");
    for (let pass = 0; pass < 2; pass += 1) {
      await b.gate.whenParked(); // two more rejected deletes, one per released pass
      b.gate.release();
    }
    // The fourth delete is accepted and the loop's own observation sees absence.
    await untilView(h, b, "idle");
    expect(managedInFake(h)).toBeUndefined();
    expect(countOps(h, "serviceDelete")).toBe(4); // 1 before death + 2 rejected + 1 accepted
  });

  it("a delete accepted but incomplete at process death is reconciled on reboot: resume-delete reaches absence without a duplicate delete storm", async () => {
    const h = await makeHarness();
    const a = await makeEngine(h);
    await reachRunning(h, a);
    h.fake.handle.setDeleteDelay(4); // deletion stays visibly in progress across the restart
    const down = await a.engine.down();
    expect(down.outcome).toBe("started");
    await a.gate.whenParked(); // delete accepted upstream, completion still pending
    expect(countOps(h, "serviceDelete")).toBe(1);
    expect(managedInFake(h)).toBeDefined(); // acceptance was not completion
    a.engine.stop(); // process death with teardown unfinished
    a.gate.release();

    const b = await makeEngine(h);
    expect(b.resumed).toBe("resume-delete");
    // One re-fire while the service is still observed present is allowed...
    await b.gate.whenParked();
    expect(countOps(h, "serviceDelete")).toBe(2);
    // ...and with the loop parked, status polls alone walk the still-visible
    // window down to absence: deleting the whole way, idle only at the end.
    const views: string[] = [];
    for (let i = 0; i < 8; i += 1) {
      const s = await pollView(h, b);
      views.push(s.view.state);
      if (s.view.state === "idle") break;
    }
    expect(views[views.length - 1]).toBe("idle");
    for (let i = 0; i < views.length - 1; i += 1) {
      expect(views[i]).toBe("deleting");
    }
    expect(managedInFake(h)).toBeUndefined();
    // No delete fired at or after observed absence: the count froze at two.
    b.engine.stop();
    b.gate.release();
    await realDelay(15);
    expect(countOps(h, "serviceDelete")).toBe(2);
  });
});

describe("delete semantics (Decisions: Teardown - acceptance is not completion)", () => {
  it("an accepted delete with the service still visible stays deleting every poll and turns idle only at observed absence", async () => {
    const h = await makeHarness();
    const b = await makeEngine(h);
    await reachRunning(h, b);
    h.fake.handle.setDeleteDelay(3); // the accepted delete stays visible for 3 status polls
    const down = await b.engine.down();
    expect(down.outcome).toBe("started");
    expect(down.view.state).toBe("deleting"); // acknowledged as teardown, never idle
    await b.gate.whenParked();
    let deletingPolls = 0;
    for (let i = 0; i < 8; i += 1) {
      const s = await pollView(h, b);
      if (s.view.state === "idle") {
        expect(managedInFake(h)).toBeUndefined(); // idle was earned by absence
        break;
      }
      expect(s.view.state).toBe("deleting"); // still visible means still deleting
      expect(managedInFake(h)).toBeDefined();
      deletingPolls += 1;
    }
    expect(deletingPolls).toBeGreaterThanOrEqual(1); // the visibility window was really crossed
    expect(managedInFake(h)).toBeUndefined();
  });

  it("a lost delete response is reconciled, not re-fired: exactly one delete request reaches the wire and idle follows observed absence", async () => {
    const h = await makeHarness();
    const b = await makeEngine(h);
    await reachRunning(h, b);
    h.fake.handle.setDeleteDelay(0);
    h.fake.handle.failNext("serviceDelete", "drop-after-effect"); // effect lands, response lost
    const down = await b.engine.down();
    expect(down.outcome).toBe("started");
    await untilView(h, b, "idle");
    expect(managedInFake(h)).toBeUndefined();
    expect(countOps(h, "serviceDelete")).toBe(1); // observation, not a blind retry, settled it
    await realDelay(15);
    expect(countOps(h, "serviceDelete")).toBe(1);
  });

  it("a delete that fails forever surfaces as delete_stuck with the attempt count while the loop keeps fighting", async () => {
    const h = await makeHarness();
    const b = await makeEngine(h);
    await reachRunning(h, b);
    h.fake.handle.failDeleteForever();
    const down = await b.engine.down();
    expect(down.outcome).toBe("started");
    const passes = DELETE_STUCK_THRESHOLD + 2;
    for (let pass = 1; pass <= passes; pass += 1) {
      await b.gate.whenParked();
      expect(countOps(h, "serviceDelete")).toBe(pass); // still trying: exactly one per pass
      const view = (await pollView(h, b)).view;
      // At the threshold the same fight is renamed honestly, attempts surfaced.
      expect(view.state).toBe(pass >= DELETE_STUCK_THRESHOLD ? "delete_stuck" : "deleting");
      if (view.state === "deleting" || view.state === "delete_stuck") {
        expect(view.attempts).toBe(pass);
      }
      b.gate.release();
    }
    expect(managedInFake(h)).toBeDefined(); // never claimed a victory it could not observe
  });
});

describe("never blind (Decisions: State, Mutations - a failed read is never absence)", () => {
  it("a repeatedly failing status read shows unknown, never idle, and no mutation fires while blind", async () => {
    const h = await makeHarness();
    const b = await makeEngine(h);
    const mutationsBefore = mutationCount(h);
    // Two full polls' worth of read failures: each read gets three attempts.
    for (let i = 0; i < 6; i += 1) {
      h.fake.handle.failNext("projectServices", "http500");
    }
    const s1 = await pollView(h, b);
    expect(s1.view.state).toBe("unknown");
    if (s1.view.state === "unknown") {
      expect(s1.view.reason).toContain("500");
    }
    // While the world is unknown a command is refused, not acted on.
    const up = await b.engine.up();
    expect(up.outcome).toBe("conflict");
    const s2 = await pollView(h, b);
    expect(s2.view.state).toBe("unknown"); // still failing, still saying so
    expect(mutationCount(h)).toBe(mutationsBefore); // never idle, never mutated
  });

  it("an unknown future deployment status is preserved as data: the view renders with the raw value in the reason and nothing crashes", async () => {
    const h = await makeHarness();
    const b = await makeEngine(h);
    await reachRunning(h, b);
    h.fake.handle.injectUnknownStatus("HYPERSCALING");
    const s = await pollView(h, b);
    // Intent is PRESENT, so the surprise lands on the failed branch of the
    // failed-or-deleting pair, raw wire value visible verbatim.
    expect(s.view.state).toBe("failed");
    if (s.view.state === "failed") {
      expect(s.view.reason).toContain("HYPERSCALING");
    }
    // One-shot surprise absorbed as data; the next poll recovers the truth.
    const after = await pollView(h, b);
    expect(after.view.state).toBe("running");
  });

  it("GraphQL 200 with errors plus partial data is a failed read: the view is unknown, not a half-trusted answer", async () => {
    const h = await makeHarness();
    const b = await makeEngine(h);
    h.fake.handle.failNext("projectServices", "graphql-errors");
    const s = await pollView(h, b);
    expect(s.view.state).toBe("unknown");
    if (s.view.state === "unknown") {
      expect(s.view.reason).toContain("injected GraphQL failure");
    }
  });
});

describe("command discipline (Decisions: Concurrency - single-flight, coalesce, 409)", () => {
  it("a double-clicked up over HTTP coalesces: one started, one coalesced, exactly one create upstream", async () => {
    const h = await makeHarness();
    const b = await makeEngine(h);
    await withApp(b.engine, async (base) => {
      const [res1, res2] = await Promise.all([
        fetch(`${base}/api/up`, { method: "POST", headers: bearerAuth(PASSWORD) }),
        fetch(`${base}/api/up`, { method: "POST", headers: bearerAuth(PASSWORD) }),
      ]);
      expect(res1.status).toBe(200);
      expect(res2.status).toBe(200);
      const bodies: unknown[] = await Promise.all([res1.json(), res2.json()]);
      const outcomes = [outcomeOf(bodies[0]), outcomeOf(bodies[1])];
      outcomes.sort();
      expect(outcomes).toEqual(["coalesced", "started"]);
    });
    expect(countOps(h, "serviceCreate")).toBe(1);
    expect(h.fake.state.listServices(TARGET.projectId).length).toBe(1);
  });

  it("up during teardown is refused with HTTP 409 conflict: creating into a half-deleted slot is how orphans are born", async () => {
    const h = await makeHarness();
    const b = await makeEngine(h);
    await reachRunning(h, b);
    h.fake.handle.setDeleteDelay(5);
    const down = await b.engine.down();
    expect(down.outcome).toBe("started");
    await b.gate.whenParked(); // teardown mid-fight, service still visible
    await withApp(b.engine, async (base) => {
      const res = await fetch(`${base}/api/up`, { method: "POST", headers: bearerAuth(PASSWORD) });
      expect(res.status).toBe(409);
      expect(outcomeOf(await res.json())).toBe("conflict");
    });
    expect(countOps(h, "serviceCreate")).toBe(1); // only the original create ever fired
  });

  it("down during creating cancels the create: permitted over HTTP and the service ends observed absent", async () => {
    const h = await makeHarness();
    const b = await makeEngine(h);
    const up = await b.engine.up();
    expect(up.outcome).toBe("started");
    expect(up.view.state).toBe("creating"); // the deploy is still walking its sequence
    h.fake.handle.setDeleteDelay(0);
    await withApp(b.engine, async (base) => {
      const res = await fetch(`${base}/api/down`, { method: "POST", headers: bearerAuth(PASSWORD) });
      expect(res.status).toBe(200);
      expect(outcomeOf(await res.json())).toBe("started");
    });
    await untilView(h, b, "idle");
    expect(managedInFake(h)).toBeUndefined();
  });

  it("mashing down during the delete loop coalesces with HTTP 200 and adds no delete beyond the loop's own", async () => {
    const h = await makeHarness();
    const b = await makeEngine(h);
    await reachRunning(h, b);
    h.fake.handle.setDeleteDelay(5);
    const down = await b.engine.down();
    expect(down.outcome).toBe("started");
    await b.gate.whenParked();
    expect(countOps(h, "serviceDelete")).toBe(1); // the loop's own, before the mash
    await withApp(b.engine, async (base) => {
      const res = await fetch(`${base}/api/down`, { method: "POST", headers: bearerAuth(PASSWORD) });
      expect(res.status).toBe(200);
      expect(outcomeOf(await res.json())).toBe("coalesced");
    });
    await realDelay(10);
    expect(countOps(h, "serviceDelete")).toBe(1); // the mash added nothing
  });
});

describe("auth boundary (Decisions: Auth - the engine never runs for an unauthorized request)", () => {
  it("an api request without a bearer passphrase gets 401 and zero requests reach Railway", async () => {
    const h = await makeHarness();
    const b = await makeEngine(h);
    const baseline = h.fake.handle.requests.length;
    await withApp(b.engine, async (base) => {
      const [statusRes, upRes] = await Promise.all([
        fetch(`${base}/api/status`),
        fetch(`${base}/api/up`, { method: "POST" }),
      ]);
      expect(statusRes.status).toBe(401);
      expect(upRes.status).toBe(401);
    });
    expect(h.fake.handle.requests.length).toBe(baseline); // the engine never ran
  });

  it("a wrong-length password gets 401, not a crash", async () => {
    const h = await makeHarness();
    const b = await makeEngine(h);
    const baseline = h.fake.handle.requests.length;
    await withApp(b.engine, async (base) => {
      const [shortRes, longRes] = await Promise.all([
        fetch(`${base}/api/status`, { headers: bearerAuth("x") }),
        fetch(`${base}/api/up`, { method: "POST", headers: bearerAuth(PASSWORD.repeat(20)) }),
      ]);
      expect(shortRes.status).toBe(401);
      expect(longRes.status).toBe(401);
      // The server survived the length mismatch: the next request is answered.
      const health = await fetch(`${base}/healthz`);
      expect(health.status).toBe(200);
    });
    expect(h.fake.handle.requests.length).toBe(baseline);
  });

  it("a cross-site POST is refused with 403 and nothing reaches Railway", async () => {
    const h = await makeHarness();
    const b = await makeEngine(h);
    const baseline = h.fake.handle.requests.length;
    await withApp(b.engine, async (base) => {
      const res = await fetch(`${base}/api/up`, {
        method: "POST",
        headers: { ...bearerAuth(PASSWORD), "sec-fetch-site": "cross-site" },
      });
      expect(res.status).toBe(403);
      const body: unknown = await res.json();
      expect(JSON.stringify(body)).toContain("cross-site");
    });
    expect(h.fake.handle.requests.length).toBe(baseline); // no upstream requests
  });
});

describe("observation hygiene (Decisions: State - status alone never mutates)", () => {
  it("a service not yet visible or not yet deployed reads as creating (REQUESTED/PENDING), never failed", async () => {
    // Window 1: created but not yet visible (the ~660ms production window).
    const h1 = await makeHarness();
    const b1 = await makeEngine(h1);
    h1.fake.handle.setCreateVisibilityDelay(2);
    const up = await b1.engine.up();
    expect(up.outcome).toBe("started");
    expect(up.view).toEqual({ state: "creating", rawPhase: "REQUESTED" }); // absent + intent PRESENT
    const during = await pollView(h1, b1);
    expect(during.view).toEqual({ state: "creating", rawPhase: "REQUESTED" });
    const visible = await pollView(h1, b1);
    expect(visible.view).toEqual({ state: "creating", rawPhase: "INITIALIZING" });

    // Window 2: visible with zero deployments (a first-class fact, not an
    // error) - reached when the boot-time deploy trigger itself fails.
    const h2 = await makeHarness();
    await createService(h2.config, TARGET, fastDeps); // exists upstream, never deployed
    await new IntentStore(h2.stateDir).save("PRESENT");
    h2.fake.handle.failNext("serviceInstanceDeploy", "http500");
    const b2 = await makeEngine(h2);
    expect(b2.resumed).toBe("trigger-deploy");
    expect(b2.warns.length).toBe(1); // the failed trigger was warned about, not hidden
    const pending = await pollView(h2, b2);
    expect(pending.view).toEqual({ state: "creating", rawPhase: "PENDING" }); // not failed
  });

  it("external deletion between polls flips the view to creating (the model wants it back) but status alone never re-creates", async () => {
    const h = await makeHarness();
    const b = await makeEngine(h);
    await reachRunning(h, b);
    const createsBefore = countOps(h, "serviceCreate");
    const deploysBefore = countOps(h, "serviceInstanceDeploy");
    expect(h.fake.handle.externallyDelete(MANAGED_SERVICE_NAME)).toBe(true);
    const s1 = await pollView(h, b);
    expect(s1.view).toEqual({ state: "creating", rawPhase: "REQUESTED" }); // intent PRESENT + absence
    const s2 = await pollView(h, b);
    expect(s2.view).toEqual({ state: "creating", rawPhase: "REQUESTED" });
    // Observation is not a command: nothing mutated without the operator.
    expect(countOps(h, "serviceCreate")).toBe(createsBefore);
    expect(countOps(h, "serviceInstanceDeploy")).toBe(deploysBefore);
    expect(countOps(h, "serviceDelete")).toBe(0);
  });

  it("a re-fired create that hits duplicate-name recovers by observing: no crash, one service, running", async () => {
    const h = await makeHarness();
    const b = await makeEngine(h);
    const s0 = await b.engine.status(); // primes the cache with observed absence
    expect(s0.view.state).toBe("idle");
    // The ambiguity: a create already landed upstream, but the engine's cached
    // world still says absent when the operator clicks up.
    await createService(h.config, TARGET, fastDeps);
    const up = await b.engine.up(); // no clock advance: decides on the stale absent
    expect(up.outcome).toBe("started"); // duplicate-name rejection failed safe
    await untilView(h, b, "running");
    expect(countOps(h, "serviceCreate")).toBe(2); // the re-fire happened and was absorbed
    expect(h.fake.state.listServices(TARGET.projectId).length).toBe(1); // no orphan twin
  });
});
