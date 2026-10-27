# ADR-0089 — The route table and price catalog are passed in

Status: Accepted (GS-5a-1, 2026-10-27). First of GS-5's pull requests in the
generation-to-preview plan the product owner approved on 2026-10-26
(`/mnt/project-files/cto/generation-e2e-proposal.md`, row GS-5 and its first
risk: "the test route must never reach production").
Builds on: ADR-0054 Decisions 2 and 3 (only verified routes; the Cost Safety
Guard), ADR-0088 (the start's quality offer).

## Context

GS-5 gives the test provider a route, a price and a catalog entry outside
production, so that a development start can cross the paid-submission gate
the way a real one will. Three things stood in the way, all module constants:

- `authorizeRoute` read `AUTHORIZED_ROUTES` and `AUTHORIZED_QUALITY_TIERS`
  directly, so the only way to authorize another route was to add it to
  production's table;
- the start's quality offer (ADR-0088) read `AUTHORIZED_QUALITY_TIERS`, so HQ
  could be offered only by changing it for production too;
- the paid-submission repository verified every pricing snapshot against
  `createProviderPricingCatalog()`, production's contracts, called inside the
  repository.

Adding the test route to those tables, guarded at the point of use, would put
it in production's build, one forgotten guard from production. The plan says
it must be registered only outside production.

## Decision 1 — A route policy

`RoutePolicy` is a route table and the qualities it serves, under one version:
`{ version, qualityTiers, routes }`. `PRODUCTION_ROUTE_POLICY` is built from the
existing constants and nothing else, and frozen. `authorizeRoute(facts,
policy)` authorizes against the policy given, and against production's when
none is.

- **A policy is the whole table.** Production's routes are not added to
  another policy implicitly; a policy outside production lists them itself if
  it wants them.
- **Forgetting it fails closed.** The default is production's, which refuses
  every route it does not list, so a caller that forgets to pass the test
  route's policy refuses the test route rather than authorizing anything.

## Decision 2 — The gate and the service

`evaluatePaidSubmissionGate(facts, routePolicy)` authorizes the route against
the policy, production's when none is given. The service takes
`routePolicy` as an optional dependency and passes it on. The authorization
record's `routingPolicyVersion` is now the version of the policy the route
was authorized against, carried out of the gate in the audit block, rather
than the production constant: a record must name the table that let it
through.

## Decision 3 — The start's quality offer

`routeQualityOffer(policy)` offers the qualities a policy serves.
`AUTHORIZED_ROUTE_QUALITY_OFFER` is production's, unchanged: Normal only. A
composition that passes one policy to both the start and the gate answers HQ
the same way in both.

## Decision 4 — The price catalog

`createPaidSubmissionAuthorizationRepository(prisma, { pricing })` verifies
snapshots against the catalog given, production's when none is. Production's
catalog is never changed: `extendProviderPricingCatalog(added)` builds a new
one holding production's contracts and the added ones, frozen, and refuses an
added contract that shares an identity with one of production's or with
another added one, as production's table refuses a duplicate at load.

## Decision 5 — Nothing is passed yet

Nothing outside tests builds a policy or catalog other than production's.
GS-5a-2's factory will, refusing production. No route changed, so
`ROUTING_POLICY_VERSION` is not bumped, and production behaves exactly as
before.

## Not decided here

- **The test route itself**: its catalog entry, route, price, FX rate and the
  factory that refuses production (GS-5a-2).
- **A billing cycle's revenue** (GS-5b). No ADR defined it; the product owner
  decided it on 2026-10-27 (`docs/decisions/TODO.md`, decision gates closed),
  and GS-5b's reader will build it.

## Consequences

- `@app/domain` exports `RoutePolicy`, `PRODUCTION_ROUTE_POLICY`,
  `routeQualityOffer` and `extendProviderPricingCatalog`. `authorizeRoute`,
  `evaluatePaidSubmissionGate` and `PaidSubmissionAuthorizationDeps` gain the
  optional policy; `PaidSubmissionAuthorizationAudit` gains
  `routingPolicyVersion`.
- `@app/database` exports `PaidSubmissionAuthorizationRepositoryOptions`, and
  `createPaidSubmissionAuthorizationRepository` takes it.
- No migration, no route, no page; nothing a customer can see changes.
