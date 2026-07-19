# Railway GQL schema notes (probed live 2026-07-18)

Endpoint: `https://backboard.railway.com/graphql/v2`, header `Authorization: Bearer <RAILWAY_API_TOKEN>`.
Everything below verified against the live API, not docs.

## Mutations

```graphql
serviceCreate(input: ServiceCreateInput!): Service
# input fields used: projectId, environmentId, name, source { image }
# Behavior depends on the TOKEN TYPE (round 2 finding): under an account token,
# an image create auto-deploys (SUCCESS in ~5s); under a project token the
# service is created with zero deployments and stays that way until an explicit
# serviceInstanceDeploy. The app always triggers explicitly, so behavior is
# deterministic across token types.

serviceInstanceDeploy(serviceId: String!, environmentId: String!): Boolean
# Kicks the first deployment of a pending service. Verified working under a
# project token (SUCCESS ~8s after trigger).

serviceDelete(id: String!, environmentId: String): Boolean
# Returns a bare Boolean. Treat as a REQUEST, not a completion: the status enum
# includes REMOVING/REMOVED, so deletion is a process. DELETING state polls the
# project until the service is absent from services.edges. Observed: gone within
# ~3 seconds in the happy path.
```

Also present if ever needed: `serviceInstanceDeploy`, `environmentTriggersDeploy`.
`projectCreate` requires `workspaceId` (workspace: `me { workspaces { id } }`).

## Read path (one query per poll)

```graphql
query {
  project(id: $projectId) {
    services {
      edges {
        node {
          id
          name
          deployments(first: 1) {
            edges { node { id status createdAt } }
          }
        }
      }
    }
  }
}
```

A service can exist with zero deployments for a beat; treat empty deployments as
its own observable fact, not an error.

## DeploymentStatus: 13 values, not 6

```
BUILDING, CRASHED, DEPLOYING, FAILED, INITIALIZING, NEEDS_APPROVAL,
QUEUED, REMOVED, REMOVING, SKIPPED, SLEEPING, SUCCESS, WAITING
```

Mapping for the state machine:

| API status | Engine reading |
|---|---|
| QUEUED, WAITING, INITIALIZING, BUILDING, DEPLOYING | CREATING (surface the phase verbatim in the UI) |
| SUCCESS | RUNNING |
| FAILED, CRASHED | FAILED (with the status named) |
| REMOVING | DELETING |
| REMOVED, service absent | IDLE |
| SLEEPING | RUNNING variant (app-sleep feature); surface as "sleeping" |
| NEEDS_APPROVAL, SKIPPED | should not occur for image deploys; treat as FAILED-with-reason and reconcile |
| anything unknown | defensive: reconcile, surface raw status. The enum grew before; it will grow again. |

## Behavioral probe round 2 (2026-07-18)

- **Introspection is masked.** `Service.deployments` works in live queries but is
  absent from `__type(name: "Service")`. Trust live queries, not introspection.
- **Duplicate service names are rejected server-side**: "A service named X already
  exists in this project." Name-based reconciliation cannot be ambiguous inside one
  project, and an accidentally re-fired create fails safe.
- **Visibility delay after create: ~660ms** to appear in `project.services`. Sub-second,
  but nonzero: the reconciler treats brief absence-after-create as expected.
- **Redeploy replaces rather than stacks**: after `serviceInstanceRedeploy`,
  `deployments(first: 5)` still returned one row. Ordering therefore unproven; the
  client picks max `createdAt` from returned edges instead of trusting order.
- **Project tokens authorize everything we need**: `projectTokenCreate(projectId,
  environmentId, name)` returns a token that, sent as the `Project-Access-Token`
  header, performs read, serviceCreate, and serviceDelete in that environment.
  Runtime uses a project token: credential blast radius shrinks from the whole
  account to the one target project. Account token stays local-only for probes.
- **Image pinned by digest, tag@digest form required.** The runtime image is
  `nginx:alpine@sha256:4a73073bd557c65b759505da037898b61f1be6cbcc3c2c3aeac22d2a470c1752`.
  A bare digest reference (`nginx@sha256:...`) is ACCEPTED by serviceCreate but
  silently creates a service with zero deployments, forever. The tag@digest form
  deploys normally (SUCCESS in ~8s, verified live). This silent failure mode is
  why "service present with no deployment" is a first-class observation in the
  state model rather than an error.

## Environment facts

- Workspace: "<workspace>" `<workspace-id>`
- Target project: `roundhouse-target` `<target-project-id>`
- Target environment: `production` `<target-environment-id>`
- Full live cycle proven 2026-07-18: create to SUCCESS ~5s, delete to absent ~3s.
