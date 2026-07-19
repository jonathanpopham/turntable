// Reconciler proofs, all offline: the read path is a plain async stub, so no
// HTTP and no Railway. Covers every Observation classification and every boot
// resume rule by name.
import { describe, expect, it } from "vitest";
import { makeVersionCounter, observe, reconcileOnBoot } from "../src/reconciler.js";
import type { BootDeps, ObserveDeps } from "../src/reconciler.js";
import { RailwayAuthError, RailwayRateLimitError } from "../src/gql-request.js";
import { MANAGED_SERVICE_NAME } from "../src/operations.js";
import type { ProjectServicesResult } from "../src/gql-guards.js";
import type { DesiredPresence } from "../src/intent-store.js";

// A recognizable token so tests can assert it never leaks into a reason.
const TOKEN = "tok-super-secret-4242";
const CLOCK_MS = 1_752_800_000_000;

function makeObserveDeps(read: ObserveDeps["getProjectServices"]): ObserveDeps {
  return {
    config: { endpoint: "http://fake.local/graphql", token: TOKEN },
    target: { projectId: "proj-1", environmentId: "env-1" },
    getProjectServices: read,
    nextVersion: makeVersionCounter(),
    clock: () => CLOCK_MS,
  };
}

/** A project snapshot holding the managed service with the given latest status. */
function managedProject(status: string | null): ProjectServicesResult {
  return {
    services: [
      {
        id: "svc-managed",
        name: MANAGED_SERVICE_NAME,
        latestDeployment:
          status === null
            ? null
            : { id: "dep-1", status, createdAt: "2026-07-18T00:00:00.000Z" },
      },
    ],
  };
}

describe("observe classification", () => {
  it("absent: read succeeds and no service carries the managed name", async () => {
    const project: ProjectServicesResult = {
      services: [{ id: "svc-other", name: "some-other-service", latestDeployment: null }],
    };
    const obs = await observe(makeObserveDeps(async () => project));
    expect(obs).toEqual({ kind: "absent", observedAt: CLOCK_MS, version: 1 });
  });

  it("present: managed service found by name, known status classified as phase", async () => {
    const obs = await observe(makeObserveDeps(async () => managedProject("SUCCESS")));
    expect(obs).toEqual({
      kind: "present",
      serviceId: "svc-managed",
      phase: "SUCCESS",
      observedAt: CLOCK_MS,
      version: 1,
    });
  });

  it("present with zero deployments: phase is null, a fact rather than an error", async () => {
    const obs = await observe(makeObserveDeps(async () => managedProject(null)));
    expect(obs.kind).toBe("present");
    if (obs.kind !== "present") return;
    expect(obs.phase).toBeNull();
  });

  it("present with an unrecognized wire status: phase wraps the raw string", async () => {
    const obs = await observe(makeObserveDeps(async () => managedProject("HIBERNATING")));
    expect(obs.kind).toBe("present");
    if (obs.kind !== "present") return;
    expect(obs.phase).toEqual({ kind: "unknown", raw: "HIBERNATING" });
  });

  it("unknown: a thrown read is never absence", async () => {
    const obs = await observe(
      makeObserveDeps(async () => {
        throw new RailwayAuthError("Railway rejected credentials (HTTP 401)");
      }),
    );
    expect(obs.kind).toBe("unknown");
    expect(obs.kind).not.toBe("absent");
  });

  it("unknown reason carries the error class name and message", async () => {
    const obs = await observe(
      makeObserveDeps(async () => {
        throw new RailwayRateLimitError("Railway rate limited the read (HTTP 429)");
      }),
    );
    expect(obs.kind).toBe("unknown");
    if (obs.kind !== "unknown") return;
    expect(obs.reason).toContain("RailwayRateLimitError");
    expect(obs.reason).toContain("Railway rate limited the read (HTTP 429)");
  });

  it("unknown reason never contains the token", async () => {
    const obs = await observe(
      makeObserveDeps(async () => {
        throw new RailwayAuthError("Railway rejected credentials (HTTP 401): [redacted]");
      }),
    );
    expect(obs.kind).toBe("unknown");
    if (obs.kind !== "unknown") return;
    expect(obs.reason).not.toContain(TOKEN);
  });

  it("unknown: even a non-Error throw classifies instead of escaping", async () => {
    const obs = await observe(
      makeObserveDeps(async () => {
        // A string on purpose: the wild throws non-Errors too.
        throw "string failure";
      }),
    );
    expect(obs.kind).toBe("unknown");
    if (obs.kind !== "unknown") return;
    expect(obs.reason).toContain("string failure");
  });

  it("version increments monotonically across observations, failures included", async () => {
    let call = 0;
    const deps = makeObserveDeps(async () => {
      call += 1;
      if (call === 2) throw new RailwayAuthError("blip");
      return managedProject("SUCCESS");
    });
    const first = await observe(deps);
    const second = await observe(deps);
    const third = await observe(deps);
    expect(first.version).toBe(1);
    expect(second.version).toBe(2);
    expect(third.version).toBe(3);
  });

  it("observedAt comes from the injected clock", async () => {
    const obs = await observe(makeObserveDeps(async () => managedProject("SUCCESS")));
    expect(obs.observedAt).toBe(CLOCK_MS);
  });
});

