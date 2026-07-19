import { describe, expect, it, vi } from "vitest";
import { Engine } from "../src/engine.js";
import type { EngineDeps, EngineOps } from "../src/engine.js";
import type { ProjectServicesResult, ServiceSnapshot } from "../src/gql-guards.js";
import type { StoredIntent } from "../src/intent-store.js";

const NAME = "roundhouse-managed";

function service(status: string | null, id = "svc-1"): ServiceSnapshot {
  return {
    id,
    name: NAME,
    latestDeployment:
      status === null ? null : { id: "dep-1", status, createdAt: "2026-07-18T00:00:00Z" },
  };
}

interface World {
  deps: EngineDeps;
  calls: { create: number; deploy: number; del: number; reads: number };
  setServices: (services: ServiceSnapshot[]) => void;
  savedIntents: string[];
  failNextCreate: (e: Error) => void;
  failReads: (n: number) => void;
  tick: (ms: number) => void;
}

function makeWorld(initial: ServiceSnapshot[], intent: StoredIntent | null = null): World {
  let services = initial;
  let createFailure: Error | null = null;
  let readFailures = 0;
  const calls = { create: 0, deploy: 0, del: 0, reads: 0 };
  const savedIntents: string[] = [];
  let now = 0;
  const ops: EngineOps = {
    createService: () => {
      calls.create += 1;
      if (createFailure !== null) {
        const e = createFailure;
        createFailure = null;
        // The ambiguity contract: the effect may have applied despite the error.
        services = [service(null)];
        return Promise.reject(e);
      }
      services = [service(null)];
      return Promise.resolve({ id: "svc-1", name: NAME });
    },
    deployService: () => {
      calls.deploy += 1;
      services = [service("SUCCESS")];
      return Promise.resolve(true);
    },
    deleteService: () => {
      calls.del += 1;
      services = [];
      return Promise.resolve(true);
    },
    getProjectServices: (): Promise<ProjectServicesResult> => {
      calls.reads += 1;
      now += 5_000; // every read advances past the cache TTL
      if (readFailures > 0) {
        readFailures -= 1;
        return Promise.reject(new Error("api unreachable"));
      }
      return Promise.resolve({ services });
    },
  };
  const deps: EngineDeps = {
    config: { endpoint: "http://fake/", token: "t", auth: "project" },
    target: { projectId: "p", environmentId: "e" },
    ops,
    intentStore: {
      load: () => Promise.resolve(intent),
      save: (desired) => {
        savedIntents.push(desired);
        return Promise.resolve();
      },
    },
    clock: () => now,
    sleep: () => Promise.resolve(),
    random: () => 0,
    warn: () => {},
  };
  return {
    deps,
    calls,
    setServices: (s) => {
      services = s;
    },
    savedIntents,
    failNextCreate: (e) => {
      createFailure = e;
    },
    failReads: (n) => {
      readFailures = n;
    },
    tick: (ms) => {
      now += ms;
    },
  };
}

describe("Engine.up", () => {
  it("from idle: saves intent, creates, triggers deploy, reports started", async () => {
    const w = makeWorld([]);
    const { engine } = await Engine.boot(w.deps);
    const result = await engine.up();
    expect(result.outcome).toBe("started");
    expect(w.savedIntents).toEqual(["PRESENT"]);
    expect(w.calls.create).toBe(1);
    expect(w.calls.deploy).toBe(1);
    const status = await engine.status();
    expect(status.view.state).toBe("running");
  });

  it("coalesces when already running", async () => {
    const w = makeWorld([service("SUCCESS")], { desired: "PRESENT", updatedAt: "x" });
    const { engine } = await Engine.boot(w.deps);
    const result = await engine.up();
    expect(result.outcome).toBe("coalesced");
    expect(w.calls.create).toBe(0);
  });

  it("re-fires a lost first deploy trigger when up is pressed on a PENDING service", async () => {
    // The gap found in review: created, deploy trigger lost, no restart.
    // up() must be the runtime cure, not a coalesced no-op.
    const w = makeWorld([service(null)], { desired: "PRESENT", updatedAt: "x" });
    const { engine } = await Engine.boot(w.deps); // boot fires trigger-deploy once
    expect(w.calls.deploy).toBe(1);
    w.setServices([service(null)]); // simulate that trigger being lost
    const result = await engine.up();
    expect(result.outcome).toBe("started");
    expect(w.calls.deploy).toBe(2);
    expect(w.calls.create).toBe(0);
  });

  it("recovers the ambiguous create by observing instead of re-firing", async () => {
    const w = makeWorld([]);
    const { engine } = await Engine.boot(w.deps);
    w.failNextCreate(new Error("response lost"));
    const result = await engine.up();
    expect(result.outcome).toBe("started");
    expect(w.calls.create).toBe(1);
    expect(w.calls.deploy).toBe(1); // deploy fired against the observed id
  });
});

