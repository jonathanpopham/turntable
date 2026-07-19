// Offline route tests: a stub engine behind a real listening server on an
// ephemeral loopback port, driven with fetch. No Railway, no network beyond
// 127.0.0.1, and the static files come from a throwaway temp directory.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/server.js";
import type { AppOptions, EngineLike } from "../src/server.js";
import type { CommandOutcome, CommandResult, StatusResult } from "../src/engine.js";
import type { ViewState } from "../src/transitions.js";

const PASSWORD = "correct horse battery staple";
const IDLE: ViewState = { state: "idle" };

interface StubCalls {
  status: number;
  up: number;
  down: number;
}

interface StubConfig {
  upOutcome?: CommandOutcome;
  downOutcome?: CommandOutcome;
  statusError?: Error;
}

function makeStub(config: StubConfig = {}): { engine: EngineLike; calls: StubCalls } {
  const calls: StubCalls = { status: 0, up: 0, down: 0 };
  const engine: EngineLike = {
    status: async (): Promise<StatusResult> => {
      calls.status += 1;
      if (config.statusError !== undefined) throw config.statusError;
      return { view: IDLE, intent: null, observedAt: 1_700_000_000_000, version: 7, bootId: "boot-test", serviceId: null };
    },
    up: async (): Promise<CommandResult> => {
      calls.up += 1;
      return { outcome: config.upOutcome ?? "started", view: IDLE };
    },
    down: async (): Promise<CommandResult> => {
      calls.down += 1;
      return { outcome: config.downOutcome ?? "started", view: IDLE };
    },
    stop: (): void => {},
  };
  return { engine, calls };
}

let publicDir: string;

beforeAll(async () => {
  publicDir = await mkdtemp(join(tmpdir(), "roundhouse-public-"));
  await Promise.all([
    writeFile(join(publicDir, "index.html"), "<!doctype html><title>roundhouse</title>"),
    writeFile(join(publicDir, "client.js"), "console.log('ui');"),
  ]);
});

afterAll(async () => {
  await rm(publicDir, { recursive: true, force: true });
});

interface Harness {
  base: string;
  logs: Array<Record<string, unknown>>;
}

async function withApp(
  config: StubConfig,
  fn: (h: Harness, calls: StubCalls) => Promise<void>,
): Promise<void> {
  const { engine, calls } = makeStub(config);
  const logs: Array<Record<string, unknown>> = [];
  const opts: AppOptions = {
    password: PASSWORD,
    publicDir,
    log: (event) => {
      logs.push(event);
    },
  };
  const server = createApp(engine, opts);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected a TCP listen address");
  }
  try {
    await fn({ base: `http://127.0.0.1:${address.port}`, logs }, calls);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((e) => {
        if (e === undefined) resolve();
        else reject(e);
      });
    });
  }
}

function bearerAuth(password: string): { authorization: string } {
  return { authorization: `Bearer ${password}` };
}

