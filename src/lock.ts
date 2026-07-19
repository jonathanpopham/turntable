// Single-flight concurrency guard: one lifecycle operation at a time.
// In-process by design; the README roadmap (rung 3, one instance to many)
// names this as the seam where leases or a durable workflow engine land.

export class SingleFlight {
  private held = false;

  /** Take the lock if free. Returns whether it was acquired. Never blocks. */
  tryAcquire(): boolean {
    if (this.held) return false;
    this.held = true;
    return true;
  }

  release(): void {
    this.held = false;
  }

  isHeld(): boolean {
    return this.held;
  }
}

export type Busy = { busy: true };

/**
 * Run fn under the lock, or report busy without waiting. Release is in a
 * finally, so a throwing fn can never wedge the slot. `return await` keeps
 * settlement inside the try so the finally runs only after fn is done.
 */
export async function withLock<T>(sf: SingleFlight, fn: () => Promise<T>): Promise<T | Busy> {
  if (!sf.tryAcquire()) return { busy: true };
  try {
    return await fn();
  } finally {
    sf.release();
  }
}
