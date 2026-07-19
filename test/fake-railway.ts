// In-process test double for Railway's GraphQL v2 endpoint. Speaks just
// enough of the schema to exercise every failure path the app hardens
// against: the four operations in src/operations.ts (matched on query
// content), plus scriptable failure injection - HTTP errors, hangs past the
// client timeout, malformed bodies, GraphQL error envelopes, and the
// ambiguity case where the side effect lands but the response is lost.
//
// Behaviors mirror what was probed live on 2026-07-18 (docs/schema-notes.md):
// duplicate service names rejected server-side with Railway's message shape,
// zero deployments after a project-token create (no auto-deploy), deletion as
// an async process observed only through subsequent polls, a sub-second
// visibility window after create, and a status enum that has grown before and
// will grow again.
//
// Plain module on node:http - no vitest dependency - so any test file can
// import it. Port 0 on 127.0.0.1; fully offline.
//
// Style: explicit loops over array-method chains; single pass, zero
// intermediate allocations (see README "Decisions").

import { createServer } from "node:http";
import type { IncomingHttpHeaders, ServerResponse } from "node:http";
import { isRecord } from "../src/gql-guards.js";

/** The four operations src/operations.ts can send. */
export type FakeOp = "serviceCreate" | "serviceInstanceDeploy" | "serviceDelete" | "projectServices";

/** One-shot failure modes injectable per operation via failNext. */
export type FailureKind =
  | "http500"
  | "http429"
  | "http401"
  | "timeout"
  | "malformed-json"
  | "graphql-errors"
  | "drop-after-effect";

/** Every request the fake receives, recorded in arrival order. */
export interface LoggedRequest {
  op: FakeOp | "unknown";
  variables: Record<string, unknown>;
  headers: IncomingHttpHeaders;
}

/** Readable snapshot of one deployment; status is the current sequence position. */
export interface FakeDeployment {
  id: string;
  status: string;
  createdAt: string;
}

/** Readable snapshot of one service. */
export interface FakeService {
  id: string;
  name: string;
  deployments: FakeDeployment[];
}

/** The control object: scriptable failures and out-of-band state mutation. */
export interface FakeRailwayHandle {
  /** Queue a one-shot failure for the next request matching `op`. FIFO per op. */
  failNext(op: FakeOp, kind: FailureKind): void;
  /** serviceDelete returns http500 (effect NOT applied) n times, then behaves normally. */
  failDeleteTimes(n: number): void;
  /** serviceDelete returns http500 (effect NOT applied) forever. */
  failDeleteForever(): void;
  /**
   * Services created AFTER this call stay absent from status responses for
   * `polls` status queries (mirrors the ~660ms production visibility window).
   */
  setCreateVisibilityDelay(polls: number): void;
  /**
   * How many status queries a deleted service stays visible before removal
   * (deletion is async in production). Default 1. Applies to deletes issued
   * after this call.
   */
  setDeleteDelay(polls: number): void;
  /** Status sequence for deployments created after this call. Default INITIALIZING, DEPLOYING, SUCCESS. */
  setDeploySequence(statuses: string[]): void;
  /** How long a "timeout" injection hangs before dropping the socket. */
  setHangMs(ms: number): void;
  /**
   * The next status response reports `raw` for every deployment, without
   * advancing any status sequence: presentation-only, one-shot.
   */
  injectUnknownStatus(raw: string): void;
  /** Remove a service out from under the app, immediately. True if one was removed. */
  externallyDelete(name: string): boolean;
  /** Live request log; index order is arrival order. */
  readonly requests: LoggedRequest[];
}

/** Read-only view of the in-memory state, as copies (peek, never advance). */
export interface FakeRailwayState {
  getService(projectId: string, name: string): FakeService | undefined;
  listServices(projectId: string): FakeService[];
}

export interface FakeRailway {
  url: string;
  handle: FakeRailwayHandle;
  state: FakeRailwayState;
  close(): Promise<void>;
}

export interface StartFakeRailwayOptions {
  /** Hang duration for "timeout" injections. Default 30_000ms; keep it above the client timeoutMs. */
  hangMs?: number;
}

const DEFAULT_HANG_MS = 30_000;
const DEFAULT_DEPLOY_SEQUENCE = ["INITIALIZING", "DEPLOYING", "SUCCESS"] as const;
// Deterministic clock base so createdAt values are stable across runs.
const BASE_TIME_MS = Date.UTC(2026, 6, 18);

