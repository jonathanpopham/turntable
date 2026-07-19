import { describe, expect, it } from "vitest";
import { SingleFlight, withLock } from "../src/lock.js";

describe("SingleFlight", () => {
  it("acquires once, refuses while held, reacquires after release", () => {
    const sf = new SingleFlight();
    expect(sf.isHeld()).toBe(false);
    expect(sf.tryAcquire()).toBe(true);
    expect(sf.isHeld()).toBe(true);
    expect(sf.tryAcquire()).toBe(false);
    sf.release();
    expect(sf.isHeld()).toBe(false);
    expect(sf.tryAcquire()).toBe(true);
  });
});

describe("withLock", () => {
  it("runs the function, returns its result, and releases", async () => {
    const sf = new SingleFlight();
    const result = await withLock(sf, async () => 42);
    expect(result).toBe(42);
    expect(sf.isHeld()).toBe(false);
  });

  it("releases when the function throws", async () => {
    const sf = new SingleFlight();
    await expect(
      withLock(sf, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(sf.isHeld()).toBe(false);
    expect(sf.tryAcquire()).toBe(true);
  });

  it("concurrent calls: exactly one runs, the other reports busy", async () => {
    const sf = new SingleFlight();
    let releaseFirst: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let ran = 0;

    const first = withLock(sf, async () => {
      ran++;
      await gate;
      return "done";
    });
    const second = await withLock(sf, async () => {
      ran++;
      return "should not run";
    });

    expect(second).toEqual({ busy: true });
    expect(sf.isHeld()).toBe(true);

    releaseFirst();
    expect(await first).toBe("done");
    expect(ran).toBe(1);
    expect(sf.isHeld()).toBe(false);
  });
});
