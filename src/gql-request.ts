// Typed GraphQL transport for Railway's API. Policy lives here, parsing lives
// in gql-guards.ts: this module speaks HTTP, enforces an abort timeout on
// every call, classifies failures into typed errors, and retries only what is
// safe to retry. Reads get up to three attempts with exponential backoff and
// jitter; mutations get exactly one attempt, because a lost response does not
// mean a lost write - callers reconcile against the API instead of firing
// twice (README "Mutations | never blindly retried").
//
// Style: explicit loops over array-method chains; single pass, zero
// intermediate allocations (see README "Decisions").

import { isGqlEnvelope, isRecord } from "./gql-guards.js";

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_READ_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 250;
const SNIPPET_MAX_CHARS = 200;

export interface GqlConfig {
  /** Full GraphQL endpoint URL. Always injected; tests point this at a local fake. */
  endpoint: string;
  /** Railway API token. Never echoed into errors or logs. */
  token: string;
  /**
   * How the token is presented. "project" sends Railway's Project-Access-Token
   * header (environment-scoped token, the runtime default: blast radius is one
   * project, not the account). "bearer" sends Authorization: Bearer, for
   * account-scoped tokens. Defaults to "bearer".
   */
  auth?: "bearer" | "project";
  /** Per-attempt abort budget in milliseconds. Defaults to 10_000. */
  timeoutMs?: number;
}

export type GqlRequestKind = "read" | "mutation";

export interface GqlRequestOptions {
  query: string;
  variables?: Record<string, unknown>;
  kind: GqlRequestKind;
}

/** Injectable timing pieces so retry behavior is deterministic under test. */
export interface GqlRequestDeps {
  /** Backoff sleep. Defaults to a real setTimeout sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** Jitter source returning a float in [0, 1). Defaults to Math.random. */
  random?: () => number;
}

/** Base class for every failure this transport can throw; callers switch on subclass. */
export class RoundhouseError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** HTTP 401/403: the token is wrong or expired. Never retried - it will not fix itself. */
export class RailwayAuthError extends RoundhouseError {}

/** HTTP 429. Retryable for reads, counting against the same attempt budget. */
export class RailwayRateLimitError extends RoundhouseError {}

/** The per-attempt abort budget elapsed before a response finished arriving. */
export class GqlTimeoutError extends RoundhouseError {}

/**
 * Everything else: non-2xx statuses, network failures before a response,
 * unparseable bodies, and GraphQL envelopes with a non-empty `errors` array
 * (partial data alongside errors is still an error). `retryable` is decided
 * at construction: true only for 5xx and network-level failures.
 */
export class RailwayApiError extends RoundhouseError {
  /** HTTP status when a response arrived; undefined for network-level failures. */
  readonly status: number | undefined;
  readonly retryable: boolean;

  constructor(message: string, opts: { status?: number; retryable?: boolean; cause?: unknown } = {}) {
    super(message, { cause: opts.cause });
    this.status = opts.status;
    this.retryable = opts.retryable ?? false;
  }
}

/**
 * POST a GraphQL operation and return the raw parsed envelope as `unknown`
 * (shape extraction lives in gql-guards.ts), throwing a typed RoundhouseError
 * subclass on any failure. kind "read" retries transient failures up to
 * MAX_READ_ATTEMPTS total; kind "mutation" makes exactly one attempt.
 */
export async function gqlRequest(
  config: GqlConfig,
  opts: GqlRequestOptions,
  deps: GqlRequestDeps = {},
): Promise<unknown> {
  const sleep = deps.sleep ?? defaultSleep;
  const random = deps.random ?? Math.random;
  const maxAttempts = opts.kind === "read" ? MAX_READ_ATTEMPTS : 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      // return await, not return: a rejection must land in this catch.
      return await attemptOnce(config, opts);
    } catch (e: unknown) {
      if (attempt === maxAttempts || !isRetryable(e)) throw e;
      await sleep(backoffDelayMs(attempt - 1, random));
    }
  }
  // Unreachable: the final attempt either returned or threw above.
  throw new RoundhouseError("gqlRequest: retry loop exited without a result");
}

