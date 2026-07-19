// Self-tests for the fake Railway harness: every path drives the REAL
// src/operations.ts functions at the fake's url, so the harness is proven
// against the exact client it will stand in for. Fully offline.
//
// Style: explicit loops over array-method chains; single pass, zero
// intermediate allocations (see README "Decisions").

import { afterEach, describe, expect, it } from "vitest";
import type { GqlConfig, GqlRequestDeps } from "../src/gql-request.js";
import {
  GqlTimeoutError,
  RailwayApiError,
  RailwayAuthError,
} from "../src/gql-request.js";
import { parseDeploymentStatus } from "../src/gql-guards.js";
import type { ProjectServicesResult, ServiceSnapshot } from "../src/gql-guards.js";
import {
  MANAGED_SERVICE_NAME,
  createService,
  deleteService,
  deployService,
  getProjectServices,
} from "../src/operations.js";
import { startFakeRailway } from "./fake-railway.js";
import type { FakeRailway, StartFakeRailwayOptions } from "./fake-railway.js";

const TOKEN = "fake-project-token";
const target = { projectId: "proj-test", environmentId: "env-test" };

// Instant sleep and zero jitter: read retries resolve in microseconds.
const fastDeps: GqlRequestDeps = {
  sleep: (): Promise<void> => Promise.resolve(),
  random: (): number => 0,
};

const started: FakeRailway[] = [];

async function boot(
  options: StartFakeRailwayOptions & { timeoutMs?: number } = {},
): Promise<{ fake: FakeRailway; config: GqlConfig }> {
  const fake = await startFakeRailway(options.hangMs === undefined ? {} : { hangMs: options.hangMs });
  started.push(fake);
  const config: GqlConfig = {
    endpoint: fake.url,
    token: TOKEN,
    auth: "project",
    timeoutMs: options.timeoutMs ?? 1_000,
  };
  return { fake, config };
}

afterEach(async () => {
  const closes: Promise<void>[] = [];
  for (const fake of started) {
    closes.push(fake.close());
  }
  started.length = 0;
  await Promise.all(closes);
});

function poll(config: GqlConfig): Promise<ProjectServicesResult> {
  return getProjectServices(config, target, fastDeps);
}

function findManaged(result: ProjectServicesResult): ServiceSnapshot | null {
  for (const service of result.services) {
    if (service.name === MANAGED_SERVICE_NAME) return service;
  }
  return null;
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (e: unknown) {
    return e;
  }
  throw new Error("expected the promise to reject");
}

describe("lifecycle through the real client", () => {
  it("runs create, deploy, poll to SUCCESS, delete, poll to absence", async () => {
    const { fake, config } = await boot();

    // Create: zero deployments, matching project-token behavior (no auto-deploy).
    const created = await createService(config, target);
    expect(created.name).toBe(MANAGED_SERVICE_NAME);
    const afterCreate = findManaged(await poll(config));
    expect(afterCreate).not.toBeNull();
    expect(afterCreate?.latestDeployment).toBeNull();

    // Deploy: acceptance boolean, then one status step per poll. Sequential
    // awaits on purpose: each poll advances the fake's state machine.
    expect(await deployService(config, target, created.id)).toBe(true);
    expect(findManaged(await poll(config))?.latestDeployment?.status).toBe("INITIALIZING");
    expect(findManaged(await poll(config))?.latestDeployment?.status).toBe("DEPLOYING");
    expect(findManaged(await poll(config))?.latestDeployment?.status).toBe("SUCCESS");

    // Delete: acceptance is not completion. Default delete delay is one poll,
    // so the service is observed once more before absence.
    expect(await deleteService(config, target, created.id)).toBe(true);
    expect(findManaged(await poll(config))).not.toBeNull();
    expect(findManaged(await poll(config))).toBeNull();

    // The request log saw every call, in order, with the project token header.
    const ops: string[] = [];
    for (const entry of fake.handle.requests) {
      ops.push(entry.op);
    }
    expect(ops).toEqual([
      "serviceCreate",
      "projectServices",
      "serviceInstanceDeploy",
      "projectServices",
      "projectServices",
      "projectServices",
      "serviceDelete",
      "projectServices",
      "projectServices",
    ]);
    const first = fake.handle.requests[0];
    expect(first?.headers["project-access-token"]).toBe(TOKEN);
    expect(first?.headers["authorization"]).toBeUndefined();
    expect(first?.variables["name"]).toBe(MANAGED_SERVICE_NAME);
  });

  it("rejects a duplicate service name with Railway's real message shape", async () => {
    const { config } = await boot();
    await createService(config, target);
    const thrown = await rejectionOf(createService(config, target));
    expect(thrown).toBeInstanceOf(RailwayApiError);
    expect(String(thrown)).toContain(
      `A service named "${MANAGED_SERVICE_NAME}" already exists in this project`,
    );
  });

  it("walks a configured deploy sequence and parks on its last status", async () => {
    const { fake, config } = await boot();
    fake.handle.setDeploySequence(["QUEUED", "BUILDING", "CRASHED"]);
    const created = await createService(config, target);
    await deployService(config, target, created.id);
    expect(findManaged(await poll(config))?.latestDeployment?.status).toBe("QUEUED");
    expect(findManaged(await poll(config))?.latestDeployment?.status).toBe("BUILDING");
    expect(findManaged(await poll(config))?.latestDeployment?.status).toBe("CRASHED");
    expect(findManaged(await poll(config))?.latestDeployment?.status).toBe("CRASHED");
  });
});