interface DeploymentRecord {
  id: string;
  createdAt: string;
  /** Statuses this deployment walks through, one step per status query. */
  sequence: string[];
  /** Current position in `sequence`; parks at the last entry. */
  index: number;
}

interface ServiceRecord {
  id: string;
  name: string;
  deployments: DeploymentRecord[];
  /** Status queries remaining during which this service is invisible (post-create window). */
  hiddenPolls: number;
  /** True once a delete was accepted; removal happens during a later status query. */
  deleting: boolean;
  /** Status queries remaining during which a deleting service is still visible. */
  deletePollsRemaining: number;
}

function classifyOp(query: string): FakeOp | "unknown" {
  // Order matters only where names nest; none of these four do.
  if (query.includes("serviceInstanceDeploy")) return "serviceInstanceDeploy";
  if (query.includes("serviceCreate")) return "serviceCreate";
  if (query.includes("serviceDelete")) return "serviceDelete";
  if (query.includes("project(") && query.includes("services")) return "projectServices";
  return "unknown";
}

function readString(variables: Record<string, unknown>, key: string): string {
  const value = variables[key];
  return typeof value === "string" ? value : "";
}

function respondJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function requireNonNegativeInt(n: number, what: string): void {
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`${what} must be a non-negative integer, got ${String(n)}`);
  }
}

