import { describe, expect, it } from "vitest";
import { StatusCache } from "../src/status-cache.js";

function makeCounter(): { calls: () => number; fetch: () => Promise<number> } {
  let n = 0;
  let resolveHeld: ((v: number) => void) | null = null;
  void resolveHeld;
  return {
    calls: () => n,
    fetch: () => {
      n += 1;
      return Promise.resolve(n);
    },
  };
}

describe("StatusCache", () => {
  it("N simultaneous cold misses cause exactly one upstream call", async () => {
    let upstreamCalls = 0;
    let release: (v: string) => void = () => {};
    const cache = new StatusCache<string>(
      () => {
        upstreamCalls += 1;
        return new Promise((r) => {
          release = r;
        });
      },
      2000,
      { clock: () => 0 },
    );
    const requests = [cache.get(), cache.get(), cache.get(), cache.get(), cache.get()];
    release("snapshot");
    const results = await Promise.all(requests);
    expect(upstreamCalls).toBe(1);
    for (const r of results) {
      expect(r).toBe("snapshot");
    }
  });

  it("serves cached value inside TTL, refetches after expiry", async () => {
    let now = 0;
    const counter = makeCounter();
    const cache = new StatusCache(counter.fetch, 2000, { clock: () => now });
    expect(await cache.get()).toBe(1);
    now = 1999;
    expect(await cache.get()).toBe(1);
    now = 2000;
    expect(await cache.get()).toBe(2);
    expect(counter.calls()).toBe(2);
  });

  it("invalidate forces the next get to hit upstream even inside TTL", async () => {
    const counter = makeCounter();
    const cache = new StatusCache(counter.fetch, 60_000, { clock: () => 0 });
    expect(await cache.get()).toBe(1);
    cache.invalidate();
    expect(await cache.get()).toBe(2);
  });

  it("a failed fetch does not wedge the cache", async () => {
    let fail = true;
    let calls = 0;
    const cache = new StatusCache<string>(
      () => {
        calls += 1;
        return fail ? Promise.reject(new Error("network down")) : Promise.resolve("ok");
      },
      2000,
      { clock: () => 0 },
    );
    await expect(cache.get()).rejects.toThrow("network down");
    fail = false;
    expect(await cache.get()).toBe("ok");
    expect(calls).toBe(2);
  });
});
