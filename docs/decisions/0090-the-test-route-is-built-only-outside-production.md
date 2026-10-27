# ADR-0090 — The test route is built only outside production

Status: Accepted (GS-5a-2, 2026-10-27). Second of GS-5's pull requests in the
generation-to-preview plan the product owner approved on 2026-10-26
(`/mnt/project-files/cto/generation-e2e-proposal.md`, row GS-5 and its first
risk: "the test route must never reach production").
Builds on: ADR-0089 (the route table and price catalog are passed in),
ADR-0085 (the shared folder storage, refused in production), ADR-0054
Decisions 2, 3 and 7 (only verified routes; the Cost Safety Guard; paid
activation BLOCKED).

## Context

ADR-0089 let a composition pass a route policy and a price catalog other than
production's. Nothing builds one yet, so a development start still cannot
cross the paid-submission gate: the test provider has no route, no price and
no catalog entry, and there is no exchange rate to convert a price with.

The test route must exist in development and CI and nowhere else. Adding it to
production's tables, even behind a guard at the point of use, would put it one
forgotten guard from production.

## Decision 1 — One factory, in the provider package

`createFakeRouteKit(env)` in `@app/video-providers`, beside the fake provider,
returns everything the test route needs: a model catalog, a route policy, the
start's quality offer, a price catalog and an exchange rate. Nothing else
hands any of it out, and production's tables are not changed.

The kit lives in the provider package, not the domain: its model id and its
prices are facts about one provider, and the domain stays provider-neutral.

## Decision 2 — Refused in production, with no override

The factory throws `CONFIGURATION_ERROR` when the given `NODE_ENV` is
`production`, when the process's own `NODE_ENV` is (the given value cannot
vouch for the ambient one), and when `VIDEO_PROVIDER` is not `fake`. There is
no flag that lifts either check, as for the shared folder storage (ADR-0085).

`VIDEO_PROVIDER` defaults to `fake` everywhere, production included, so it is
checked as well as `NODE_ENV`, never instead of it.

## Decision 3 — Two routes, each generated at its own size

| Quality | Native | Target | Mode | Audio |
| --- | --- | --- | --- | --- |
| Normal | 720p | 720p | image-to-video | none |
| HQ | 1080p | 1080p | image-to-video | none |

The quality follows the project's resolution, as the start already decides
(ADR-0088). The policy is built by `defineRoutePolicy` under its own version,
`dev-test-route.1`, so an authorization record names the table that let it
through.

**The policy holds no production route.** A composition given the kit's policy
refuses every paid provider's route, so the test route can never become a way
to authorize a paid call.

The start's quality offer is built from the same policy and handed out with
it, so the start never offers a quality the gate then refuses (ADR-0089
Decision 3).

## Decision 4 — Its own model catalog

The kit's catalog holds the test provider's entry alone, as its default. It is
selectable, generates each target natively (no upscale, so nothing claims a
size it was not generated at), and takes 5 to 15 seconds, production's default
model's range, so a storyboard composed for one fits the other.
Production's catalog (`createVideoModelCatalog()`) does not list it.

## Decision 5 — A nominal price, and a rate named as no market rate

Two contracts, one per native size, under the test provider's name and the
route's version: one cent a second, `VERIFIED_STABLE`, billed continuously from
5 to 15 seconds. The fake provider is never paid. The price exists so the Cost
Safety Guard has a cost to weigh, the same arithmetic a real route takes; no
customer sees a provider price.

The contracts are added to a copy of production's catalog
(`extendProviderPricingCatalog`); production's is unchanged. They name their
own provider, so no production route gains a second current contract
(ADR-0089, *Not decided here*).

The exchange rate is fixed at ¥150 per dollar, with an id and a source that
name it as a development rate, not a market one. The paid-submission
repository records it on first use and compares it field by field after, so
the one id always carries the one rate.

## Decision 6 — Nothing builds it yet

The pipeline command (GS-9) and the start route (GS-10) will be its first
callers. A test lists every production source file that names the factory,
today only its own package, and each caller adds itself when it is reviewed.

## Not decided here

- **A billing cycle's revenue** (GS-5b). Until its reader, the Safety Guard
  still pauses every paid submission, the test route's included.
- **What the fake provider returns**: a status and a clip's bytes (GS-6).

## Consequences

- `@app/video-providers` exports `createFakeRouteKit`, `FakeRouteKit`,
  `FAKE_ROUTE_VERSION`, `FAKE_VIDEO_MODEL_ID` and `FAKE_VIDEO_MODEL_KEY`.
- No migration, no route, no page, and no change to production's route
  policy, model catalog or price catalog.
