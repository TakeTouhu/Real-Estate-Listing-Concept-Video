# API Changes — GS-5b

A billing cycle's revenue is read from its period (ADR-0091). **No migration;
no route and no page.** Nothing outside tests constructs the paid-submission
service yet.

## HTTP

No change.

## Internal API

### Added: `@app/domain`

| Export | What it is |
| --- | --- |
| `billingCycleRevenueYen(facts, plans?)` | the cycle's revenue in yen, tax-exclusive: the plan's monthly price plus every uncancelled purchase's price; `null` for Enterprise and for a plan the catalog does not hold; throws past a safe integer. `plans` defaults to the customer plan catalog |
| `BillingCycleRevenueFacts` | `{ planKey, purchases: { priceYenExTax, cancelled }[] }`, the period's plan and every purchase approved on it |

### Added: `@app/database`

| Export | What it is |
| --- | --- |
| `readBillingCycleRevenueWithin(tx, { organizationId, billingCycleKey })` | the cycle's revenue, reading the organization's entitlement period for the cycle key, its Unit purchases and their cancellations in one statement on the given transaction; `null` when the organization has no period for the cycle and for an Enterprise period |

### Changed

| Where | Change |
| --- | --- |
| `PaidSubmissionAuthorizationSession` (`@app/domain`) | gains `readBillingCycleRevenue()`: the revenue of the cycle the session holds the lock for, `null` when unknown |
| `PaidSubmissionAuthorizationDeps` (`@app/domain`) | loses `billingCycleRevenue`: the gate reads revenue from its session |
| `createPaidSubmissionAuthorizationRepository(prisma, options)` (`@app/database`) | `options.revenue`, a `BillingCycleRevenueReader`, replaces the read of the cycle's period: a fixed figure in a test, or the unavailable reader where the gate must fail closed. Left out, the session reads the period on the gate's transaction |

`BillingCycleRevenueReader` and `createUnavailableBillingCycleRevenueReader`
keep their signatures; only their documentation changed.