function makeBootDeps(
  desired: DesiredPresence | null,
  read: ObserveDeps["getProjectServices"],
): BootDeps {
  return {
    ...makeObserveDeps(read),
    intentStore: {
      load: async () =>
        desired === null ? null : { desired, updatedAt: "2026-07-18T00:00:00.000Z" },
    },
  };
}

describe("reconcileOnBoot resume rules", () => {
  it("intent null + observation present: adopt reality, none (never auto-delete without recorded intent)", async () => {
    const { snapshot, resumeAction } = await reconcileOnBoot(
      makeBootDeps(null, async () => managedProject("SUCCESS")),
    );
    expect(resumeAction).toBe("none");
    expect(snapshot.intent).toBeNull();
    expect(snapshot.observation.kind).toBe("present");
  });

  it("intent ABSENT + observation present: resume-delete (the no-leak guarantee surviving restart)", async () => {
    const { resumeAction } = await reconcileOnBoot(
      makeBootDeps("ABSENT", async () => managedProject("SUCCESS")),
    );
    expect(resumeAction).toBe("resume-delete");
  });

  it("intent ABSENT + present mid-removal still resumes the delete", async () => {
    const { resumeAction } = await reconcileOnBoot(
      makeBootDeps("ABSENT", async () => managedProject("REMOVING")),
    );
    expect(resumeAction).toBe("resume-delete");
  });

  it("intent PRESENT + present with zero deployments: trigger-deploy (died before serviceInstanceDeploy)", async () => {
    const { resumeAction } = await reconcileOnBoot(
      makeBootDeps("PRESENT", async () => managedProject(null)),
    );
    expect(resumeAction).toBe("trigger-deploy");
  });

  it("intent PRESENT + observation absent: resume-create", async () => {
    const { resumeAction } = await reconcileOnBoot(
      makeBootDeps("PRESENT", async () => ({ services: [] })),
    );
    expect(resumeAction).toBe("resume-create");
  });

  it("observation unknown: retry-observe (never act blind)", async () => {
    const { snapshot, resumeAction } = await reconcileOnBoot(
      makeBootDeps("PRESENT", async () => {
        throw new RailwayAuthError("boom");
      }),
    );
    expect(resumeAction).toBe("retry-observe");
    expect(snapshot.observation.kind).toBe("unknown");
  });

  it("otherwise: intent PRESENT + present running converges to none", async () => {
    const { resumeAction } = await reconcileOnBoot(
      makeBootDeps("PRESENT", async () => managedProject("SUCCESS")),
    );
    expect(resumeAction).toBe("none");
  });

  it("otherwise: intent ABSENT + observation absent is already converged, none", async () => {
    const { resumeAction } = await reconcileOnBoot(
      makeBootDeps("ABSENT", async () => ({ services: [] })),
    );
    expect(resumeAction).toBe("none");
  });

  it("snapshot starts with deleteAttempts 0 and the loaded intent", async () => {
    const { snapshot } = await reconcileOnBoot(
      makeBootDeps("ABSENT", async () => managedProject("SUCCESS")),
    );
    expect(snapshot.deleteAttempts).toBe(0);
    expect(snapshot.intent).toBe("ABSENT");
  });
});