describe("failure injection", () => {
  it("http500 on a mutation surfaces as a retryable RailwayApiError after exactly one upstream call", async () => {
    const { fake, config } = await boot();
    fake.handle.failNext("serviceCreate", "http500");
    const thrown = await rejectionOf(createService(config, target));
    expect(thrown).toBeInstanceOf(RailwayApiError);
    if (thrown instanceof RailwayApiError) {
      expect(thrown.status).toBe(500);
      expect(thrown.retryable).toBe(true);
    }
    // Mutations are never blindly retried: the log proves one call, not three.
    let createCalls = 0;
    for (const entry of fake.handle.requests) {
      if (entry.op === "serviceCreate") createCalls += 1;
    }
    expect(createCalls).toBe(1);
    // And the failure was response-only theatre: no service was created.
    expect(fake.state.getService(target.projectId, MANAGED_SERVICE_NAME)).toBeUndefined();
  });

  it("http429 on a read is retried by the client and succeeds on the second attempt", async () => {
    const { fake, config } = await boot();
    fake.handle.failNext("projectServices", "http429");
    const result = await poll(config);
    expect(result.services).toEqual([]);
    let statusCalls = 0;
    for (const entry of fake.handle.requests) {
      if (entry.op === "projectServices") statusCalls += 1;
    }
    expect(statusCalls).toBe(2);
  });

  it("http401 surfaces as RailwayAuthError", async () => {
    const { fake, config } = await boot();
    fake.handle.failNext("projectServices", "http401");
    expect(await rejectionOf(poll(config))).toBeInstanceOf(RailwayAuthError);
  });

  it("timeout hangs past the client budget and surfaces as GqlTimeoutError", async () => {
    const { fake, config } = await boot({ hangMs: 500, timeoutMs: 60 });
    fake.handle.failNext("projectServices", "timeout");
    expect(await rejectionOf(poll(config))).toBeInstanceOf(GqlTimeoutError);
  });

  it("malformed-json surfaces as an unparseable-body RailwayApiError", async () => {
    const { fake, config } = await boot();
    fake.handle.failNext("projectServices", "malformed-json");
    const thrown = await rejectionOf(poll(config));
    expect(thrown).toBeInstanceOf(RailwayApiError);
    expect(String(thrown)).toContain("unparseable JSON");
  });

  it("graphql-errors (200 with errors plus partial data) is still an error to the client", async () => {
    const { fake, config } = await boot();
    fake.handle.failNext("serviceCreate", "graphql-errors");
    const thrown = await rejectionOf(createService(config, target));
    expect(thrown).toBeInstanceOf(RailwayApiError);
    expect(String(thrown)).toContain("injected GraphQL failure");
  });

  it("drop-after-effect on create: the client sees a 500 but the service exists", async () => {
    const { fake, config } = await boot();
    fake.handle.failNext("serviceCreate", "drop-after-effect");
    const thrown = await rejectionOf(createService(config, target));
    expect(thrown).toBeInstanceOf(RailwayApiError);
    // The ambiguity case: readable state and a subsequent poll both show the
    // service, exactly what reconcile-instead-of-retry exists to handle.
    expect(fake.state.getService(target.projectId, MANAGED_SERVICE_NAME)).toBeDefined();
    expect(findManaged(await poll(config))).not.toBeNull();
    // A blind retry would now hit the duplicate-name rejection.
    const retried = await rejectionOf(createService(config, target));
    expect(String(retried)).toContain("already exists in this project");
  });

  it("drop-after-effect on delete: the client sees a 500 but deletion proceeds", async () => {
    const { fake, config } = await boot();
    const created = await createService(config, target);
    fake.handle.failNext("serviceDelete", "drop-after-effect");
    const thrown = await rejectionOf(deleteService(config, target, created.id));
    expect(thrown).toBeInstanceOf(RailwayApiError);
    expect(findManaged(await poll(config))).not.toBeNull(); // async window
    expect(findManaged(await poll(config))).toBeNull(); // then gone
  });
});

