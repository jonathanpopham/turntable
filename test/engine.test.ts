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
}

function makeWorld(initial: ServiceSnapshot[], intent: StoredIntent | null = null): World {
  let services = initial;
  let createFailure: Error | null = null;
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
