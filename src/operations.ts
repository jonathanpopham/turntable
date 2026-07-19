// The only three things this app ever asks Railway to do. Fixed verbs, fixed
// image, fixed service name: the API surface is bounded by construction, and
// the server never forwards arbitrary GraphQL.
import { gqlRequest, RailwayApiError } from "./gql-request.js";
import type { GqlConfig, GqlRequestDeps } from "./gql-request.js";
import {
  isGqlEnvelope,
  isRecord,
  readProjectServices,
  readServiceCreate,
  readServiceDelete,
} from "./gql-guards.js";
import type { ProjectServicesResult } from "./gql-guards.js";

/**
 * Digest-pinned so the image tested before the interview is byte-identical to
 * the image during it (nginx:alpine multi-arch index, fetched 2026-07-18).
 * The tag@digest form is load-bearing: a bare digest reference is accepted by
 * serviceCreate but silently creates a service that never deploys (verified
 * live 2026-07-18).
 */
export const MANAGED_IMAGE =
  "nginx:alpine@sha256:4a73073bd557c65b759505da037898b61f1be6cbcc3c2c3aeac22d2a470c1752";

/**
 * Deterministic name is the reconciliation key. Railway rejects duplicate
 * service names inside a project (verified live), so lookup by this name can
 * never be ambiguous and a re-fired create fails safe.
 */
export const MANAGED_SERVICE_NAME = "roundhouse-managed";

export interface Target {
  projectId: string;
  environmentId: string;
}

const CREATE_QUERY = `mutation ($projectId: String!, $environmentId: String!, $name: String!, $image: String!) {
  serviceCreate(input: { projectId: $projectId, environmentId: $environmentId, name: $name, source: { image: $image } }) {
    id
    name
  }
}`;

// One request per poll. The dedicated project holds at most one service by
// construction (single slot, duplicate names rejected), so pagination cannot
// hide a match; deployments(first: 5) plus max-createdAt selection in the
// guard covers ordering without trusting it.
const STATUS_QUERY = `query ($projectId: String!) {
  project(id: $projectId) {
    services {
      edges {
        node {
          id
          name
          deployments(first: 5) {
            edges {
              node {
                id
                status
                createdAt
              }
            }
          }
        }
      }
    }
  }
}`;

const DELETE_QUERY = `mutation ($id: String!, $environmentId: String!) {
  serviceDelete(id: $id, environmentId: $environmentId)
}`;

const DEPLOY_QUERY = `mutation ($serviceId: String!, $environmentId: String!) {
  serviceInstanceDeploy(serviceId: $serviceId, environmentId: $environmentId)
}`;

/**
 * Create the managed container. Account-token creates auto-deploy; PROJECT-token
 * creates do not (verified live 2026-07-18: the service sits with zero
 * deployments forever). The engine therefore always follows create with an
 * explicit deployService, which is deterministic across token types.
 */
export async function createService(
  config: GqlConfig,
  target: Target,
  deps?: GqlRequestDeps,
): Promise<{ id: string; name: string }> {
  const body = await gqlRequest(
    config,
    {
      query: CREATE_QUERY,
      variables: {
        projectId: target.projectId,
        environmentId: target.environmentId,
        name: MANAGED_SERVICE_NAME,
        image: MANAGED_IMAGE,
      },
      kind: "mutation",
    },
    deps,
  );
  const result = readServiceCreate(body);
  if (result === null) {
    throw new RailwayApiError("serviceCreate response did not match the expected shape", {
      retryable: false,
    });
  }
  return result;
}

/** One read covering everything the reconciler needs to observe. */
export async function getProjectServices(
  config: GqlConfig,
  target: Target,
  deps?: GqlRequestDeps,
): Promise<ProjectServicesResult> {
  const body = await gqlRequest(
    config,
    { query: STATUS_QUERY, variables: { projectId: target.projectId }, kind: "read" },
    deps,
  );
  const result = readProjectServices(body);
  if (result === null) {
    throw new RailwayApiError("project services response did not match the expected shape", {
      retryable: false,
    });
  }
  return result;
}

/**
 * Trigger the first deployment of a created service. Required when the create
 * ran under a project token; harmless double-trigger is avoided by the engine
 * calling this exactly once per create.
 */
export async function deployService(
  config: GqlConfig,
  target: Target,
  serviceId: string,
  deps?: GqlRequestDeps,
): Promise<boolean> {
  const body = await gqlRequest(
    config,
    {
      query: DEPLOY_QUERY,
      variables: { serviceId, environmentId: target.environmentId },
      kind: "mutation",
    },
    deps,
  );
  const result = readBooleanMutation(body, "serviceInstanceDeploy");
  if (result === null) {
    throw new RailwayApiError("serviceInstanceDeploy response did not match the expected shape", {
      retryable: false,
    });
  }
  return result;
}

// Shared shape for Railway's boolean-returning mutations: { data: { <field>: boolean } }.
function readBooleanMutation(body: unknown, field: string): boolean | null {
  if (!isGqlEnvelope(body) || !isRecord(body.data)) return null;
  const value = body.data[field];
  return typeof value === "boolean" ? value : null;
}

/**
 * Request deletion. Acceptance, not completion: Railway returns true when the
 * delete is queued. Callers stay in a deleting state until a subsequent
 * getProjectServices observes absence.
 */
export async function deleteService(
  config: GqlConfig,
  target: Target,
  serviceId: string,
  deps?: GqlRequestDeps,
): Promise<boolean> {
  const body = await gqlRequest(
    config,
    {
      query: DELETE_QUERY,
      variables: { id: serviceId, environmentId: target.environmentId },
      kind: "mutation",
    },
    deps,
  );
  const result = readServiceDelete(body);
  if (result === null) {
    throw new RailwayApiError("serviceDelete response did not match the expected shape", {
      retryable: false,
    });
  }
  return result;
}