describe("server routes", () => {
  it("healthz is open without auth", () =>
    withApp({}, async (h) => {
      const res = await fetch(`${h.base}/healthz`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
    }));

  it("api routes require bearer auth (401, engine untouched); static login shell is public", () =>
    withApp({}, async (h, calls) => {
      const [statusRes, indexRes] = await Promise.all([
        fetch(`${h.base}/api/status`),
        fetch(`${h.base}/`),
      ]);
      // The login shell must load before anyone has a passphrase; the API
      // must not answer without one. The UI owns the credential (Bearer),
      // so there is no WWW-Authenticate browser popup by design.
      expect(statusRes.status).toBe(401);
      expect(statusRes.headers.get("www-authenticate")).toBeNull();
      expect(indexRes.status).toBe(200);
      expect(indexRes.headers.get("content-type")).toContain("text/html");
      expect(calls).toEqual({ status: 0, up: 0, down: 0 });
    }));

  it("wrong password of the same length gets 401", () =>
    withApp({}, async (h, calls) => {
      const wrong = "x".repeat(PASSWORD.length);
      const res = await fetch(`${h.base}/api/status`, { headers: bearerAuth(wrong) });
      expect(res.status).toBe(401);
      expect(calls.status).toBe(0);
    }));

  it("wrong-LENGTH password gets 401, not a crash (sha256 before timingSafeEqual)", () =>
    withApp({}, async (h, calls) => {
      const [shortRes, longRes] = await Promise.all([
        fetch(`${h.base}/api/status`, { headers: bearerAuth("x") }),
        fetch(`${h.base}/api/status`, { headers: bearerAuth(PASSWORD.repeat(20)) }),
      ]);
      expect(shortRes.status).toBe(401);
      expect(longRes.status).toBe(401);
      expect(calls.status).toBe(0);
    }));

  it("correct auth serves the status JSON shape", () =>
    withApp({}, async (h, calls) => {
      const res = await fetch(`${h.base}/api/status`, { headers: bearerAuth(PASSWORD) });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        view: { state: "idle" },
        intent: null,
        observedAt: 1_700_000_000_000,
        version: 7,
        bootId: "boot-test",
        serviceId: null,
      });
      expect(calls.status).toBe(1);
    }));

  it("correct auth serves index.html and client.js with content types", () =>
    withApp({}, async (h) => {
      const [indexRes, jsRes] = await Promise.all([
        fetch(`${h.base}/`, { headers: bearerAuth(PASSWORD) }),
        fetch(`${h.base}/client.js`, { headers: bearerAuth(PASSWORD) }),
      ]);
      expect(indexRes.status).toBe(200);
      expect(indexRes.headers.get("content-type")).toContain("text/html");
      expect(await indexRes.text()).toContain("roundhouse");
      expect(jsRes.status).toBe(200);
      expect(jsRes.headers.get("content-type")).toContain("text/javascript");
    }));

  it("POST /api/up started returns 200 with outcome and view", () =>
    withApp({ upOutcome: "started" }, async (h, calls) => {
      const res = await fetch(`${h.base}/api/up`, { method: "POST", headers: bearerAuth(PASSWORD) });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ outcome: "started", view: { state: "idle" } });
      expect(calls.up).toBe(1);
    }));

  it("POST /api/up conflict returns 409 with outcome and view", () =>
    withApp({ upOutcome: "conflict" }, async (h, calls) => {
      const res = await fetch(`${h.base}/api/up`, { method: "POST", headers: bearerAuth(PASSWORD) });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ outcome: "conflict", view: { state: "idle" } });
      expect(calls.up).toBe(1);
    }));

  it("POST /api/down coalesced returns 200 with outcome and view", () =>
    withApp({ downOutcome: "coalesced" }, async (h, calls) => {
      const res = await fetch(`${h.base}/api/down`, {
        method: "POST",
        headers: bearerAuth(PASSWORD),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ outcome: "coalesced", view: { state: "idle" } });
      expect(calls.down).toBe(1);
    }));

  it("cross-site POST is refused with 403 and the engine is not called", () =>
    withApp({}, async (h, calls) => {
      const [crossRes, sameSiteRes] = await Promise.all([
        fetch(`${h.base}/api/up`, {
          method: "POST",
          headers: { ...bearerAuth(PASSWORD), "sec-fetch-site": "cross-site" },
        }),
        fetch(`${h.base}/api/down`, {
          method: "POST",
          headers: { ...bearerAuth(PASSWORD), "sec-fetch-site": "same-site" },
        }),
      ]);
      expect(crossRes.status).toBe(403);
      expect(sameSiteRes.status).toBe(403);
      const body: unknown = await crossRes.json();
      expect(JSON.stringify(body)).toContain("cross-site");
      expect(calls.up).toBe(0);
      expect(calls.down).toBe(0);
    }));

  it("same-origin and missing sec-fetch-site both pass the CSRF gate", () =>
    withApp({}, async (h, calls) => {
      const sameOriginRes = await fetch(`${h.base}/api/up`, {
        method: "POST",
        headers: { ...bearerAuth(PASSWORD), "sec-fetch-site": "same-origin" },
      });
      const bareRes = await fetch(`${h.base}/api/up`, {
        method: "POST",
        headers: bearerAuth(PASSWORD),
      });
      expect(sameOriginRes.status).toBe(200);
      expect(bareRes.status).toBe(200);
      expect(calls.up).toBe(2);
    }));

  it("GET on /api/up is 405 with an allow header", () =>
    withApp({}, async (h, calls) => {
      const res = await fetch(`${h.base}/api/up`, { headers: bearerAuth(PASSWORD) });
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("POST");
      expect(calls.up).toBe(0);
    }));

  it("unknown path is 404", () =>
    withApp({}, async (h) => {
      const res = await fetch(`${h.base}/api/nope`, { headers: bearerAuth(PASSWORD) });
      expect(res.status).toBe(404);
    }));

  it("a throwing handler becomes 500 internal and a log line is emitted", () =>
    withApp({ statusError: new Error("boom at the roundhouse") }, async (h) => {
      const res = await fetch(`${h.base}/api/status`, { headers: bearerAuth(PASSWORD) });
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: "internal" });
      let logged = false;
      for (const entry of h.logs) {
        const err = entry["err"];
        if (typeof err === "string" && err.includes("boom at the roundhouse")) logged = true;
      }
      expect(logged).toBe(true);
    }));

  it("every response is logged with method, path, status, and duration", () =>
    withApp({}, async (h) => {
      const res = await fetch(`${h.base}/healthz`);
      expect(res.status).toBe(200);
      let found = false;
      for (const entry of h.logs) {
        if (
          entry["method"] === "GET" &&
          entry["path"] === "/healthz" &&
          entry["status"] === 200 &&
          typeof entry["durationMs"] === "number"
        ) {
          found = true;
        }
      }
      expect(found).toBe(true);
    }));

  it("POST with a body still works and the body is ignored", () =>
    withApp({}, async (h, calls) => {
      const res = await fetch(`${h.base}/api/up`, {
        method: "POST",
        headers: { ...bearerAuth(PASSWORD), "content-type": "application/json" },
        body: JSON.stringify({ sneaky: "payload", image: "evil:latest" }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ outcome: "started", view: { state: "idle" } });
      expect(calls.up).toBe(1);
    }));
});
