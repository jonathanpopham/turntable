// Runtime type guards for Railway GraphQL responses. Wire data enters as
// `unknown` and leaves through these functions or not at all: no `as` casts of
// network payloads anywhere. Extractors return a typed value or null; null
// means "this body does not have the shape the schema notes promise", and the
// caller decides whether that is a reconcile or an alarm.
//
// Style: explicit loops over array-method chains; single pass, zero
// intermediate allocations (see README "Decisions").

/** Narrow to a plain object usable with string-key indexing. Arrays excluded. */
export function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

/** The GraphQL response envelope: both keys optional, `errors` an array when present. */
export interface GqlEnvelope {
  data?: unknown;
  errors?: unknown[];
}

export function isGqlEnvelope(x: unknown): x is GqlEnvelope {
  if (!isRecord(x)) return false;
  if ("errors" in x && !Array.isArray(x["errors"])) return false;
  return true;
}

// The 13 DeploymentStatus values probed live 2026-07-18 (docs/schema-notes.md).
// The enum grew before (6 -> 13); it will grow again, so unknown values are
// preserved as data rather than thrown away.
export const DEPLOYMENT_STATUSES = [
  "BUILDING",
  "CRASHED",
  "DEPLOYING",
  "FAILED",
  "INITIALIZING",
  "NEEDS_APPROVAL",
  "QUEUED",
  "REMOVED",
  "REMOVING",
  "SKIPPED",
  "SLEEPING",
  "SUCCESS",
  "WAITING",
] as const;

export type KnownDeploymentStatus = (typeof DEPLOYMENT_STATUSES)[number];

export interface UnknownDeploymentStatus {
  kind: "unknown";
  raw: string;
}

/**
 * Classify a raw status string. Known values narrow to the literal union; an
 * unrecognized value comes back tagged with its raw text so callers can
 * surface it verbatim and reconcile instead of guessing.
 */
export function parseDeploymentStatus(raw: string): KnownDeploymentStatus | UnknownDeploymentStatus {
  // 13 fixed entries: a linear scan is cheaper than a Set and, unlike
  // `Set.has`, the `===` comparison narrows the type with zero casts.
  for (const known of DEPLOYMENT_STATUSES) {
    if (known === raw) return known;
  }
  return { kind: "unknown", raw };
}

export interface ServiceCreateResult {
  id: string;
  name: string;
}

/** Latest deployment snapshot; `status` stays raw here - parseDeploymentStatus classifies it. */
export interface DeploymentSnapshot {
  id: string;
  status: string;
  createdAt: string;
}

export interface ServiceSnapshot {
  id: string;
  name: string;
  /** null = the service exists with zero deployments. An observable fact, not an error. */
  latestDeployment: DeploymentSnapshot | null;
}

export interface ProjectServicesResult {
  services: ServiceSnapshot[];
}

/** Extract `data.serviceCreate` from a serviceCreate mutation response. */
export function readServiceCreate(body: unknown): ServiceCreateResult | null {
  if (!isGqlEnvelope(body) || !isRecord(body.data)) return null;
  const node = body.data["serviceCreate"];
  if (!isRecord(node)) return null;
  const id = node["id"];
  const name = node["name"];
  if (typeof id !== "string" || typeof name !== "string") return null;
  return { id, name };
}

/**
 * Extract the bare Boolean from a serviceDelete mutation response. `false` is
 * a real answer (delete refused), distinct from null (malformed body).
 */
export function readServiceDelete(body: unknown): boolean | null {
  if (!isGqlEnvelope(body) || !isRecord(body.data)) return null;
  const result = body.data["serviceDelete"];
  return typeof result === "boolean" ? result : null;
}

// Sentinel distinguishing "this service has no deployments" (a fact, -> null)
// from "this body is malformed" (-> the whole extraction returns null).
const MALFORMED: unique symbol = Symbol("malformed");

function latestDeploymentOf(deployments: unknown): DeploymentSnapshot | null | typeof MALFORMED {
  if (!isRecord(deployments)) return MALFORMED;
  const edges = deployments["edges"];
  if (!Array.isArray(edges)) return MALFORMED;
  let latest: DeploymentSnapshot | null = null;
  for (const edge of edges) {
    if (!isRecord(edge)) return MALFORMED;
    const node = edge["node"];
    if (!isRecord(node)) return MALFORMED;
    const id = node["id"];
    const status = node["status"];
    const createdAt = node["createdAt"];
    if (typeof id !== "string" || typeof status !== "string" || typeof createdAt !== "string") {
      return MALFORMED;
    }
    // Pick max createdAt explicitly instead of trusting edge order. Railway's
    // timestamps are uniform ISO 8601, which compares correctly as strings.
    if (latest === null || createdAt > latest.createdAt) {
      latest = { id, status, createdAt };
    }
  }
  return latest;
}

/**
 * Extract the per-poll project snapshot: every service with its most recent
 * deployment (by max createdAt), or latestDeployment null for a service with
 * zero deployments. Any shape violation anywhere returns null for the whole
 * body - a half-parsed control-plane snapshot is worse than none.
 */
export function readProjectServices(body: unknown): ProjectServicesResult | null {
  if (!isGqlEnvelope(body) || !isRecord(body.data)) return null;
  const project = body.data["project"];
  if (!isRecord(project)) return null;
  const servicesField = project["services"];
  if (!isRecord(servicesField)) return null;
  const edges = servicesField["edges"];
  if (!Array.isArray(edges)) return null;

  const services: ServiceSnapshot[] = [];
  for (const edge of edges) {
    if (!isRecord(edge)) return null;
    const node = edge["node"];
    if (!isRecord(node)) return null;
    const id = node["id"];
    const name = node["name"];
    if (typeof id !== "string" || typeof name !== "string") return null;
    const latestDeployment = latestDeploymentOf(node["deployments"]);
    if (latestDeployment === MALFORMED) return null;
    services.push({ id, name, latestDeployment });
  }
  return { services };
}