describe("Engine.down", () => {
  it("from running: saves ABSENT intent, drives to observed absence", async () => {
    const w = makeWorld([service("SUCCESS")], { desired: "PRESENT", updatedAt: "x" });
    const { engine } = await Engine.boot(w.deps);
    const result = await engine.down();
    expect(result.outcome).toBe("started");
    expect(w.savedIntents).toEqual(["ABSENT"]);
    await vi.waitFor(async () => {
      const status = await engine.status();
      expect(status.view.state).toBe("idle");
    });
    expect(w.calls.del).toBe(1);
    engine.stop();
  });

  it("coalesces when already idle", async () => {
    const w = makeWorld([]);
    const { engine } = await Engine.boot(w.deps);
    const result = await engine.down();
    expect(result.outcome).toBe("coalesced");
    expect(w.calls.del).toBe(0);
  });
});

describe("review blockers, pinned", () => {
  it("down during the create-visibility gap persists ABSENT instead of a hollow coalesce", async () => {
    // Blocker 3: intent PRESENT, nothing visible yet. Down must record the
    // desire durably; the old behavior coalesced and dropped it.
    const w = makeWorld([], { desired: "PRESENT", updatedAt: "x" });
    const { engine } = await Engine.boot(w.deps);
    // boot resume-create already created + deployed; wipe to reproduce the gap
    w.setServices([]);
    w.savedIntents.length = 0;
    const result = await engine.down();
    expect(result.outcome).toBe("started");
    expect(w.savedIntents).toEqual(["ABSENT"]);
    engine.stop();
  });

  it("a service appearing after record-absent gets deleted by observation alone", async () => {
    // Blocker 3 tail: reconciliation must chase late-visible services.
    const w = makeWorld([], { desired: "PRESENT", updatedAt: "x" });
    const { engine } = await Engine.boot(w.deps);
    w.setServices([]);
    await engine.down();
    w.setServices([service("SUCCESS")]); // the create lands late
    w.tick(5_000); // expire the status cache so the next poll re-observes
    await engine.status(); // observation alone must start the delete loop
    await vi.waitFor(async () => {
      expect(w.calls.del).toBe(1);
      const status = await engine.status();
      expect(status.view.state).toBe("idle");
    });
    engine.stop();
  });

  it("boot with the API down still applies durable ABSENT once the API recovers", async () => {
    // Blocker 2: retry-observe must resolve in the background and execute the
    // real resume action; status polls alone never did.
    const w = makeWorld([service("SUCCESS")], { desired: "ABSENT", updatedAt: "x" });
    w.failReads(2);
    const { engine, resumed } = await Engine.boot(w.deps);
    expect(resumed).toBe("retry-observe");
    await vi.waitFor(async () => {
      expect(w.calls.del).toBe(1);
      const status = await engine.status();
      expect(status.view.state).toBe("idle");
    });
    engine.stop();
  });

  it("a lost deploy trigger is auto-nudged from observation, reachable without any button", async () => {
    // Finding 5: recovery must not depend on a button the UI does not offer.
    const w = makeWorld([service("SUCCESS")], { desired: "PRESENT", updatedAt: "x" });
    const { engine } = await Engine.boot(w.deps);
    w.setServices([service(null)]); // deploy vanished: present, zero deployments
    w.tick(35_000); // expire the cache AND clear the nudge throttle
    await engine.status();
    await vi.waitFor(async () => {
      expect(w.calls.deploy).toBeGreaterThanOrEqual(1);
      const status = await engine.status();
      expect(status.view.state).toBe("running");
    });
    engine.stop();
  });
});

describe("Engine.boot resume", () => {
  it("intent ABSENT + service present resumes the delete fight", async () => {
    const w = makeWorld([service("SUCCESS")], { desired: "ABSENT", updatedAt: "x" });
    const { engine, resumed } = await Engine.boot(w.deps);
    expect(resumed).toBe("resume-delete");
    await vi.waitFor(async () => {
      const status = await engine.status();
      expect(status.view.state).toBe("idle");
    });
    expect(w.calls.del).toBe(1);
    engine.stop();
  });

  it("intent PRESENT + zero deployments fires the missing deploy trigger", async () => {
    const w = makeWorld([service(null)], { desired: "PRESENT", updatedAt: "x" });
    const { engine, resumed } = await Engine.boot(w.deps);
    expect(resumed).toBe("trigger-deploy");
    expect(w.calls.deploy).toBe(1);
    const status = await engine.status();
    expect(status.view.state).toBe("running");
  });

  it("no recorded intent adopts reality without mutating", async () => {
    const w = makeWorld([service("SUCCESS")], null);
    const { engine, resumed } = await Engine.boot(w.deps);
    expect(resumed).toBe("none");
    expect(w.calls.create + w.calls.deploy + w.calls.del).toBe(0);
    const status = await engine.status();
    expect(status.view.state).toBe("running");
    expect(status.intent).toBeNull();
  });
});
