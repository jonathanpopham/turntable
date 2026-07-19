# Turntable

[![ci](https://github.com/jonathanpopham/turntable/actions/workflows/ci.yml/badge.svg)](https://github.com/jonathanpopham/turntable/actions/workflows/ci.yml)

Spins one container up, spins it down, and refuses to do anything else.

A single-slot control plane for one container on [Railway](https://railway.com), built
against their public GraphQL API. A turntable is the rotating platform inside a
roundhouse; it turns exactly one locomotive at a time.

This is the second iteration of the design. The first ([roundhouse](https://github.com/jonathanpopham/roundhouse))
proved the engine; a sibling implementation built independently by a different
agent stack ([roundhouse-codex](https://github.com/jonathanpopham/roundhouse-codex))
converged on the same invariants with a better auth model. Turntable keeps the
deeper engine and adopts the better auth. Reviewing rival implementations and
merging the winner from each is the workflow; the repos are the evidence.

## Status

Built, tested, and deployed on Railway. The deployed URL is shared privately
rather than printed here: the button spends money, and an unlisted URL behind a
passphrase is part of the abuse posture. `scripts/smoke.sh` proves the deployed
app end to end (up to running, down to observed absence, then an independent
GraphQL check that zero managed services remain).

## Reading order

1. `src/transitions.ts`: the pure model. Intent, observation, and derived view
   as separate axes; every decision is a total function over them. Start here.
2. `src/engine.ts`: the composition root. Durable intent, the coalescing status
   cache, the single-flight lock, and the delete loop assembled behind
   boot/status/up/down.
3. `src/reconciler.ts` and `src/delete-loop.ts`: how observed reality is
   classified, and how teardown refuses to trust acceptance.
4. `src/gql-request.ts`, `src/gql-guards.ts`, `src/operations.ts`: the typed
   transport (mutations never retried), runtime guards on all wire data, and
   the four bounded verbs this app is allowed to say to Railway.
5. `src/server.ts` and `src/main.ts`: the hardened HTTP shell and the only file
   with side effects.
6. `src/view-model.ts` and `src/client.ts`: the UI as a pure view model plus a
   thin DOM layer, with the login flow that owns its own credential.
7. `test/fake-railway.ts` and `test/failure-injection.test.ts`: the
   production-faithful double and the proofs behind the table below.

## Decisions

Every axis this design pins on purpose, and what unpinning it would cost.

| Axis | Pinned at | Why |
|---|---|---|
| Slot count | 1 | The spec says "a container." One slot removes fleets, races, and list UX. The engine takes a slot as a parameter, which exposes the seam without pretending multi-slot is free (see roadmap). |
| Image | hardcoded, digest-pinned | No user input means no input validation and no abuse surface. The only thing the UI accepts is intent. |
| Blast radius | one dedicated Railway project, project-scoped token | The runtime credential can only touch the one target project, and the code only ever references one project id and one service name. |
| State | derived from Railway | On boot and on ambiguity the app reconciles against the API by deterministic service name. Local memory is a cache; their API is the truth. |
| Durable intent | desired presence only | Railway cannot tell a restarted process what the user wanted. Desired PRESENT or ABSENT is the one fact persisted (atomic write on a Railway volume), so an unfinished teardown resumes across restarts. |
| Mutations | never blindly retried | After a lost response the app reconciles and looks instead of firing again. Reads get timeouts and bounded retries; writes get checked. |
| Concurrency | single-flight + decision table | One lifecycle operation at a time; same-direction commands coalesce; the only 409 is up against an active teardown. |
| Teardown | the sacred path | Delete acceptance is not completion: the app stays in a deleting state until it observes absence, retries with backoff, and says so in the UI. |
| Status transport | polling | Recursive setTimeout, never setInterval, so slow ticks cannot stack. Concurrent reads coalesce on one upstream request; mutations invalidate before acknowledging. |
| Auth | login form, Bearer passphrase | The UI owns its credential: a login view, sessionStorage for the tab's lifetime, and an Authorization header on every fetch. Browsers do not reliably reattach basic-auth credentials to fetch calls, so the app never leans on the browser's credential cache. Adopted from the sibling implementation, which got this right. |
| Runtime dependencies | justified only | Dependencies are welcome when they earn their place. The gate fails on any runtime dependency that lacks a justification in the Dependencies section below. Currently zero, because node:http and native fetch covered everything this app needed. |

Style note: iteration is written as explicit loops rather than array method chains.
Single pass, zero intermediate allocations, and `reduce` is banned outright. Compiler
settings mirror Railway's own TypeScript SDK: `strict`, `exactOptionalPropertyTypes`,
`noUncheckedIndexedAccess`.

## Dependencies

Runtime: none yet. Any that lands gets a row here with its reason; the gate
(`scripts/verify.sh`) fails on a runtime dependency this section does not name.

Dev-only (not shipped): `typescript`, `vitest`, `@types/node`, `eslint`,
`typescript-eslint`.

## Run it

```bash
npm ci
bash scripts/verify.sh   # typecheck, build, lint, tests, dep justification
cp .env.example .env     # fill in your Railway token and target project
npm run build && npm start
```

Open `http://localhost:3000` and enter `APP_PASSWORD` at the login view.

Unit and integration tests (247 across 15 files) are offline and never call
Railway; `test/fake-railway.ts` is a production-faithful double, down to the
duplicate-name error message and the project-token no-auto-deploy quirk, both
verified against the live API first (`docs/schema-notes.md` records the full
API archaeology). The live smoke is a separate manual workflow, exercises the
deployed app through its authenticated routes, and always tears down.

## Roadmap

What this would grow into, in the order things would actually break:

1. One slot to ten: the engine is parameterized so the seam exists, but real
   multi-slot needs per-slot locking, routing, cardinality enforcement, and a list
   UI, which is more than a data change.
2. Ten to a hundred: batch the status query, then move from polling to webhooks.
3. One instance to many: the single-flight lock is in-process memory. Partition slots
   by owner, or take leases in Postgres, or hand the reconciler to a durable workflow
   engine. This is the first rung where adding a database is justified rather than
   speculative.
4. One user to tenants: identity, quotas, per-tenant projects, TTL policies. At
   tenant scale, cost safety is the product.
5. Ten times the ops volume: per-transition latency metrics, idempotency keys, an
   append-only action log.

## Lineage

Patterns here are minimal forms of things I maintain elsewhere: the gate follows
[gatekit](https://github.com/jonathanpopham/gatekit), the reconcile-and-verify
posture comes from [lockstep](https://github.com/jonathanpopham/lockstep), and the
audit instincts from [ghostie-rs](https://github.com/jonathanpopham/ghostie-rs).
The auth model is adopted from [roundhouse-codex](https://github.com/jonathanpopham/roundhouse-codex),
the independently built sibling of this design.
