// Production entry point: the ONLY module with side effects on import. Env
// validation, real dependency wiring, listen, and signal handling all live
// here so server.ts stays pure and testable.
import { join } from "node:path";
import { Engine } from "./engine.js";
import type { EngineDeps } from "./engine.js";
import type { GqlConfig } from "./gql-request.js";
import { IntentStore } from "./intent-store.js";
import {
  createService,
  deleteService,
  deployService,
  getProjectServices,
} from "./operations.js";
import type { Target } from "./operations.js";
import { createApp } from "./server.js";

const RAILWAY_ENDPOINT = "https://backboard.railway.com/graphql/v2";
const DEFAULT_PORT = 3000;
const DEFAULT_STATE_DIR = "./state";
const SHUTDOWN_GRACE_MS = 5_000;

interface BootEnv {
  config: GqlConfig;
  target: Target;
  password: string;
  port: number;
  stateDir: string;
}

function logLine(event: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function warnLine(event: Record<string, unknown>): void {
  process.stderr.write(`${JSON.stringify(event)}\n`);
}

// Empty string counts as unset: an empty assignment in .env is a mistake, not
// a credential.
function envString(name: string): string | null {
  const value = process.env[name];
  if (value === undefined || value === "") return null;
  return value;
}

// Seals the "validated above" invariant for the compiler after the fail-fast
// check; reachable only if readEnv's missing-list logic rots.
function must(value: string | null, name: string): string {
  if (value === null) throw new Error(`unreachable: ${name} validated as present`);
  return value;
}

/**
 * Fail-fast env validation: every problem is reported in one multi-line
 * message, not one reboot at a time. Token resolution follows Railway's own
 * order: RAILWAY_TOKEN (project token, blast radius = one project) preferred,
 * RAILWAY_API_TOKEN (account bearer token) as fallback.
 */
function readEnv(): BootEnv {
  const missing: string[] = [];
  const projectToken = envString("RAILWAY_TOKEN");
  const apiToken = envString("RAILWAY_API_TOKEN");
  if (projectToken === null && apiToken === null) {
    missing.push("RAILWAY_TOKEN (project token, preferred) or RAILWAY_API_TOKEN (account token)");
  }
  const projectId = envString("TARGET_PROJECT_ID");
  if (projectId === null) missing.push("TARGET_PROJECT_ID (the dedicated Railway project id)");
  const environmentId = envString("TARGET_ENVIRONMENT_ID");
  if (environmentId === null) {
    missing.push("TARGET_ENVIRONMENT_ID (the environment inside that project)");
  }
  const password = envString("APP_PASSWORD");
  if (password === null) missing.push("APP_PASSWORD (login passphrase for the UI)");
  else if (password.length < 16) {
    // The passphrase is the entire authorization model for a button that
    // spends money; a short one is a misconfiguration, not a preference.
    missing.push("APP_PASSWORD must be at least 16 characters");
  }
  // Running on Railway (their injected env) with the ephemeral default state
  // dir means durable intent silently is not durable: restart-survival would
  // be a lie. Fail fast and name the fix.
  if (process.env["RAILWAY_SERVICE_ID"] !== undefined && envString("STATE_DIR") === null) {
    missing.push("STATE_DIR (mount a Railway volume, e.g. /data, and set STATE_DIR=/data)");
  }
  const portRaw = envString("PORT") ?? String(DEFAULT_PORT);
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    missing.push(`PORT (got "${portRaw}", need an integer in 0-65535)`);
  }

  if (missing.length > 0) {
    const lines: string[] = ["roundhouse cannot start; fix the environment:"];
    for (const item of missing) {
      lines.push(`  - ${item}`);
    }
    lines.push("see .env.example for the full list");
    process.stderr.write(`${lines.join("\n")}\n`);
    process.exit(1);
  }

  const config: GqlConfig =
    projectToken !== null
      ? { endpoint: RAILWAY_ENDPOINT, token: projectToken, auth: "project" }
      : { endpoint: RAILWAY_ENDPOINT, token: must(apiToken, "RAILWAY_API_TOKEN"), auth: "bearer" };

  return {
    config,
    target: {
      projectId: must(projectId, "TARGET_PROJECT_ID"),
      environmentId: must(environmentId, "TARGET_ENVIRONMENT_ID"),
    },
    password: must(password, "APP_PASSWORD"),
    port,
    // In production this is a Railway volume mount; locally ./state.
    stateDir: envString("STATE_DIR") ?? DEFAULT_STATE_DIR,
  };
}

async function main(): Promise<void> {
  const env = readEnv();

  const deps: EngineDeps = {
    config: env.config,
    target: env.target,
    ops: { createService, deployService, deleteService, getProjectServices },
    intentStore: new IntentStore(env.stateDir),
    clock: Date.now,
    sleep: (ms: number) =>
      new Promise((resolve) => {
        setTimeout(resolve, ms);
      }),
    random: Math.random,
    warn: warnLine,
  };

  const { engine, resumed } = await Engine.boot(deps);
  logLine({ level: "info", msg: "engine booted", resumed });

  // dist/src/main.js -> ../../public, same tree locally and in the image.
  const publicDir = join(import.meta.dirname, "..", "..", "public");
  const server = createApp(engine, { password: env.password, publicDir, log: logLine });

  // An unhandled 'error' event would kill the process silently; log and let
  // the exit code say something went wrong.
  server.on("error", (err) => {
    warnLine({ level: "error", msg: "server error", err: String(err) });
    process.exitCode = 1;
  });

  // Host "::": Railway routes to the container over IPv6 internally.
  server.listen(env.port, "::", () => {
    logLine({ level: "info", msg: "listening", port: env.port, host: "::" });
  });

  process.on("SIGTERM", () => {
    logLine({ level: "info", msg: "SIGTERM received; draining" });
    // Lets the delete loop observe shutdown and exit promptly.
    engine.stop();
    // Hard-exit fallback: unref'd so it never keeps an otherwise-finished
    // process alive, but fires if open sockets stall server.close.
    const fallback = setTimeout(() => {
      warnLine({ level: "warn", msg: "graceful close timed out; exiting" });
      process.exit(0);
    }, SHUTDOWN_GRACE_MS);
    fallback.unref();
    server.close(() => {
      process.exit(0);
    });
  });
}

// An unobserved rejection is a bug, not a log line: crash loudly and let
// Railway restart the container into boot reconciliation.
process.on("unhandledRejection", (reason) => {
  warnLine({ level: "error", msg: "unhandledRejection", err: String(reason) });
  process.exit(1);
});

void main().catch((e: unknown) => {
  warnLine({ level: "error", msg: "boot failed", err: String(e) });
  process.exit(1);
});