describe("delete failure policies", () => {
  it("failDeleteTimes(n) rejects n deletes without applying them, then behaves normally", async () => {
    const { fake, config } = await boot();
    const created = await createService(config, target);
    fake.handle.failDeleteTimes(2);
    expect(await rejectionOf(deleteService(config, target, created.id))).toBeInstanceOf(RailwayApiError);
    expect(await rejectionOf(deleteService(config, target, created.id))).toBeInstanceOf(RailwayApiError);
    // The failed attempts applied nothing: still present, not even deleting.
    expect(findManaged(await poll(config))).not.toBeNull();
    expect(await deleteService(config, target, created.id)).toBe(true);
    expect(findManaged(await poll(config))).not.toBeNull();
    expect(findManaged(await poll(config))).toBeNull();
  });

  it("failDeleteForever keeps the service present no matter how often delete fires", async () => {
    const { fake, config } = await boot();
    const created = await createService(config, target);
    fake.handle.failDeleteForever();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(await rejectionOf(deleteService(config, target, created.id))).toBeInstanceOf(RailwayApiError);
    }
    expect(findManaged(await poll(config))).not.toBeNull();
    expect(findManaged(await poll(config))).not.toBeNull();
  });
});

describe("observation windows", () => {
  it("create visibility delay hides the service for n polls, then reveals it", async () => {
    const { fake, config } = await boot();
    fake.handle.setCreateVisibilityDelay(2);
    await createService(config, target);
    expect(findManaged(await poll(config))).toBeNull();
    expect(findManaged(await poll(config))).toBeNull();
    expect(findManaged(await poll(config))).not.toBeNull();
  });

  it("externallyDelete removes a service out from under the app between polls", async () => {
    const { fake, config } = await boot();
    await createService(config, target);
    expect(findManaged(await poll(config))).not.toBeNull();
    expect(fake.handle.externallyDelete(MANAGED_SERVICE_NAME)).toBe(true);
    expect(findManaged(await poll(config))).toBeNull();
  });

  it("an injected unknown status passes through the guards tagged, then the sequence resumes", async () => {
    const { fake, config } = await boot();
    const created = await createService(config, target);
    await deployService(config, target, created.id);
    fake.handle.injectUnknownStatus("HYPERSCALING");
    const raw = findManaged(await poll(config))?.latestDeployment?.status;
    expect(raw).toBe("HYPERSCALING");
    // The guard preserves it as data instead of throwing it away.
    expect(parseDeploymentStatus(raw ?? "")).toEqual({ kind: "unknown", raw: "HYPERSCALING" });
    // One-shot and presentation-only: the sequence did not advance under it.
    expect(findManaged(await poll(config))?.latestDeployment?.status).toBe("INITIALIZING");
    expect(findManaged(await poll(config))?.latestDeployment?.status).toBe("DEPLOYING");
  });
});
