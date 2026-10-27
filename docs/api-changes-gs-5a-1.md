# API Changes — GS-5a-1

The route table and price catalog are passed in (ADR-0089). **No migration;
no route and no page.** Nothing outside tests passes anything but production's.

## HTTP

No change.

## Internal API

### Added: `@app/domain`

| Export | What it is |
| --- | --- |
| `RoutePolicy` | `{ version, qualityTiers, routes }`: a route table and the qualities it serves |
| `PRODUCTION_ROUTE_POLICY` | production's: `ROUTING_POLICY_VERSION`, `AUTHORIZED_QUALITY_TIERS` and the authorized routes, frozen |
| `defineRoutePolicy(policy)` | a policy outside production, as a frozen copy; throws on an empty or production's version, a quality listed with no route, a route whose quality is not listed, or a quality listed twice |
| `servesQualityTier(policy, tier)` | whether a policy lists a quality and has a route for it |
| `routeQualityOffer(policy)` | the start's quality offer for a policy: the qualities it serves (`servesQualityTier`) |
| `extendProviderPricingCatalog(added)` | a new catalog holding production's contracts and `added`, frozen; throws on a duplicate identity |

### Changed: `@app/domain`

- `authorizeRoute(facts, policy?)`: authorizes against `policy`, production's
  when it is left out.
- `evaluatePaidSubmissionGate(facts, routePolicy?)`: the same, for the route
  step. `PaidSubmissionAuthorizationAudit` gains `routingPolicyVersion`, the
  version of the policy used.
- `PaidSubmissionAuthorizationDeps` gains `routePolicy?`, passed to the gate.
  The authorization record's `routingPolicyVersion` is the audit's.
- `AUTHORIZED_ROUTE_QUALITY_OFFER` is `routeQualityOffer(PRODUCTION_ROUTE_POLICY)`:
  Normal only, as before.

### Changed: `@app/database`

- `createPaidSubmissionAuthorizationRepository(prisma, options?)`:
  `options.pricing` is the catalog snapshots are verified against,
  production's when it is left out. `PaidSubmissionAuthorizationRepositoryOptions`
  is exported.