// What a read may retry: rate limits and transient server/network failures.
// Auth errors will not fix themselves, GraphQL body errors are deterministic,
// and timeouts already spent the caller's whole latency budget - retrying
// those would multiply worst-case latency, so the caller owns that tradeoff
// via timeoutMs.
function isRetryable(e: unknown): boolean {
  if (e instanceof RailwayRateLimitError) return true;
  if (e instanceof RailwayApiError) return e.retryable;
  return false;
}

// 250ms, 500ms, ... doubling per retry, plus up to one base unit of jitter so
// concurrent callers do not stampede back in phase.
function backoffDelayMs(retryIndex: number, random: () => number): number {
  return BASE_BACKOFF_MS * 2 ** retryIndex + Math.floor(random() * BASE_BACKOFF_MS);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function attemptOnce(config: GqlConfig, opts: GqlRequestOptions): Promise<unknown> {
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  let response: Response;
  let bodyText: string;
  try {
    response = await fetch(config.endpoint, {
      method: "POST",
      headers:
        (config.auth ?? "bearer") === "project"
          ? { "content-type": "application/json", "project-access-token": config.token }
          : { "content-type": "application/json", authorization: `Bearer ${config.token}` },
      body: JSON.stringify({ query: opts.query, variables: opts.variables ?? {} }),
      signal: controller.signal,
    });
    // Read the body under the same timer: a hung body is a hung request.
    bodyText = await response.text();
  } catch (e: unknown) {
    if (controller.signal.aborted) {
      throw new GqlTimeoutError(`GraphQL ${opts.kind} timed out after ${timeoutMs}ms`, { cause: e });
    }
    throw new RailwayApiError(`GraphQL ${opts.kind} failed before a response arrived`, {
      retryable: true,
      cause: e,
    });
  } finally {
    clearTimeout(timer);
  }

  const snippet = redactedSnippet(bodyText, config.token);
  if (response.status === 401 || response.status === 403) {
    throw new RailwayAuthError(`Railway rejected credentials (HTTP ${response.status}): ${snippet}`);
  }
  if (response.status === 429) {
    throw new RailwayRateLimitError(`Railway rate limited the ${opts.kind} (HTTP 429): ${snippet}`);
  }
  if (!response.ok) {
    throw new RailwayApiError(`Railway returned HTTP ${response.status}: ${snippet}`, {
      status: response.status,
      retryable: response.status >= 500,
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch (e: unknown) {
    throw new RailwayApiError(`Railway returned unparseable JSON: ${snippet}`, {
      status: response.status,
      cause: e,
    });
  }
  if (!isGqlEnvelope(parsed)) {
    throw new RailwayApiError(`Railway returned a non-envelope body: ${snippet}`, {
      status: response.status,
    });
  }
  if (parsed.errors !== undefined && parsed.errors.length > 0) {
    // Partial data alongside errors is still an error: acting on half an
    // answer is how a control plane drifts.
    throw new RailwayApiError(
      `GraphQL ${opts.kind} returned errors: ${describeGqlErrors(parsed.errors, config.token)}`,
      { status: response.status },
    );
  }
  return parsed;
}

// Belt and braces: no code path puts the token into a message on purpose, and
// this scrubs it even if Railway (or a misconfigured proxy) echoes it back.
// Redaction runs before truncation so a token can never survive as a partial.
function redactedSnippet(text: string, token: string): string {
  let out = token.length > 0 ? text.split(token).join("[redacted]") : text;
  if (out.length > SNIPPET_MAX_CHARS) {
    out = `${out.slice(0, SNIPPET_MAX_CHARS)}...`;
  }
  return out;
}

function describeGqlErrors(errors: readonly unknown[], token: string): string {
  const parts: string[] = [];
  for (const entry of errors) {
    if (isRecord(entry) && typeof entry["message"] === "string") {
      parts.push(entry["message"]);
    } else {
      parts.push(String(JSON.stringify(entry)));
    }
  }
  return redactedSnippet(parts.join("; "), token);
}
