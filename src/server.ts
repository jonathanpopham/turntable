// The HTTP shell: thin, hardened, and side-effect free on import. Routing,
// auth, and CSRF policy live here; every decision about the container lives
// behind the EngineLike seam, and all production wiring (env, listen,
// signals) lives in main.ts. Style: explicit loops, node: imports, ?? for
// defaults (see README "Decisions").
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CommandResult, StatusResult } from "./engine.js";

/**
 * Structural seam over the engine: exactly what the HTTP layer needs and
 * nothing more, so tests stub it without constructing a real Engine.
 */
export interface EngineLike {
  status(): Promise<StatusResult>;
  up(): Promise<CommandResult>;
  down(): Promise<CommandResult>;
  stop(): void;
}

export interface AppOptions {
  /** Shared basic-auth passphrase; the deployed button spends money. */
  password: string;
  /** Directory the static UI is served from. */
  publicDir: string;
  /** One JSON line per response (plus handler errors). Never receives credentials. */
  log: (event: Record<string, unknown>) => void;
}

export function contentTypeFor(path: string): string {
  if (path.endsWith(".html")) return "text/html; charset=utf-8";
  if (path.endsWith(".css")) return "text/css; charset=utf-8";
  if (path.endsWith(".js")) return "text/javascript; charset=utf-8";
  return "application/octet-stream";
}

// The whole route surface: fixed paths, one allowed method each. Anything
// absent from this table is a 404; a known path with the wrong verb is a 405.
// Static file names are fixed here too, so no user input ever becomes a path.
const ROUTES = new Map<string, "GET" | "POST">([
  ["/healthz", "GET"],
  ["/", "GET"],
  ["/index.html", "GET"],
  ["/client.js", "GET"],
  ["/view-model.js", "GET"],
  ["/transitions.js", "GET"],
  ["/api/status", "GET"],
  ["/api/up", "POST"],
  ["/api/down", "POST"],
]);

// The login shell and its module graph load before anyone has a passphrase,
// so static assets are public; every /api route demands the Bearer token the
// UI sends after login. Static files reveal nothing but the UI itself.
const STATIC_FILES = new Map<string, string>([
  ["/", "index.html"],
  ["/index.html", "index.html"],
  ["/client.js", "client.js"],
  ["/view-model.js", "view-model.js"],
  ["/transitions.js", "transitions.js"],
]);

export function createApp(engine: EngineLike, opts: AppOptions): Server {
  const server = createServer((req, res) => {
    // dispatch never rejects in normal operation; this catch is the floor
    // under a failure inside the logger itself.
    void dispatch(engine, opts, req, res).catch(() => {});
  });
  // Public endpoint hygiene: bounded header and request time so idle or
  // trickling connections cannot pin sockets open.
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;
  return server;
}

async function dispatch(
  engine: EngineLike,
  opts: AppOptions,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const start = Date.now();
  const method = req.method ?? "GET";
  const path = pathOf(req.url ?? "/");
  try {
    await handle(engine, opts, req, res, method, path);
  } catch (e: unknown) {
    // Catch-all: a throwing route becomes an opaque 500. String(e) is safe to
    // log because the GraphQL transport already scrubs the token from every
    // error message it constructs.
    opts.log({ level: "error", msg: "handler error", method, path, err: String(e) });
    if (res.headersSent) {
      res.end();
    } else {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "internal" }));
    }
  }
  // One JSON line per response: method, path, status, duration. No headers,
  // no bodies, so credentials can never leak into logs.
  opts.log({ method, path, status: res.statusCode, durationMs: Date.now() - start });
}

