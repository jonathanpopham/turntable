// The composition root: durable intent + observation cache + pure decisions +
// the delete loop, assembled behind three methods the HTTP layer can call.
// Everything stateful lives here; everything decisive lives in transitions.ts.
import type { GqlConfig } from "./gql-request.js";
import type { Target } from "./operations.js";
import type { ProjectServicesResult } from "./gql-guards.js";
import type { Intent, Observation, Snapshot, ViewState } from "./transitions.js";
import { decide, deriveView } from "./transitions.js";
import { SingleFlight } from "./lock.js";
import { StatusCache } from "./status-cache.js";
import { makeVersionCounter, observe, reconcileOnBoot } from "./reconciler.js";
import type { ResumeAction } from "./reconciler.js";
import { runDeleteLoop } from "./delete-loop.js";
import type { StoredIntent } from "./intent-store.js";

const STATUS_TTL_MS = 2_000;

/** The four operations, injectable so tests use stubs and prod uses operations.ts. */
export interface EngineOps {
  createService: (config: GqlConfig, target: Target) => Promise<{ id: string; name: string }>;
  deployService: (config: GqlConfig, target: Target, serviceId: string) => Promise<boolean>;
  deleteService: (config: GqlConfig, target: Target, serviceId: string) => Promise<boolean>;
  getProjectServices: (config: GqlConfig, target: Target) => Promise<ProjectServicesResult>;
}

export interface EngineDeps {
  config: GqlConfig;
  target: Target;
  ops: EngineOps;
  intentStore: {
    load(): Promise<StoredIntent | null>;
    save(desired: Intent): Promise<void>;
  };
  clock: () => number;
  sleep: (ms: number) => Promise<void>;
  random: () => number;
  /** Structured warning sink; production wires console.error. */
  warn: (event: Record<string, unknown>) => void;
}

export type CommandOutcome = "started" | "coalesced" | "conflict";

export interface CommandResult {
  outcome: CommandOutcome;
  view: ViewState;
}

export interface StatusResult {
  view: ViewState;
  intent: Intent | null;
  observedAt: number;
  version: number;
}

export class Engine {
  readonly #deps: EngineDeps;
  readonly #lock = new SingleFlight();
  readonly #cache: StatusCache<Observation>;
  readonly #observeOnce: () => Promise<Observation>;
  #intent: Intent | null = null;
  #deleteAttempts = 0;
  #deleteLoopActive = false;
  #running = true;

  private constructor(deps: EngineDeps) {
    this.#deps = deps;
    const nextVersion = makeVersionCounter();
    this.#observeOnce = () =>
      observe({
        config: deps.config,
        target: deps.target,
        getProjectServices: deps.ops.getProjectServices,
        nextVersion,
        clock: deps.clock,
      });
    this.#cache = new StatusCache(this.#observeOnce, STATUS_TTL_MS, { clock: deps.clock });
  }

  /**
   * Boot reconciliation, then resume whatever a previous process left
   * unfinished. Durable intent is what makes each resume safe; the rules live
   * in reconciler.deriveResumeAction.
   */
  static async boot(deps: EngineDeps): Promise<{ engine: Engine; resumed: ResumeAction }> {
    const engine = new Engine(deps);
    const { snapshot, resumeAction } = await reconcileOnBoot({
      config: deps.config,
      target: deps.target,
      getProjectServices: deps.ops.getProjectServices,
      nextVersion: makeVersionCounter(),
      clock: deps.clock,
      intentStore: deps.intentStore,
    });
    engine.#intent = snapshot.intent;
    if (resumeAction === "resume-delete" && snapshot.observation.kind === "present") {
      engine.#startDeleteLoop(snapshot.observation.serviceId);
    } else if (resumeAction === "trigger-deploy" && snapshot.observation.kind === "present") {
      // Create landed but the process died before the deploy trigger.
      try {
        await deps.ops.deployService(deps.config, deps.target, snapshot.observation.serviceId);
      } catch (e: unknown) {
        deps.warn({ msg: "boot deploy trigger failed; UI will surface PENDING", err: String(e) });
      }
    } else if (resumeAction === "resume-create") {
      const result = await engine.up();
      if (result.outcome === "conflict") {
        deps.warn({ msg: "boot resume-create conflicted; leaving to operator", view: result.view });
      }
    }
    // "retry-observe" and "none" need no action: the next status poll observes.
    return { engine, resumed: resumeAction };
  }

