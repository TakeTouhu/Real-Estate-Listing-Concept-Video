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
| `createBillingCycleRevenueReader(prisma)` | a `BillingCycleRevenueReader` reading the organization's entitlement period for the cycle key, its Unit purchases and their cancellations in one statement; `null` when the organization has no period for the cycle |

### Changed

Nothing. `BillingCycleRevenueReader` and `createUnavailableBillingCycleRevenueReader`
keep their signatures; only their documentation changed.
