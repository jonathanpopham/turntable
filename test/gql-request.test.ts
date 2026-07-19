// Transport tests against a per-test fake Railway on node:http (port 0).
// Fully offline: nothing here ever calls the real API.
import { createServer, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  gqlRequest,
  GqlTimeoutError,
  RailwayApiError,
  RailwayAuthError,
  RailwayRateLimitError,
  RoundhouseError,
  type GqlConfig,
} from "../src/gql-request.js";

const TOKEN = "sekrit-token-abc123";

interface SeenRequest {
  authorization: string | undefined;
  body: string;
}

interface FakeRailway {
  url: string;
  requests: SeenRequest[];
  close: () => Promise<void>;
}

/** attempt is 1-based; a handler that never touches res simulates a hang. */
type RespondFn = (attempt: number, res: ServerResponse) => void;

async function startFakeRailway(respond: RespondFn): Promise<FakeRailway> {
  const requests: SeenRequest[] = [];
  const server = createServer((req, res) => {
    // The timeout test aborts mid-flight on purpose; an unhandled stream
    // 'error' would kill the test process.
    req.on("error", () => {});
    res.on("error", () => {});
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    req.on("end", () => {
      requests.push({
        authorization: req.headers.authorization,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      respond(requests.length, res);
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("fake Railway did not bind a TCP port");
  }
  return {
    url: `http://127.0.0.1:${address.port}/graphql/v2`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      }),
  };
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function configFor(fake: FakeRailway, timeoutMs?: number): GqlConfig {
  return timeoutMs === undefined
    ? { endpoint: fake.url, token: TOKEN }
    : { endpoint: fake.url, token: TOKEN, timeoutMs };
}

/** Records requested delays and resolves immediately, keeping tests fast and deterministic. */
function sleepSpy(): { calls: number[]; sleep: (ms: number) => Promise<void> } {
  const calls: number[] = [];
  return {
    calls,
    sleep: (ms: number) => {
      calls.push(ms);
      return Promise.resolve();
    },
  };
}

/** Await a rejection and hand back the thrown value for inspection. */
async function rejectionOf(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e: unknown) {
    return e;
  }
  throw new Error("expected the promise to reject");
}

describe("gqlRequest", () => {
  const fakes: FakeRailway[] = [];

  async function fakeRailway(respond: RespondFn): Promise<FakeRailway> {
    const fake = await startFakeRailway(respond);
    fakes.push(fake);
    return fake;
  }

  afterEach(async () => {
    const closing: Array<Promise<void>> = [];
    for (const fake of fakes) {
      closing.push(fake.close());
    }
    fakes.length = 0;
    await Promise.all(closing);
  });

  it("POSTs the query with a Bearer token and returns the parsed envelope", async () => {
    const fake = await fakeRailway((_attempt, res) => {
      json(res, 200, { data: { ok: true } });
    });
    const body = await gqlRequest(configFor(fake), {
      query: "query ($id: String!) { project(id: $id) { id } }",
      variables: { id: "p-1" },
      kind: "read",
    });
    expect(body).toEqual({ data: { ok: true } });
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]?.authorization).toBe(`Bearer ${TOKEN}`);
    const posted: unknown = JSON.parse(fake.requests[0]?.body ?? "");
    expect(posted).toEqual({
      query: "query ($id: String!) { project(id: $id) { id } }",
      variables: { id: "p-1" },
    });
  });

  it("aborts a hung request and throws GqlTimeoutError", async () => {
    const fake = await fakeRailway(() => {
      // Never respond; the client's AbortController must fire.
    });
    const err = await rejectionOf(
      gqlRequest(configFor(fake, 100), { query: "query { ok }", kind: "read" }),
    );
    expect(err).toBeInstanceOf(GqlTimeoutError);
    expect(err).toBeInstanceOf(RoundhouseError);
    if (err instanceof GqlTimeoutError) {
      expect(err.cause).toBeDefined();
    }
  });

  it("retries a read on 500 with backoff, then succeeds", async () => {
    const fake = await fakeRailway((attempt, res) => {
      if (attempt < 3) json(res, 500, { message: "boom" });
      else json(res, 200, { data: { ok: 1 } });
    });
    const { calls, sleep } = sleepSpy();
    const body = await gqlRequest(
      configFor(fake),
      { query: "query { ok }", kind: "read" },
      { sleep, random: () => 0 },
    );
    expect(body).toEqual({ data: { ok: 1 } });
    expect(fake.requests).toHaveLength(3);
    expect(calls).toHaveLength(2);
    // Exponential: with zero jitter the second delay is exactly double the first.
    expect(calls[0]).toBeGreaterThan(0);
    expect(calls[1]).toBe((calls[0] ?? 0) * 2);
  });

  it("adds jitter from the injected RNG to each backoff delay", async () => {
    const fake = await fakeRailway((_attempt, res) => {
      json(res, 500, { message: "boom" });
    });
    async function delaysWith(random: () => number): Promise<number[]> {
      const { calls, sleep } = sleepSpy();
      const err = await rejectionOf(
        gqlRequest(configFor(fake), { query: "query { ok }", kind: "read" }, { sleep, random }),
      );
      expect(err).toBeInstanceOf(RailwayApiError);
      return calls;
    }
    const flat = await delaysWith(() => 0);
    const jittered = await delaysWith(() => 0.75);
    expect(flat).toHaveLength(2);
    expect(jittered).toHaveLength(2);
    expect(jittered[0] ?? 0).toBeGreaterThan(flat[0] ?? 0);
    expect(jittered[1] ?? 0).toBeGreaterThan(flat[1] ?? 0);
  });

  it("gives up after 3 read attempts and surfaces the last error", async () => {
    const fake = await fakeRailway((_attempt, res) => {
      json(res, 500, { message: "still down" });
    });
    const { calls, sleep } = sleepSpy();
    const err = await rejectionOf(
      gqlRequest(configFor(fake), { query: "query { ok }", kind: "read" }, { sleep, random: () => 0 }),
    );
    expect(err).toBeInstanceOf(RailwayApiError);
    if (err instanceof RailwayApiError) {
      expect(err.status).toBe(500);
    }
    expect(fake.requests).toHaveLength(3);
    expect(calls).toHaveLength(2);
  });

  it("never retries a mutation: a 500 makes exactly one request", async () => {
    const fake = await fakeRailway((_attempt, res) => {
      json(res, 500, { message: "boom" });
    });
    const { calls, sleep } = sleepSpy();
    const err = await rejectionOf(
      gqlRequest(
        configFor(fake),
        { query: "mutation { serviceDelete(id: \"s-1\") }", kind: "mutation" },
        { sleep, random: () => 0 },
      ),
    );
    expect(err).toBeInstanceOf(RailwayApiError);
    expect(fake.requests).toHaveLength(1);
    expect(calls).toHaveLength(0);
  });

  it("throws RailwayAuthError on 401 without retrying", async () => {
    const fake = await fakeRailway((_attempt, res) => {
      json(res, 401, { message: "unauthorized" });
    });
    const err = await rejectionOf(gqlRequest(configFor(fake), { query: "query { ok }", kind: "read" }));
    expect(err).toBeInstanceOf(RailwayAuthError);
    expect(err).toBeInstanceOf(RoundhouseError);
    expect(fake.requests).toHaveLength(1);
  });

  it("throws RailwayAuthError on 403", async () => {
    const fake = await fakeRailway((_attempt, res) => {
      json(res, 403, { message: "forbidden" });
    });
    const err = await rejectionOf(gqlRequest(configFor(fake), { query: "query { ok }", kind: "read" }));
    expect(err).toBeInstanceOf(RailwayAuthError);
  });

  it("throws RailwayRateLimitError after 429s exhaust the read attempts", async () => {
    const fake = await fakeRailway((_attempt, res) => {
      json(res, 429, { message: "slow down" });
    });
    const { calls, sleep } = sleepSpy();
    const err = await rejectionOf(
      gqlRequest(configFor(fake), { query: "query { ok }", kind: "read" }, { sleep, random: () => 0 }),
    );
    expect(err).toBeInstanceOf(RailwayRateLimitError);
    // 429 counts against the same attempt budget and respects backoff.
    expect(fake.requests).toHaveLength(3);
    expect(calls).toHaveLength(2);
  });

  it("treats a non-empty errors array as RailwayApiError even alongside partial data", async () => {
    const fake = await fakeRailway((_attempt, res) => {
      json(res, 200, {
        data: { serviceCreate: { id: "s-1", name: "roundhouse-slot-0" } },
        errors: [{ message: "Problem processing request" }],
      });
    });
    const err = await rejectionOf(gqlRequest(configFor(fake), { query: "query { ok }", kind: "read" }));
    expect(err).toBeInstanceOf(RailwayApiError);
    if (err instanceof Error) {
      expect(err.message).toContain("Problem processing request");
    }
    // GraphQL body errors are deterministic; a read must not burn retries on them.
    expect(fake.requests).toHaveLength(1);
  });

  it("throws RailwayApiError with the SyntaxError cause on an unparseable 200 body", async () => {
    const fake = await fakeRailway((_attempt, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("not json at all");
    });
    const err = await rejectionOf(gqlRequest(configFor(fake), { query: "query { ok }", kind: "read" }));
    expect(err).toBeInstanceOf(RailwayApiError);
    if (err instanceof RailwayApiError) {
      expect(err.cause).toBeInstanceOf(SyntaxError);
    }
  });

  it("never leaks the token into error messages, even when the server echoes it", async () => {
    const fake = await fakeRailway((_attempt, res) => {
      res.writeHead(401, { "content-type": "text/plain" });
      res.end(`denied for Bearer ${TOKEN}`);
    });
    const err = await rejectionOf(gqlRequest(configFor(fake), { query: "query { ok }", kind: "read" }));
    expect(err).toBeInstanceOf(RailwayAuthError);
    if (err instanceof Error) {
      expect(err.message).not.toContain(TOKEN);
      expect(String(err)).not.toContain(TOKEN);
      // Redaction actually ran (the echo was scrubbed, not just absent).
      expect(err.message).toContain("[redacted]");
    }
  });
});