export async function startFakeRailway(options: StartFakeRailwayOptions = {}): Promise<FakeRailway> {
  // ---- Mutable state, all closed over by the handlers below ----
  const projects = new Map<string, Map<string, ServiceRecord>>();
  const requests: LoggedRequest[] = [];
  const injectedFailures = new Map<FakeOp, FailureKind[]>();
  // Hanging responses from "timeout" injections; cleared and destroyed on close.
  const hangs = new Map<NodeJS.Timeout, ServerResponse>();

  let hangMs = options.hangMs ?? DEFAULT_HANG_MS;
  let deploySequence: string[] = DEFAULT_DEPLOY_SEQUENCE.slice();
  let createVisibilityPolls = 0;
  let deleteVisibilityPolls = 1;
  let deleteFailRemaining = 0;
  let deleteFailForever = false;
  let pendingUnknownStatus: string | null = null;
  let serviceCounter = 0;
  let deploymentCounter = 0;
  let clock = 0;

  function nextTimestamp(): string {
    clock += 1;
    return new Date(BASE_TIME_MS + clock * 1000).toISOString();
  }

  function findServiceById(serviceId: string): ServiceRecord | null {
    for (const project of projects.values()) {
      for (const record of project.values()) {
        if (record.id === serviceId) return record;
      }
    }
    return null;
  }

  // ---- Operation semantics. Each returns the response body AND applies the
  // side effect, so "drop-after-effect" can run the effect then lose the reply.

  function executeCreate(variables: Record<string, unknown>): unknown {
    const projectId = readString(variables, "projectId");
    const name = readString(variables, "name");
    let project = projects.get(projectId);
    if (project === undefined) {
      project = new Map<string, ServiceRecord>();
      projects.set(projectId, project);
    }
    if (project.has(name)) {
      // Real message shape, verified live 2026-07-18.
      return {
        data: null,
        errors: [{ message: `A service named "${name}" already exists in this project` }],
      };
    }
    serviceCounter += 1;
    const record: ServiceRecord = {
      id: `svc-${String(serviceCounter)}`,
      name,
      deployments: [], // project-token behavior: create never auto-deploys
      hiddenPolls: createVisibilityPolls,
      deleting: false,
      deletePollsRemaining: 0,
    };
    project.set(name, record);
    return { data: { serviceCreate: { id: record.id, name: record.name } } };
  }

  function executeDeploy(variables: Record<string, unknown>): unknown {
    const serviceId = readString(variables, "serviceId");
    const record = findServiceById(serviceId);
    if (record === null) {
      return { data: null, errors: [{ message: `Service not found: ${serviceId}` }] };
    }
    deploymentCounter += 1;
    record.deployments.push({
      id: `dep-${String(deploymentCounter)}`,
      createdAt: nextTimestamp(),
      sequence: deploySequence.slice(), // snapshot: later setDeploySequence calls do not rewrite history
      index: 0,
    });
    return { data: { serviceInstanceDeploy: true } };
  }

  function executeDelete(variables: Record<string, unknown>): unknown {
    const id = readString(variables, "id");
    const record = findServiceById(id);
    if (record === null) {
      return { data: null, errors: [{ message: `Service not found: ${id}` }] };
    }
    // Acceptance, not completion: the record survives until a later status
    // query observes it out of visibility budget.
    record.deleting = true;
    record.deletePollsRemaining = deleteVisibilityPolls;
    return { data: { serviceDelete: true } };
  }

  function deploymentEdges(record: ServiceRecord, override: string | null, advance: boolean): unknown[] {
    const edges: unknown[] = [];
    for (const deployment of record.deployments) {
      const current = deployment.sequence[deployment.index] ?? "SUCCESS";
      edges.push({
        node: {
          id: deployment.id,
          status: override ?? current,
          createdAt: deployment.createdAt,
        },
      });
      // An injected unknown status is presentation-only: the sequence does
      // not advance, so the next poll resumes where this one left off.
      if (advance && override === null && deployment.index < deployment.sequence.length - 1) {
        deployment.index += 1;
      }
    }
    return edges;
  }

  function executeStatus(variables: Record<string, unknown>): unknown {
    const projectId = readString(variables, "projectId");
    const override = pendingUnknownStatus;
    pendingUnknownStatus = null; // one-shot
    const project = projects.get(projectId);
    const edges: unknown[] = [];
    if (project !== undefined) {
      const removed: string[] = [];
      for (const [name, record] of project) {
        if (record.hiddenPolls > 0) {
          // Post-create visibility window: absent from this response.
          record.hiddenPolls -= 1;
          continue;
        }
        if (record.deleting) {
          if (record.deletePollsRemaining > 0) {
            // Async deletion: still visible for this poll. Frozen, not advancing.
            record.deletePollsRemaining -= 1;
            edges.push({
              node: {
                id: record.id,
                name: record.name,
                deployments: { edges: deploymentEdges(record, override, false) },
              },
            });
          } else {
            removed.push(name);
          }
          continue;
        }
        edges.push({
          node: {
            id: record.id,
            name: record.name,
            deployments: { edges: deploymentEdges(record, override, true) },
          },
        });
      }
      for (const name of removed) {
        project.delete(name);
      }
    }
    return { data: { project: { services: { edges } } } };
  }

  function executeOp(op: FakeOp, variables: Record<string, unknown>): unknown {
    switch (op) {
      case "serviceCreate":
        return executeCreate(variables);
      case "serviceInstanceDeploy":
        return executeDeploy(variables);
      case "serviceDelete":
        return executeDelete(variables);
      case "projectServices":
        return executeStatus(variables);
    }
  }

  // ---- Failure injection ----

  function shiftInjected(op: FakeOp): FailureKind | null {
    const queue = injectedFailures.get(op);
    if (queue === undefined) return null;
    const kind = queue.shift();
    return kind ?? null;
  }

  // GraphQL "partial data alongside errors" bodies, shaped per operation so
  // the client's partial-data-is-still-an-error path is the one exercised.
  function partialDataFor(op: FakeOp): unknown {
    switch (op) {
      case "serviceCreate":
        return { serviceCreate: null };
      case "serviceInstanceDeploy":
        return { serviceInstanceDeploy: null };
      case "serviceDelete":
        return { serviceDelete: null };
      case "projectServices":
        return { project: null };
    }
  }

  function applyInjected(
    op: FakeOp,
    kind: FailureKind,
    variables: Record<string, unknown>,
    res: ServerResponse,
  ): void {
    switch (kind) {
      case "http500":
        respondJson(res, 500, { message: "injected internal error" });
        return;
      case "http429":
        respondJson(res, 429, { message: "injected rate limit" });
        return;
      case "http401":
        respondJson(res, 401, { message: "injected auth rejection" });
        return;
      case "timeout": {
        // Hang past the client timeout, then drop the socket. The timer is
        // tracked so close() can reclaim it before it fires.
        const timer: NodeJS.Timeout = setTimeout(() => {
          hangs.delete(timer);
          res.destroy();
        }, hangMs);
        hangs.set(timer, res);
        return;
      }
      case "malformed-json":
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"data": this is not JSON');
        return;
      case "graphql-errors":
        respondJson(res, 200, {
          data: partialDataFor(op),
          errors: [{ message: "injected GraphQL failure" }],
        });
        return;
      case "drop-after-effect":
        // The ambiguity case: the side effect lands, the response is lost.
        executeOp(op, variables);
        respondJson(res, 500, { message: "injected failure after effect applied" });
        return;
    }
  }

  function handleOp(op: FakeOp, variables: Record<string, unknown>, res: ServerResponse): void {
    const injected = shiftInjected(op);
    if (injected !== null) {
      applyInjected(op, injected, variables, res);
      return;
    }
    if (op === "serviceDelete" && (deleteFailForever || deleteFailRemaining > 0)) {
      if (!deleteFailForever) deleteFailRemaining -= 1;
      // Effect NOT applied: the service stays, distinct from drop-after-effect.
      respondJson(res, 500, { message: "injected serviceDelete failure" });
      return;
    }
    respondJson(res, 200, executeOp(op, variables));
  }

  // ---- HTTP plumbing ----

  const server = createServer((req, res) => {
    // Timeout injections abort mid-flight on purpose; an unhandled stream
    // 'error' would kill the host process.
    req.on("error", () => {});
    res.on("error", () => {});
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    req.on("end", () => {
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch (e: unknown) {
        void e; // unparseable request body: logged as unknown below
      }
      let query = "";
      let variables: Record<string, unknown> = {};
      if (isRecord(parsed)) {
        const q = parsed["query"];
        if (typeof q === "string") query = q;
        const v = parsed["variables"];
        if (isRecord(v)) variables = v;
      }
      const op = classifyOp(query);
      requests.push({ op, variables, headers: req.headers });
      if (op === "unknown") {
        respondJson(res, 200, { data: null, errors: [{ message: "Unsupported operation" }] });
        return;
      }
      handleOp(op, variables, res);
    });
  });

  // ---- Control object and readable state ----

  const handle: FakeRailwayHandle = {
    failNext(op: FakeOp, kind: FailureKind): void {
      const queue = injectedFailures.get(op);
      if (queue === undefined) {
        injectedFailures.set(op, [kind]);
      } else {
        queue.push(kind);
      }
    },
    failDeleteTimes(n: number): void {
      requireNonNegativeInt(n, "failDeleteTimes(n)");
      deleteFailRemaining = n;
      deleteFailForever = false;
    },
    failDeleteForever(): void {
      deleteFailForever = true;
    },
    setCreateVisibilityDelay(polls: number): void {
      requireNonNegativeInt(polls, "setCreateVisibilityDelay(polls)");
      createVisibilityPolls = polls;
    },
    setDeleteDelay(polls: number): void {
      requireNonNegativeInt(polls, "setDeleteDelay(polls)");
      deleteVisibilityPolls = polls;
    },
    setDeploySequence(statuses: string[]): void {
      if (statuses.length === 0) throw new Error("setDeploySequence needs at least one status");
      deploySequence = statuses.slice();
    },
    setHangMs(ms: number): void {
      requireNonNegativeInt(ms, "setHangMs(ms)");
      hangMs = ms;
    },
    injectUnknownStatus(raw: string): void {
      pendingUnknownStatus = raw;
    },
    externallyDelete(name: string): boolean {
      let found = false;
      for (const project of projects.values()) {
        if (project.delete(name)) found = true;
      }
      return found;
    },
    requests,
  };

  function snapshotService(record: ServiceRecord): FakeService {
    const deployments: FakeDeployment[] = [];
    for (const deployment of record.deployments) {
      deployments.push({
        id: deployment.id,
        status: deployment.sequence[deployment.index] ?? "SUCCESS",
        createdAt: deployment.createdAt,
      });
    }
    return { id: record.id, name: record.name, deployments };
  }

  const state: FakeRailwayState = {
    getService(projectId: string, name: string): FakeService | undefined {
      const record = projects.get(projectId)?.get(name);
      return record === undefined ? undefined : snapshotService(record);
    },
    listServices(projectId: string): FakeService[] {
      const out: FakeService[] = [];
      const project = projects.get(projectId);
      if (project !== undefined) {
        for (const record of project.values()) {
          out.push(snapshotService(record));
        }
      }
      return out;
    },
  };

  async function close(): Promise<void> {
    for (const [timer, res] of hangs) {
      clearTimeout(timer);
      res.destroy();
    }
    hangs.clear();
    // Keep-alive sockets from fetch would otherwise hold close() open forever.
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err !== undefined) {
          reject(err instanceof Error ? err : new Error(String(err)));
        } else {
          resolve();
        }
      });
    });
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;

  return { url: `http://127.0.0.1:${String(port)}/`, handle, state, close };
}
