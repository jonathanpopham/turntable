// IntentStore proofs. All offline: every test gets a fresh mkdtemp directory
// and nothing here ever touches Railway.
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IntentStore } from "../src/intent-store.js";
import type { StoredIntent } from "../src/intent-store.js";

const cleanupDirs: string[] = [];

async function freshDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "intent-store-"));
  cleanupDirs.push(dir);
  return dir;
}

// Quarantine warnings go to stderr via console.error; silence them so test
// output stays clean, and keep the spy so tests can assert on the line.
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  errorSpy = vi.spyOn(console, "error").mockImplementation(noop);
});

afterEach(async () => {
  errorSpy.mockRestore();
  const rms: Promise<void>[] = [];
  for (const dir of cleanupDirs) {
    rms.push(rm(dir, { recursive: true, force: true }));
  }
  cleanupDirs.length = 0;
  await Promise.all(rms);
});

function noop(): void {}

describe("IntentStore.save then load", () => {
  it("roundtrips PRESENT", async () => {
    const store = new IntentStore(await freshDir());
    await store.save("PRESENT");
    const loaded = await store.load();
    expect(loaded).not.toBeNull();
    expect(loaded?.desired).toBe("PRESENT");
  });

  it("roundtrips ABSENT", async () => {
    const store = new IntentStore(await freshDir());
    await store.save("ABSENT");
    const loaded = await store.load();
    expect(loaded?.desired).toBe("ABSENT");
  });

  it("stamps updatedAt as parseable ISO 8601", async () => {
    const before = Date.now();
    const store = new IntentStore(await freshDir());
    await store.save("PRESENT");
    const after = Date.now();
    const loaded = await store.load();
    expect(loaded).not.toBeNull();
    const t = Date.parse(loaded?.updatedAt ?? "");
    expect(Number.isNaN(t)).toBe(false);
    expect(t).toBeGreaterThanOrEqual(before);
    expect(t).toBeLessThanOrEqual(after);
  });

  it("second save overwrites the first; load returns the latest", async () => {
    const store = new IntentStore(await freshDir());
    await store.save("PRESENT");
    await store.save("ABSENT");
    const loaded = await store.load();
    expect(loaded?.desired).toBe("ABSENT");
  });

  it("creates the directory if absent", async () => {
    const dir = join(await freshDir(), "nested", "state");
    const store = new IntentStore(dir);
    await store.save("PRESENT");
    const loaded = await store.load();
    expect(loaded?.desired).toBe("PRESENT");
  });

  it("leaves no tmp file behind", async () => {
    const dir = await freshDir();
    const store = new IntentStore(dir);
    await store.save("PRESENT");
    const entries = await readdir(dir);
    expect(entries).toEqual(["intent.json"]);
  });

  it("concurrent saves leave one valid file holding one of the two values", async () => {
    const dir = await freshDir();
    const store = new IntentStore(dir);
    await Promise.all([store.save("PRESENT"), store.save("ABSENT")]);
    // The file on disk must be intact JSON (atomicity via rename), holding
    // exactly one of the competing intents.
    const raw = await readFile(join(dir, "intent.json"), "utf8");
    const parsed: unknown = JSON.parse(raw);
    const loaded = await store.load();
    expect(loaded).not.toBeNull();
    expect(["PRESENT", "ABSENT"]).toContain(loaded?.desired);
    expect(parsed).toEqual(loaded);
    const entries = await readdir(dir);
    expect(entries).toEqual(["intent.json"]);
  });
});

describe("IntentStore.load with no file", () => {
  it("returns null when the file is missing", async () => {
    const store = new IntentStore(await freshDir());
    expect(await store.load()).toBeNull();
  });

  it("returns null when the directory itself does not exist", async () => {
    const store = new IntentStore(join(await freshDir(), "never-created"));
    expect(await store.load()).toBeNull();
  });
});

describe("IntentStore.load with corrupt data", () => {
  it("garbage bytes: returns null and renames to intent.json.corrupt", async () => {
    const dir = await freshDir();
    await writeFile(join(dir, "intent.json"), Buffer.from([0xff, 0x00, 0x7b, 0x9c]));
    const store = new IntentStore(dir);
    expect(await store.load()).toBeNull();
    const entries = await readdir(dir);
    expect(entries).toEqual(["intent.json.corrupt"]);
    // Exactly one structured warning line, itself valid JSON, no file contents.
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const line = errorSpy.mock.calls[0]?.[0];
    expect(typeof line).toBe("string");
    if (typeof line !== "string") return;
    const warning: unknown = JSON.parse(line);
    expect(warning).toMatchObject({ level: "warn", quarantined: true });
  });

  it("wrong-shape JSON ({\"desired\":\"MAYBE\"}): returns null and renames", async () => {
    const dir = await freshDir();
    await writeFile(join(dir, "intent.json"), '{"desired":"MAYBE"}', "utf8");
    const store = new IntentStore(dir);
    expect(await store.load()).toBeNull();
    const entries = await readdir(dir);
    expect(entries).toEqual(["intent.json.corrupt"]);
  });

  it("rejects other shape violations", async () => {
    const badShapes = [
      "42", // not an object
      "null",
      '["PRESENT"]', // array, not object
      '{"desired":"PRESENT"}', // updatedAt missing
      '{"desired":"PRESENT","updatedAt":12345}', // updatedAt not a string
      '{"updatedAt":"2026-07-18T00:00:00.000Z"}', // desired missing
    ];
    // Sequential on purpose: each case needs its own fresh directory and a
    // clean read of the resulting entries.
    for (const bad of badShapes) {
      const dir = await freshDir();
      await writeFile(join(dir, "intent.json"), bad, "utf8");
      const store = new IntentStore(dir);
      expect(await store.load(), bad).toBeNull();
      expect(await readdir(dir), bad).toEqual(["intent.json.corrupt"]);
    }
  });

  it("preserves the corrupt bytes as evidence", async () => {
    const dir = await freshDir();
    const garbage = "not json at all {{{";
    await writeFile(join(dir, "intent.json"), garbage, "utf8");
    const store = new IntentStore(dir);
    expect(await store.load()).toBeNull();
    const evidence = await readFile(join(dir, "intent.json.corrupt"), "utf8");
    expect(evidence).toBe(garbage);
  });

  it("the next save after quarantine is clean and loadable", async () => {
    const dir = await freshDir();
    await writeFile(join(dir, "intent.json"), "garbage", "utf8");
    const store = new IntentStore(dir);
    expect(await store.load()).toBeNull();
    await store.save("ABSENT");
    const loaded: StoredIntent | null = await store.load();
    expect(loaded?.desired).toBe("ABSENT");
    const entries = await readdir(dir);
    entries.sort();
    expect(entries).toEqual(["intent.json", "intent.json.corrupt"]);
  });
});
