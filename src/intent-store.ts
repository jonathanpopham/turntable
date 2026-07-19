// Durable desired-intent store. Observed Railway state cannot recover desired
// USER intent: if the user requested teardown, the delete failed, and the
// process restarted, boot reconciliation would see a running service and could
// not know the user wanted it gone. So desired presence - and ONLY desired
// presence - is persisted here. Observed state is never persisted; the Railway
// API stays the single source of observed truth. In production the directory
// is a Railway volume; locally it is ./state.
import { mkdir, open, readFile, rename } from "node:fs/promises";
import { join } from "node:path";

export type DesiredPresence = "PRESENT" | "ABSENT";

export type StoredIntent = {
  desired: DesiredPresence;
  /** ISO 8601, informational: when the intent was last recorded. */
  updatedAt: string;
};

const INTENT_FILE = "intent.json";
const TMP_FILE = "intent.json.tmp";
const CORRUPT_FILE = "intent.json.corrupt";

// Hand-rolled guard: this JSON comes off disk, so it enters as unknown and is
// narrowed property by property. No as-casts. Extra keys are tolerated so a
// future field addition can still read old code's files and vice versa.
function isStoredIntent(value: unknown): value is StoredIntent {
  if (typeof value !== "object" || value === null) return false;
  if (!("desired" in value) || !("updatedAt" in value)) return false;
  if (value.desired !== "PRESENT" && value.desired !== "ABSENT") return false;
  if (typeof value.updatedAt !== "string") return false;
  return true;
}

function errnoCode(e: unknown): string | null {
  if (e instanceof Error && "code" in e && typeof e.code === "string") {
    return e.code;
  }
  return null;
}

function noop(): void {}

export class IntentStore {
  readonly #dir: string;
  // In-process write serialization. Rename gives crash atomicity, but two
  // in-flight saves sharing one tmp path could interleave writes; chaining
  // them makes concurrent saves last-write-wins instead of file-mangling.
  // Single-instance app, so an in-memory chain is sufficient.
  #tail: Promise<void> = Promise.resolve();

  constructor(dir: string) {
    this.#dir = dir;
  }

  // No caching: reads hit the file every time. This is a single-instance app;
  // simplicity beats staleness bugs.
  async load(): Promise<StoredIntent | null> {
    const path = join(this.#dir, INTENT_FILE);
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (e: unknown) {
      // Missing file means no intent was ever recorded: boot reconciliation
      // then adopts observed reality and never auto-deletes.
      if (errnoCode(e) === "ENOENT") return null;
      // Anything else (permissions, I/O) is an operational fault, not corrupt
      // data - surface it rather than silently behaving like a fresh boot.
      throw new Error(`intent store: cannot read ${path}`, { cause: e });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return this.#quarantine(path, "unparseable JSON");
    }
    if (!isStoredIntent(parsed)) {
      return this.#quarantine(path, "unexpected shape");
    }
    return parsed;
  }

  async save(desired: DesiredPresence): Promise<void> {
    const run = (): Promise<void> => this.#write(desired);
    // Chain regardless of the previous save's outcome so one failed save
    // cannot poison the queue.
    const next = this.#tail.then(run, run);
    // The stored tail never rejects; each caller observes its own failure
    // through `next` (no floating rejection).
    this.#tail = next.then(noop, noop);
    return next;
  }

  // Atomic save: write the full payload to a tmp file, fsync the handle,
  // close, then rename over the real file. A crash at any point leaves either
  // the old intent or the new one, never a torn file. (The parent directory
  // is deliberately not fsynced: on the volumes this targets the rename is
  // metadata-journaled, and the failure it would cover - losing a just-saved
  // intent to a power cut - degrades to the safe "adopt observed reality"
  // path, not to auto-delete.)
  async #write(desired: DesiredPresence): Promise<void> {
    // Recursive create on first use; 0o700 because intent is operator-only
    // state. mkdir is a no-op when the directory already exists.
    await mkdir(this.#dir, { recursive: true, mode: 0o700 });
    const intent: StoredIntent = {
      desired,
      updatedAt: new Date().toISOString(),
    };
    const tmpPath = join(this.#dir, TMP_FILE);
    const fh = await open(tmpPath, "w", 0o600);
    try {
      await fh.writeFile(`${JSON.stringify(intent)}\n`, "utf8");
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmpPath, join(this.#dir, INTENT_FILE));
  }

  // Corrupt data never throws: the caller gets null (same as "no intent") and
  // the bad bytes are renamed aside so the evidence survives, the next load
  // does not re-trip, and the next save starts clean. One structured warning
  // line goes to stderr; file contents are never logged.
  async #quarantine(path: string, reason: string): Promise<null> {
    const corruptPath = join(this.#dir, CORRUPT_FILE);
    let quarantined = true;
    try {
      // POSIX rename replaces an existing .corrupt file: latest evidence wins.
      await rename(path, corruptPath);
    } catch {
      // Even a failed rename must not throw; load still reports "no intent".
      quarantined = false;
    }
    console.error(
      JSON.stringify({
        level: "warn",
        msg: "intent file corrupt; treating as no intent",
        file: path,
        reason,
        quarantined,
        corruptFile: corruptPath,
      }),
    );
    return null;
  }
}
