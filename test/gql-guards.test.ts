// Guard tests: every extractor against valid shapes, malformed shapes, and the
// facts-not-errors cases (zero deployments, unknown statuses). Fully offline.
import { describe, expect, it } from "vitest";
import {
  DEPLOYMENT_STATUSES,
  isGqlEnvelope,
  isRecord,
  parseDeploymentStatus,
  readProjectServices,
  readServiceCreate,
  readServiceDelete,
} from "../src/gql-guards.js";

// Wire-shape builders matching docs/schema-notes.md.
function projectBody(edges: unknown): unknown {
  return { data: { project: { services: { edges } } } };
}

function serviceEdge(id: string, name: string, deploymentEdges: unknown): unknown {
  return { node: { id, name, deployments: { edges: deploymentEdges } } };
}

function deploymentEdge(id: string, status: string, createdAt: string): unknown {
  return { node: { id, status, createdAt } };
}

describe("isRecord", () => {
  it("accepts plain objects only", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
    expect(isRecord(null)).toBe(false);
    expect(isRecord(undefined)).toBe(false);
    expect(isRecord([])).toBe(false);
    expect(isRecord("x")).toBe(false);
    expect(isRecord(42)).toBe(false);
  });
});

describe("isGqlEnvelope", () => {
  it("accepts envelopes with optional data and errors", () => {
    expect(isGqlEnvelope({})).toBe(true);
    expect(isGqlEnvelope({ data: null })).toBe(true);
    expect(isGqlEnvelope({ data: { ok: 1 }, errors: [] })).toBe(true);
    expect(isGqlEnvelope({ errors: [{ message: "boom" }] })).toBe(true);
  });

  it("rejects non-objects and non-array errors", () => {
    expect(isGqlEnvelope(null)).toBe(false);
    expect(isGqlEnvelope("ok")).toBe(false);
    expect(isGqlEnvelope(42)).toBe(false);
    expect(isGqlEnvelope([])).toBe(false);
    expect(isGqlEnvelope({ errors: "boom" })).toBe(false);
    expect(isGqlEnvelope({ errors: { message: "boom" } })).toBe(false);
  });
});

describe("parseDeploymentStatus", () => {
  it("returns every known status as itself", () => {
    expect(DEPLOYMENT_STATUSES).toHaveLength(13);
    for (const status of DEPLOYMENT_STATUSES) {
      expect(parseDeploymentStatus(status)).toBe(status);
    }
  });

  it("preserves unknown statuses with their raw value instead of throwing them away", () => {
    expect(parseDeploymentStatus("PAUSED")).toEqual({ kind: "unknown", raw: "PAUSED" });
    expect(parseDeploymentStatus("")).toEqual({ kind: "unknown", raw: "" });
    // Case-sensitive: the API speaks SCREAMING_SNAKE, anything else is unknown.
    expect(parseDeploymentStatus("success")).toEqual({ kind: "unknown", raw: "success" });
  });
});

describe("readServiceCreate", () => {
  it("extracts id and name from a valid response", () => {
    const body: unknown = { data: { serviceCreate: { id: "s-1", name: "roundhouse-slot-0" } } };
    expect(readServiceCreate(body)).toEqual({ id: "s-1", name: "roundhouse-slot-0" });
  });

  it("returns null for malformed shapes", () => {
    expect(readServiceCreate(null)).toBeNull();
    expect(readServiceCreate("not an envelope")).toBeNull();
    expect(readServiceCreate({})).toBeNull();
    expect(readServiceCreate({ data: null })).toBeNull();
    expect(readServiceCreate({ data: {} })).toBeNull();
    expect(readServiceCreate({ data: { serviceCreate: null } })).toBeNull();
    expect(readServiceCreate({ data: { serviceCreate: { id: 7, name: "x" } } })).toBeNull();
    expect(readServiceCreate({ data: { serviceCreate: { id: "s-1" } } })).toBeNull();
  });
});

describe("readServiceDelete", () => {
  it("extracts the boolean, keeping false distinct from malformed", () => {
    expect(readServiceDelete({ data: { serviceDelete: true } })).toBe(true);
    expect(readServiceDelete({ data: { serviceDelete: false } })).toBe(false);
  });

  it("returns null for malformed shapes", () => {
    expect(readServiceDelete(null)).toBeNull();
    expect(readServiceDelete({})).toBeNull();
    expect(readServiceDelete({ data: null })).toBeNull();
    expect(readServiceDelete({ data: {} })).toBeNull();
    expect(readServiceDelete({ data: { serviceDelete: "true" } })).toBeNull();
    expect(readServiceDelete({ data: { serviceDelete: 1 } })).toBeNull();
  });
});