async function handle(
  engine: EngineLike,
  opts: AppOptions,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  path: string,
): Promise<void> {
  // Unauthenticated by design: Railway healthchecks carry no credentials.
  if (path === "/healthz") {
    if (method !== "GET") {
      methodNotAllowed(res, "GET");
      return;
    }
    sendJson(res, 200, { ok: true });
    return;
  }

  const allowedMethod = ROUTES.get(path);
  if (allowedMethod === undefined) {
    sendJson(res, 404, { error: "not found" });
    return;
  }
  if (method !== allowedMethod) {
    methodNotAllowed(res, allowedMethod);
    return;
  }

  const staticFile = STATIC_FILES.get(path);
  if (staticFile !== undefined) {
    await serveStatic(res, opts.publicDir, staticFile);
    return;
  }

  // Auth precedes every /api route: the engine must never run for an
  // unauthorized request. The UI owns its credential (login form, passphrase
  // in sessionStorage, sent as a Bearer header on every fetch) instead of
  // leaning on the browser's basic-auth cache, which does not reliably
  // reattach to fetch() calls.
  if (!passphraseMatches(req.headers.authorization, opts.password)) {
    sendJson(res, 401, { error: "unauthorized", message: "passphrase required" });
    return;
  }

  if (path === "/api/status") {
    const status = await engine.status();
    sendJson(res, 200, status);
    return;
  }

  // The money routes. They take no request body - the command IS the URL, so
  // there is nothing to parse and no payload surface to harden.
  // CSRF gate: browsers auto-attach basic-auth credentials, so a cross-site
  // form POST could spend money; sec-fetch-site must be absent (curl and old
  // clients send none) or same-origin/none.
  const site = req.headers["sec-fetch-site"];
  if (site !== undefined && site !== "same-origin" && site !== "none") {
    sendJson(res, 403, {
      error: `cross-site request refused (sec-fetch-site: ${String(site)})`,
    });
    return;
  }
  const result = path === "/api/up" ? await engine.up() : await engine.down();
  // "conflict" is the single-flight lock saying no; started/coalesced are wins.
  sendJson(res, result.outcome === "conflict" ? 409 : 200, {
    outcome: result.outcome,
    view: result.view,
  });
}

/**
 * Bearer-passphrase auth. Both sides are compared as sha256 digests: hashing
 * first guarantees equal-length buffers, which is what makes timingSafeEqual
 * safe to call at all (it throws on unequal lengths) and removes passphrase
 * length as an observable. One operator, one passphrase (README "Auth" axis).
 */
function passphraseMatches(header: string | undefined, password: string): boolean {
  if (header === undefined || !header.startsWith("Bearer ")) return false;
  const supplied = header.slice("Bearer ".length);
  const suppliedDigest = createHash("sha256").update(supplied).digest();
  const expectedDigest = createHash("sha256").update(password).digest();
  return timingSafeEqual(suppliedDigest, expectedDigest);
}

// Only ever called with the two fixed file names in ROUTES, never with user
// input, so path traversal is impossible by construction.
async function serveStatic(res: ServerResponse, publicDir: string, name: string): Promise<void> {
  let body: Buffer;
  try {
    body = await readFile(join(publicDir, name));
  } catch (e: unknown) {
    // A missing file is a client-visible 404; any other read failure (perms,
    // I/O) escalates to the 500 catch-all.
    if (e instanceof Error && "code" in e && e.code === "ENOENT") {
      sendJson(res, 404, { error: "not found" });
      return;
    }
    throw e;
  }
  res.writeHead(200, { "content-type": contentTypeFor(name) });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

// The allow header tells a wrong-verb caller the right one (RFC 9110 15.5.6).
function methodNotAllowed(res: ServerResponse, allow: string): void {
  res.writeHead(405, { allow, "content-type": "application/json" });
  res.end(JSON.stringify({ error: "method not allowed" }));
}

// A request-target the URL parser rejects cannot match any fixed route; fall
// back to the raw string so it flows to the 404 arm instead of throwing.
function pathOf(rawUrl: string): string {
  try {
    return new URL(rawUrl, "http://roundhouse").pathname;
  } catch {
    return rawUrl;
  }
}