  async status(): Promise<StatusResult> {
    const observation = await this.#cache.get();
    const view = deriveView(this.#snapshot(observation));
    return {
      view,
      intent: this.#intent,
      observedAt: observation.observedAt,
      version: observation.version,
    };
  }

  async up(): Promise<CommandResult> {
    const observation = await this.#cache.get();
    const decision = decide("up", this.#snapshot(observation));
    if (decision.action === "coalesce") {
      // One exception to coalescing: present with zero deployments and intent
      // PRESENT means the first deploy trigger was lost (created, then the
      // trigger failed or the response dropped). Without this, the cure only
      // exists at boot; with it, clicking Spin up again re-fires the trigger.
      if (
        observation.kind === "present" &&
        observation.phase === null &&
        this.#intent === "PRESENT" &&
        this.#lock.tryAcquire()
      ) {
        try {
          await this.#deps.ops.deployService(this.#deps.config, this.#deps.target, observation.serviceId);
        } finally {
          this.#cache.invalidate();
          this.#lock.release();
        }
        const after = await this.#cache.get();
        return { outcome: "started", view: deriveView(this.#snapshot(after)) };
      }
      return { outcome: "coalesced", view: decision.view };
    }
    if (decision.action === "conflict") return { outcome: "conflict", view: decision.view };
    if (decision.action === "delete") {
      // decide() never maps "up" to delete; defensive against future edits.
      return { outcome: "conflict", view: deriveView(this.#snapshot(observation)) };
    }
    if (!this.#lock.tryAcquire()) {
      // An operation is already in flight; same-direction mash coalesces.
      return { outcome: "coalesced", view: deriveView(this.#snapshot(observation)) };
    }
    try {
      await this.#deps.intentStore.save("PRESENT");
      this.#intent = "PRESENT";
      let serviceId: string;
      try {
        const created = await this.#deps.ops.createService(this.#deps.config, this.#deps.target);
        serviceId = created.id;
      } catch (e: unknown) {
        // Ambiguity path: the create may have applied (dropped response, or a
        // duplicate-name rejection from a previous ambiguous create). Look
        // instead of re-firing.
        const fresh = await this.#observeOnce();
        if (fresh.kind !== "present") throw e;
        serviceId = fresh.serviceId;
      }
      // Project-token creates never auto-deploy (verified live); trigger
      // explicitly, deterministic across token types.
      await this.#deps.ops.deployService(this.#deps.config, this.#deps.target, serviceId);
    } finally {
      this.#cache.invalidate();
      this.#lock.release();
    }
    const observationAfter = await this.#cache.get();
    return { outcome: "started", view: deriveView(this.#snapshot(observationAfter)) };
  }

  async down(): Promise<CommandResult> {
    const observation = await this.#cache.get();
    const decision = decide("down", this.#snapshot(observation));
    if (decision.action === "coalesce") return { outcome: "coalesced", view: decision.view };
    if (decision.action === "conflict") return { outcome: "conflict", view: decision.view };
    if (decision.action === "create") {
      return { outcome: "conflict", view: deriveView(this.#snapshot(observation)) };
    }
    if (!this.#lock.tryAcquire()) {
      return { outcome: "coalesced", view: deriveView(this.#snapshot(observation)) };
    }
    try {
      await this.#deps.intentStore.save("ABSENT");
      this.#intent = "ABSENT";
      this.#cache.invalidate();
      this.#startDeleteLoop(decision.serviceId);
    } finally {
      this.#lock.release();
    }
    const observationAfter = await this.#cache.get();
    return { outcome: "started", view: deriveView(this.#snapshot(observationAfter)) };
  }

  /** Cooperative shutdown for SIGTERM: lets the delete loop exit promptly. */
  stop(): void {
    this.#running = false;
  }

  #snapshot(observation: Observation): Snapshot {
    return { intent: this.#intent, observation, deleteAttempts: this.#deleteAttempts };
  }

  #startDeleteLoop(serviceId: string): void {
    if (this.#deleteLoopActive) return;
    this.#deleteLoopActive = true;
    this.#deleteAttempts = 0;
    const deps = this.#deps;
    void runDeleteLoop(
      {
        config: deps.config,
        target: deps.target,
        deleteService: deps.ops.deleteService,
        observe: this.#observeOnce,
        sleep: deps.sleep,
        random: deps.random,
        shouldContinue: () => this.#running,
      },
      serviceId,
      (attempts) => {
        this.#deleteAttempts = attempts;
        this.#cache.invalidate();
      },
    )
      .catch((e: unknown) => {
        deps.warn({ msg: "delete loop threw unexpectedly", err: String(e) });
      })
      .finally(() => {
        this.#deleteLoopActive = false;
        this.#deleteAttempts = 0;
        this.#cache.invalidate();
      });
  }
}