describe("readProjectServices", () => {
  it("extracts services with their latest deployment", () => {
    const body = projectBody([
      serviceEdge("s-1", "roundhouse-slot-0", [
        deploymentEdge("d-1", "SUCCESS", "2026-07-18T10:00:00.000Z"),
      ]),
    ]);
    expect(readProjectServices(body)).toEqual({
      services: [
        {
          id: "s-1",
          name: "roundhouse-slot-0",
          latestDeployment: { id: "d-1", status: "SUCCESS", createdAt: "2026-07-18T10:00:00.000Z" },
        },
      ],
    });
  });

  it("yields latestDeployment null for a service with zero deployments", () => {
    const body = projectBody([serviceEdge("s-1", "roundhouse-slot-0", [])]);
    expect(readProjectServices(body)).toEqual({
      services: [{ id: "s-1", name: "roundhouse-slot-0", latestDeployment: null }],
    });
  });

  it("returns an empty services list for a project with no services", () => {
    expect(readProjectServices(projectBody([]))).toEqual({ services: [] });
  });

  it("picks the deployment with max createdAt instead of trusting edge order", () => {
    const body = projectBody([
      serviceEdge("s-1", "roundhouse-slot-0", [
        deploymentEdge("d-old", "REMOVED", "2026-07-18T09:00:00.000Z"),
        deploymentEdge("d-new", "SUCCESS", "2026-07-18T12:00:00.000Z"),
        deploymentEdge("d-mid", "FAILED", "2026-07-18T11:00:00.000Z"),
      ]),
    ]);
    const result = readProjectServices(body);
    expect(result?.services[0]?.latestDeployment).toEqual({
      id: "d-new",
      status: "SUCCESS",
      createdAt: "2026-07-18T12:00:00.000Z",
    });
  });

  it("keeps a raw unknown status as data for the caller to classify", () => {
    const body = projectBody([
      serviceEdge("s-1", "roundhouse-slot-0", [
        deploymentEdge("d-1", "SOME_FUTURE_STATUS", "2026-07-18T10:00:00.000Z"),
      ]),
    ]);
    const result = readProjectServices(body);
    const status = result?.services[0]?.latestDeployment?.status;
    expect(status).toBe("SOME_FUTURE_STATUS");
    expect(parseDeploymentStatus(status ?? "")).toEqual({
      kind: "unknown",
      raw: "SOME_FUTURE_STATUS",
    });
  });

  it("returns null for malformed top-level shapes", () => {
    expect(readProjectServices(null)).toBeNull();
    expect(readProjectServices("nope")).toBeNull();
    expect(readProjectServices({})).toBeNull();
    expect(readProjectServices({ data: null })).toBeNull();
    expect(readProjectServices({ data: {} })).toBeNull();
    expect(readProjectServices({ data: { project: null } })).toBeNull();
    expect(readProjectServices({ data: { project: {} } })).toBeNull();
    expect(readProjectServices({ data: { project: { services: {} } } })).toBeNull();
    expect(readProjectServices({ data: { project: { services: { edges: "x" } } } })).toBeNull();
  });

  it("returns null when a service node is malformed", () => {
    expect(readProjectServices(projectBody(["not an edge"]))).toBeNull();
    expect(readProjectServices(projectBody([{ node: null }]))).toBeNull();
    expect(
      readProjectServices(projectBody([{ node: { id: 7, name: "x", deployments: { edges: [] } } }])),
    ).toBeNull();
    expect(readProjectServices(projectBody([{ node: { id: "s-1", deployments: { edges: [] } } }]))).toBeNull();
    // deployments field missing or misshapen is malformed, not "zero deployments".
    expect(readProjectServices(projectBody([{ node: { id: "s-1", name: "x" } }]))).toBeNull();
    expect(
      readProjectServices(projectBody([{ node: { id: "s-1", name: "x", deployments: { edges: "x" } } }])),
    ).toBeNull();
  });

  it("returns null when a deployment node is malformed", () => {
    expect(readProjectServices(projectBody([serviceEdge("s-1", "x", ["bad"])]))).toBeNull();
    expect(readProjectServices(projectBody([serviceEdge("s-1", "x", [{ node: null }])]))).toBeNull();
    expect(
      readProjectServices(
        projectBody([serviceEdge("s-1", "x", [{ node: { id: "d-1", status: "SUCCESS" } }])]),
      ),
    ).toBeNull();
    expect(
      readProjectServices(
        projectBody([
          serviceEdge("s-1", "x", [{ node: { id: "d-1", status: 5, createdAt: "2026-07-18T10:00:00.000Z" } }]),
        ]),
      ),
    ).toBeNull();
  });
});
