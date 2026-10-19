# Completion — additional Unit packages (Unit purchase)

Branch: `claude/project-thread-az06z2`
ADRs: `docs/decisions/0066-plan-provisioning-and-units-overview.md` (UP-1),
`docs/decisions/0067-unit-purchase-record-and-approval.md` (UP-2)
Gap analysis: `docs/unit-purchase-gap-analysis.md`

Unit purchase is built in four pull requests, approved by the product owner on
2026-10-16 with purchased Units usable as soon as the customer approves and
invoiced afterwards:

1. **UP-1**: an organization gets its contract's plan, and the Units page.
2. **UP-2**: the purchase record and its one-transaction grant.
3. **UP-3**: the purchase screen.
4. **UP-4**: the purchase list and the invoicing export.

Each extends this record. Unit purchase is not a Roadmap phase, so it receives
no `phase-N-complete` tag.

## UP-1 — a plan from the contract, and the Units page

Base: `a60a76d` (PR #88 merge commit on `main`).

Commits, oldest first:

| Commit | What it carries |
| --- | --- |
| `1863464` | the operator command (`apps/ops`), operator attribution in the provisioning audit, `UnitsOverviewService` and its in-memory reader, the Units page and the dashboard link, their unit, shape and database tests, ADR-0066 and the documentation updates |
| `2cb625f` | this record |
| this commit | an MFA database test made independent of row order (below), and this record |

The exact head SHA is reported with the pull request rather than written into a
file that would have to contain its own hash.

### What UP-1 does

- **An operator gives an organization its contract's plan.**
  `pnpm --filter @app/ops provision-subscription` writes the organization's one
  subscription from the contract:
  - its plan, its start (the renewal anchor, an instant with an explicit offset
    that is checked against the calendar) and the contract number;
  - always `SALES_ASSISTED`, named `sub_<organization id>`;
  - the audit entry records the operator and the reason, with no actor user.

  Running it again with the same contract writes nothing. Anything different is
  refused and shows what the organization already has. Exit codes are 0, 1 and
  2. The command lives in its own package, which neither application depends
  on (ADR-0066 Decisions 1 and 2).
- **The Units page** (`/organizations/{id}/units`, linked from the dashboard)
  shows a holder of `unit.view`:
  - the plan;
  - the current period's bounds in Japan time, and that nothing carries over;
  - the Base Units left, and how many can still fund HQ;
  - each additional block, oldest first, with what is left of it, and the
    quality lock;
  - when the plan sells no HQ package, that it does not.

  `billing.view` adds how the plan is paid and its monthly price, labelled as
  excluding tax. Without a plan, the page says VTaVision sets it up when the
  contract starts; before the start, it says when. Viewing writes nothing
  (ADR-0066 Decision 3).

Behaviour anyone can notice:
- a "Units and plan" link under each organization on the dashboard;
- the page, which says "no plan yet" until an operator runs the command.

Nothing is bought, charged, reserved or opened.

### Giving a plan, then viewing it

```mermaid
sequenceDiagram
  autonumber
  participant O as Operator
  participant C as provision-subscription
  participant DB as PostgreSQL
  participant M as Member (unit.view)
  participant P as Units page
  participant S as UnitsOverviewService

  O->>C: --organization --plan --starts --contract --operator --reason
  C->>C: parse; every option required; the start checked against the calendar
  C->>DB: BEGIN; INSERT subscription sub_<org> (SALES_ASSISTED)
  C->>DB: INSERT audit subscription.provisioned {operator, reason}; COMMIT
  alt the organization already has exactly this plan
    DB-->>C: replay: nothing written, exit 0
  else it has a different one
    C->>DB: read what it has
    C-->>O: refused, showing it; nothing written, exit 1
  end
  M->>P: GET /organizations/{id}/units
  P->>S: overview(user, organization)
  S->>DB: membership and effective permissions (unit.view, else FORBIDDEN)
  S->>DB: subscription; the ledger's period containing now
  alt a period is open
    S->>DB: its balance and blocks
  else no period yet
    S->>S: the current period as it would open: the plan's whole allowance
  end
  S-->>P: plan, period, Units left; billing only with billing.view
  Note over S,DB: nothing written: no period opened, no audit
```

### Verification

Measured on `1863464` (local PostgreSQL 16, configured like CI); the commit
after it changes this record only.

| Check | Result |
| --- | --- |
| `pnpm lint` / `pnpm typecheck` | clean, `apps/ops` included |
| `pnpm test` | **5385 / 5385**, 186 files (was 5283 on `a60a76d`) |
| `pnpm test:db` | **1375 / 1376**, 50 files: the one failure is the known race below |
| `pnpm build` | succeeded; `/organizations/[organizationId]/units` is listed |
| `prisma migrate diff` (migrations → schema) | no difference |
| `prisma migrate status` | 27 migrations, up to date |
| the command, end to end | run against a scratch organization: provisioned (exit 0), replay by another operator wrote nothing (exit 0), a different plan refused and the plan held shown (exit 1), 30 February refused (exit 2); one subscription and one audit row naming the operator and reason; then removed |

Every full database run failed one test, *gives two PROCESSING runners one
history and at most one transfer*. It is the known race recorded in `TODO.md`
since Phase 6F. The losing runner answers `OUTPUT_VERIFICATION_REPLAYED`, which
the test does not expect. UP-1 does not touch that code, and the failure is not
UP-1's:

- this time the file failed on its own too: 5 runs of 5 on this branch;
- on `main` (`a60a76d`, in a separate worktree) it failed 2 runs of 3.

It fails more often on this machine than in earlier records, which found it
mostly after other database files. The test-only fix is recorded in `TODO.md`
and needs its own pull request. One earlier full run on this code stopped
with a test-runner IPC error (`ERR_IPC_CHANNEL_CLOSED`) while the build ran
alongside it; run alone, it gave the result above.

CI run 567 on `1863464` passed both jobs, the database job included.

**CI run 569 on `2cb625f` failed one database test that UP-1 did not write:**
`mfa.db.test.ts`, "sets up, passes by authenticator and by recovery code,
replaces codes and turns off, auditing each". It read the two
`mfa.challenge_passed` audit rows with no order and expected the authenticator
pass first. Both rows carry the same instant, so PostgreSQL may return them
either way. This time it returned the recovery-code row first. The values were
right. UP-1 adds rows to the same table and deletes them again, which can change
where PostgreSQL places new rows and so the order in which an unordered read
returns them. The test now sorts the two rows by method before comparing. A
local run with the rows deliberately reversed passes. No product code changes.

CI on the pull request's exact head is reported with the pull request.

New tests:
- **the overview** (`units-overview.test.ts`, 27): who may see it, by role and
  by grant; billing facts only with `billing.view`; no plan, not started, an
  unopened period (the start at the anchor itself), an opened one; HQ fundable
  as the smaller of the Base Units and the ceiling left; blocks oldest first and
  ties by id; only the period containing now; an unreadable balance; nothing
  written;
- **provisioning** (`subscription.test.ts`, 2 more): a blank operator name or
  reason is invalid; the sales-contract call;
- **the command** (`provision-subscription.test.ts`, 52): every option
  required, trimmed and length-limited; unknown options and positionals
  refused; impossible dates, times and offsets refused, a leap day accepted;
  every outcome's exit code and message;
- **the page** (`units-page.test.tsx`, 11) and the wording helpers (3): sign-in,
  a refusal that names nothing, an unexpected failure not passed off as a
  refusal, each state, billing by role, the block list, the dashboard link;
- **shape** (`units-overview-shape.test.ts`, 6, and the Phase 6B dormancy test
  rewritten): no migration; the readers open, grant and provision nothing;
  provisioning only from the command; the command kept out of both applications
  and free of timers, network calls and payment processors;
- **live PostgreSQL** (`units-provisioning.db.test.ts`, 9): the subscription and
  its audit entry, operator and reason trimmed; replay and refusal write
  nothing; a missing organization; the overview before and after the command,
  before the start, with an opened period and blocks, and its refusals.

### Mutation ledger

**49 run, 48 killed, 1 survivor (equivalent), 0 broken, 0 anchor-missing**,
in one pass on the code of `1863464`. Each mutant weakens one guarantee at an
anchor that occurs exactly once. The suites:

- **domain**: the entitlement tests, including the overview, provisioning and
  shape tests (116 tests);
- **ops**: the command's tests (52);
- **web**: the Units page and the wording helpers (14);
- **db**: the provisioning and subscription database tests (29).

Each mutant runs against the suites listed for it until one fails. Every mutated
file was restored and re-hashed, and all 842 files were byte-identical
afterwards.

**C04 survived, and is equivalent.** It lets the command's own calendar check
accept minute 60. `Date` already rejects that instant: `new
Date("2026-11-01T23:60:00Z")` is `NaN`, and so are second 60 and offset hours
24 or minutes 60. So the command still refuses it, and the test for
`23:60` still passes. The same holds for the second and offset checks, which
have no mutant. Hour 24 is the field `Date` accepts, as the next day's midnight,
and C02 shows the explicit check catches it. The redundant checks are kept so
the rule does not depend on how a JavaScript engine parses dates.

| Mutant | Area | What it breaks | File | Tests failing |
| --- | --- | --- | --- | --- |
| O01 | who may | any member sees the Units, unit.view not required | `units-overview.ts` | 1 of 14 (web) |
| O02 | who may | billing facts shown to every holder of unit.view | `units-overview.ts` | 1 of 14 (web) |
| O03 | who may | billing facts never shown | `units-overview.ts` | 2 of 14 (web) |
| O04 | numbers | ledger HQ fundable ignores the Base Units left | `units-overview.ts` | 2 of 116 (domain) |
| O05 | numbers | unopened period's HQ fundable is the whole Base allowance | `units-overview.ts` | 2 of 116 (domain) |
| O06 | order | blocks not sorted oldest first | `units-overview.ts` | 1 of 116 (domain) |
| O07 | order | ties broken by id in reverse | `units-overview.ts` | 1 of 116 (domain) |
| O08 | numbers | Normal total counts HQ blocks | `units-overview.ts` | 1 of 116 (domain) |
| O09 | period | an unreadable balance is not an internal error | `units-overview.ts` | 1 of 116 (domain) |
| O10 | period | the ledger's period is ignored | `units-overview.ts` | 8 of 116 (domain) |
| O11 | period | a plan not yet started is shown as no plan | `units-overview.ts` | 1 of 116 (domain) |
| O12 | numbers | an unopened period shows no Base Unit left | `units-overview.ts` | 2 of 116 (domain) |
| O13 | numbers | an unopened Standard period claims to sell HQ packages | `units-overview.ts` | 1 of 116 (domain) |
| O14 | period | the unopened period is computed at the anchor, not now | `units-overview.ts` | 3 of 116 (domain) |
| S01 | operator | a blank operator name or reason is accepted | `subscription.ts` | 1 of 116 (domain) |
| S02 | operator | a blank reason is accepted | `subscription.ts` | 1 of 116 (domain) |
| S03 | channel | an operator provisions a self-service subscription | `subscription.ts` | 1 of 116 (domain) |
| S04 | replay | each run names a new subscription, so a replay is not one | `subscription.ts` | 1 of 116 (domain) |
| S05 | audit | the operator is not passed to the audit entry | `subscription.ts` | 1 of 116 (domain) |
| S06 | operator | the anchor is not the contract start | `subscription.ts` | 1 of 116 (domain) |
| R01 | audit | the audit entry drops the operator and reason | `subscription-repository.ts` | 2 of 29 (db) |
| R02 | audit | the operator's name is stored untrimmed | `subscription-repository.ts` | 1 of 29 (db) |
| C01 | validation | a day past the month's end is accepted | `provision-subscription.ts` | 3 of 52 (ops) |
| C02 | validation | hour 24 is accepted | `provision-subscription.ts` | 1 of 52 (ops) |
| C03 | validation | a start without an offset is accepted | `provision-subscription.ts` | 1 of 52 (ops) |
| C04 | validation | minute 60 is accepted | `provision-subscription.ts` | **survived: equivalent** (below) |
| C05 | validation | the organization id length is not limited | `provision-subscription.ts` | 1 of 52 (ops) |
| C06 | validation | the reason length is not limited | `provision-subscription.ts` | 1 of 52 (ops) |
| C07 | validation | a blank option counts as given | `provision-subscription.ts` | 9 of 52 (ops) |
| C08 | validation | unknown options are ignored | `provision-subscription.ts` | 1 of 52 (ops) |
| C09 | validation | positional arguments are ignored | `provision-subscription.ts` | 1 of 52 (ops) |
| C10 | validation | the plan is not checked | `provision-subscription.ts` | 6 of 52 (ops) |
| C11 | exit | a conflict exits 0 | `provision-subscription.ts` | 2 of 52 (ops) |
| C12 | exit | a replay exits 1 | `provision-subscription.ts` | 1 of 52 (ops) |
| C13 | exit | a missing organization exits 0 | `provision-subscription.ts` | 1 of 52 (ops) |
| C14 | message | the refusal names the channels the other way round | `provision-subscription.ts` | 2 of 52 (ops) |
| C15 | message | the refusal does not show what the organization has | `provision-subscription.ts` | 2 of 52 (ops) |
| P01 | page | a signed-out visitor is not sent to sign in | `units/page.tsx` | 1 of 14 (web) |
| P02 | page | any failure is shown as a refusal | `units/page.tsx` | 1 of 14 (web) |
| P03 | page | fundable HQ shown as the unused ceiling | `units/page.tsx` | 1 of 14 (web) |
| P04 | page | the HQ-not-sold note is inverted | `units/page.tsx` | 2 of 14 (web) |
| P05 | page | the empty-block note never shows | `units/page.tsx` | 1 of 14 (web) |
| P06 | page | the NOT_STARTED plan omits its start | `units/page.tsx` | 1 of 14 (web) |
| P07 | page | the expiry warning is dropped | `units/page.tsx` | 1 of 14 (web) |
| V01 | wording | times shown in UTC, labelled JST | `units-view.ts` | 4 of 14 (web) |
| V02 | wording | prices not labelled as excluding tax | `units-view.ts` | 3 of 14 (web) |
| V03 | wording | HQ named otherwise | `units-view.ts` | 2 of 14 (web) |
| V04 | wording | invoice-paid shown as card-paid | `units-view.ts` | 3 of 14 (web) |
| D01 | dashboard | the dashboard links elsewhere | `src/app/page.tsx` | 1 of 14 (web) |


### Required documentation

| Item | Where |
| --- | --- |
| Architecture diagram | `docs/architecture.md` status table: `apps/ops` and Units overview rows |
| Entity-relationship diagram | Not applicable: UP-1 changes no table or column |
| Critical sequence diagram | this section, *Giving a plan, then viewing it* |
| OpenAPI / API change summary | `docs/api-changes-up-1.md`: one page, no HTTP API; internal `UnitsOverviewService`, `provisionFromSalesContract`, `OperatorAttribution` (`@app/domain`) |
| Change log / release notes | the commit list above and the pull request description |
| Database migration notes | `docs/migration-notes.md`, *UP-1*: no migration |
| Completion report | this file |

Also updated: `docs/Roadmap.md`, `docs/decisions/TODO.md` (the closed purchase
decision, the operator console, the 6B dormancy note) and `docs/local-setup.md`
(how to run the command).

### Activation status

Nothing paid or scheduled is activated. UP-1 adds an operator command and a
read-only page: no migration, worker, scheduler, credential, environment
variable or payment integration. Its new development dependencies are `tsx` and
`@types/node`, for the command. Paid Provider Activation, production
credentials, the production scheduler and live Stripe charges remain BLOCKED.

### Known limitations

- **The operator's name is declared, not authenticated.** Anyone with the
  database credentials can run the command under any name. An operator console
  with its own sign-in replaces it (`TODO.md`).
- **The command cannot change a plan.** A plan change, an Enterprise transition
  or a corrected start date needs later work.
- **A `VIEWER` sees the dashboard link** and is told they cannot view the page
  (ADR-0066 Consequences).
- **An unopened period is computed from the catalog.** A later catalog revision
  would change what such a period shows, which is what opening it would then
  freeze.
- Nothing yet opens a period for a reservation; generation is not wired to a
  route.

### Remaining work

UP-1 waits for the product owner's yes before merge. Next: UP-2, the purchase
record (migration 27) and its one-transaction grant.

## UP-2 — the purchase record, approved in one transaction

Base: `2f8b79d` (PR #89 merge commit on `main`).
ADR: `docs/decisions/0067-unit-purchase-record-and-approval.md`

Commits, oldest first:

| Commit | What it carries |
| --- | --- |
| `b6d912a` | the approved package prices in the catalog, migration 27 (`unit_purchases`), `UnitPurchaseService` and its in-memory repository, `createUnitPurchaseRepository`, the shared block insert and group-permission read, their unit, shape and database tests, the migration-count tripwires, ADR-0067 and the documentation updates |
| this commit | this record |

The exact head SHA is reported with the pull request.

### What UP-2 does

- **The approved prices are in the catalog.** Each plan carries the price of
  its Normal package and, where it sells one, its HQ package, excluding tax:
  Standard ¥19,900 (none), Premium ¥35,900 and ¥9,000, Enterprise ¥89,400 and
  ¥22,400. A test pins each to the package price formula (ADR-0067
  Decision 1).
- **A purchase is a record.** `unit_purchases` (migration 27) holds, for each
  approved purchase, the block it bought, its period and quality, the price, how
  it is paid and under which contract, the idempotency key, who approved it and
  when. One block is bought once; a purchase can only belong to a block of its
  own period, quality and organization; the evidence is `RESTRICT`ed and the
  approver is not a foreign key (Decision 2).
- **`UnitPurchaseService.approve`** buys one package for a holder of
  `billing.manage` (Decision 3):
  - it refuses, and audits, what it must: no plan, not started, Enterprise
    (through sales), a card-paid plan (card payment is not built), HQ on
    Standard, Units or a price that are not the catalog's, and a period whose end
    is not the one shown;
  - a replay of the same approval returns the purchase and writes nothing; a key
    reused for anything else is refused;
  - it opens the current period if nothing has yet, because the block must join
    it.
- **One transaction** (Decision 4): under the period's cost-admission lock it
  looks up the key, reads the approver's membership `FOR SHARE` with its grants
  and its groups' permissions, reads the subscription, runs the same domain
  check on what it read, then writes the block, its
  `entitlement.add_on_block_granted` entry, the purchase and its
  `unit_purchase.approved` entry. Any failure writes none of them.

Nothing calls it yet: no route, page or command (Decision 5). The purchase
screen is UP-3. Nothing is charged.

### Approving a purchase

```mermaid
sequenceDiagram
  autonumber
  participant R as Caller (UP-3's route)
  participant S as UnitPurchaseService
  participant L as Unit ledger
  participant DB as PostgreSQL

  R->>S: approve(user, {quality, expected units, price, period end, key})
  S->>S: validate the request (else VALIDATION_FAILED)
  S->>DB: membership and effective permissions
  alt not a member
    S-->>R: FORBIDDEN (unaudited)
  else no billing.manage
    S->>DB: audit unit_purchase.refused LACKS_BILLING_MANAGE
    S-->>R: FORBIDDEN
  end
  S->>DB: the purchase holding the key, if any
  alt found
    S-->>R: ALREADY_APPROVED, or REFUSED IDEMPOTENCY_KEY_REUSED (audited)
  end
  S->>DB: the subscription
  S->>S: check the plan and the offer (refusals audited, nothing opened)
  S->>L: renewEntitlementPeriod (opens the current period if none)
  S->>DB: BEGIN
  S->>DB: the period, by id and organization
  S->>DB: cost-admission advisory lock (the period's)
  S->>DB: the key again: a winner is returned, nothing written
  S->>DB: the approver's membership FOR SHARE, grants, group permissions
  S->>DB: the subscription
  S->>S: the same check on what was read here
  alt refused
    S->>DB: COMMIT, nothing written
    S->>DB: audit unit_purchase.refused
    S-->>R: REFUSED (or FORBIDDEN when the permission went)
  else allowed
    S->>DB: INSERT block + audit entitlement.add_on_block_granted
    S->>DB: INSERT purchase + audit unit_purchase.approved
    S->>DB: COMMIT
    S-->>R: APPROVED: the purchase, its Units and its expiry
  end
  Note over S,DB: two periods, one key: the unique index decides, the loser re-reads the winner
```

### Verification

Measured on `b6d912a` (local PostgreSQL 16, configured like CI); the commit
after it changes this record only.

| Check | Result |
| --- | --- |
| `pnpm lint` / `pnpm typecheck` | clean |
| `pnpm test` | **5446 / 5446**, 188 files (was 5385 on `2f8b79d`) |
| `pnpm test:db` | **1401 / 1401**, 51 files (was 1376, 50 files) |
| `pnpm build` | succeeded |
| `prisma migrate diff` (migrations → schema) | no difference |
| `prisma migrate status` | 28 migrations, up to date |

The known race in *gives two PROCESSING runners one history and at most one
transfer* (`TODO.md`, since Phase 6F) did not occur in this run.

CI on the pull request's exact head is reported with the pull request.

New tests:
- **the catalog** (`customer-pricing.test.ts`, 4): each plan's approved package
  prices, and their agreement with the package price formula;
- **the purchase** (`unit-purchase.test.ts`, 46): the offers; who may buy, by
  role and by grant, a member's refusal audited and an outsider's not; what a
  purchase writes; every plan, offer and period refusal; replay, including after the
  period has ended, and a key reused for something else; the re-check inside
  the write (a removed approver, another approval taking the key first, the
  facts read there, a lost period, a period that cannot be opened);
  validation; the pure check (priced from the period's plan, the anchor
  inclusive);
- **shape** (`unit-purchase-shape.test.ts`, 11): migration 27 the newest and
  additive only, with its keys and checks; dormant; one transaction, the lock
  first, the check before every write, the membership share lock; one
  block-insert path; no payment processor, network call or timer;
- **live PostgreSQL** (`unit-purchase.db.test.ts`, 25): the purchase, its block
  and both audit entries in one transaction, and nothing at all when the
  database refuses the purchase row; a double submit and a same-key race into
  two periods buying once; the HQ package; keys per organization; the
  approver's permission by role, by grant and by group, read inside the
  transaction; the check seeing the period's plan and the contract; another
  organization's period not found; the composite keys refusing another
  quality or organization, a block bought twice, a zero price, an empty
  contract and an empty or over-long key; a deleted user leaving the purchase; `RESTRICT` on the block
  and the organization.

Sixteen existing test files that count migrations, or name the newest, now
expect migration 27.

### Mutation ledger

**69 run, 69 killed, 0 survivors, 0 broken, 0 anchor-missing**, in one pass on
the code of `b6d912a`. Each mutant weakens one guarantee at an anchor that
occurs exactly once. The suites:

- **domain**: the entitlement and pricing tests, including the purchase and
  shape tests (348 tests);
- **db**: the purchase database tests (25);
- **ledger-db**: the Unit ledger database tests (33), for the shared block
  insert;
- **groups-db**: the group permission database tests, listed for G01 after
  **db**, which killed it first.

Each mutant runs against the suites listed for it until one fails. Every mutated
file was restored and re-hashed, and all 852 files were byte-identical
afterwards.

**D01 (no cost-admission lock) and D07 (no share lock on the approver's
membership) are killed by the shape test only.** The races they open need two
transactions interleaved at one exact point, which a test cannot force
reliably, so the lock order is pinned structurally instead, as for the ledger's
grants and reservations. The same-key race into two periods, which does not
depend on that timing, is exercised against PostgreSQL and killed D17.

| Mutant | Area | What it breaks | File | Tests failing |
| --- | --- | --- | --- | --- |
| C01 | price | Standard Normal package priced ¥20,000 | `customer-plan-catalog.ts` | 5 of 348 (domain) |
| C02 | price | Premium HQ package priced at the unrounded ¥8,985 | `customer-plan-catalog.ts` | 5 of 348 (domain) |
| C03 | price | Enterprise HQ package rounded down to ¥22,300 | `customer-plan-catalog.ts` | 3 of 348 (domain) |
| C04 | price | Standard given an HQ package price | `customer-plan-catalog.ts` | 2 of 348 (domain) |
| F01 | offer | a Normal package charged the monthly price | `unit-purchase.ts` | 22 of 348 (domain) |
| F02 | offer | an HQ package sells the Normal package's Units | `unit-purchase.ts` | 4 of 348 (domain) |
| F03 | offer | a plan with no HQ package offers one | `unit-purchase.ts` | 3 of 348 (domain) |
| R01 | who | the check ignores billing.manage | `unit-purchase.ts` | 2 of 348 (domain) |
| R02 | who | an approver no longer a member passes the check | `unit-purchase.ts` | 2 of 348 (domain) |
| R03 | plan | the plan starts only after its anchor | `unit-purchase.ts` | 1 of 348 (domain) |
| R04 | plan | the package priced from the subscription, not the period's frozen plan | `unit-purchase.ts` | 1 of 348 (domain) |
| R05 | plan | Enterprise bought in the app | `unit-purchase.ts` | 2 of 348 (domain) |
| R06 | plan | a card-paid plan bought by invoice | `unit-purchase.ts` | 1 of 348 (domain) |
| R07 | offer | the Units shown are not compared | `unit-purchase.ts` | 1 of 348 (domain) |
| R08 | offer | the price shown is not compared | `unit-purchase.ts` | 1 of 348 (domain) |
| R09 | period | the period shown is not compared | `unit-purchase.ts` | 2 of 348 (domain) |
| R10 | offer | a package the plan does not sell passes | `unit-purchase.ts` | 2 of 348 (domain) |
| P01 | replay | another approver's purchase counts as a replay | `unit-purchase.ts` | 2 of 348 (domain) |
| P02 | replay | another quality counts as a replay | `unit-purchase.ts` | 3 of 348 (domain) |
| P03 | replay | other Units count as a replay | `unit-purchase.ts` | 1 of 348 (domain) |
| P04 | replay | another price counts as a replay | `unit-purchase.ts` | 2 of 348 (domain) |
| P05 | replay | another expiry counts as a replay | `unit-purchase.ts` | 1 of 348 (domain) |
| P06 | replay | the replay compares the purchase's own approver | `unit-purchase.ts` | 1 of 348 (domain) |
| V01 | validation | an empty key accepted | `unit-purchase.ts` | 1 of 348 (domain) |
| V02 | validation | an over-long key accepted | `unit-purchase.ts` | 1 of 348 (domain) |
| V03 | validation | a 200-character key refused | `unit-purchase.ts` | 1 of 348 (domain) |
| V04 | validation | fractional Units accepted | `unit-purchase.ts` | 1 of 348 (domain) |
| V05 | validation | a fractional price accepted | `unit-purchase.ts` | 1 of 348 (domain) |
| V06 | validation | an invalid expiry accepted | `unit-purchase.ts` | 1 of 348 (domain) |
| V07 | validation | the key limit raised to 201 | `unit-purchase.ts` | 1 of 348 (domain) |
| A01 | who | no billing.manage check before reading | `unit-purchase.ts` | 4 of 348 (domain) |
| A02 | replay | no replay lookup before the plan checks | `unit-purchase.ts` | 3 of 348 (domain) |
| A03 | plan | a refused plan still opens the period | `unit-purchase.ts` | 4 of 348 (domain) |
| A04 | period | a period the ledger could not open is bought into | `unit-purchase.ts` | 1 of 348 (domain) |
| A05 | re-check | the write is not re-checked | `unit-purchase.ts` | 3 of 348 (domain) |
| A06 | record | the price recorded is not the one approved | `unit-purchase.ts` | 4 of 348 (domain) |
| A07 | record | the channel recorded is not the subscription's | `unit-purchase.ts` | 1 of 348 (domain) |
| A08 | record | the contract recorded is not the subscription's | `unit-purchase.ts` | 1 of 348 (domain) |
| A09 | record | the approval instant is not now | `unit-purchase.ts` | 1 of 348 (domain) |
| A10 | replay | a key written first by another approval answered as approved | `unit-purchase.ts` | 1 of 348 (domain) |
| A11 | audit | a refusal under the lock neither audited nor forbidden | `unit-purchase.ts` | 2 of 348 (domain) |
| A12 | period | a lost period answered as a refusal | `unit-purchase.ts` | 1 of 348 (domain) |
| A13 | who | a member without billing.manage is refused but not forbidden | `unit-purchase.ts` | 5 of 348 (domain) |
| A14 | audit | the refusal's reason not recorded | `unit-purchase.ts` | 15 of 348 (domain) |
| A15 | audit | the refusal's expiry not recorded | `unit-purchase.ts` | 5 of 348 (domain) |
| D01 | lock | no cost-admission lock | `unit-purchase-repository.ts` | 1 of 348 (domain) |
| D02 | replay | no key lookup under the lock | `unit-purchase-repository.ts` | 1 of 25 (db) |
| D03 | who | the approver read as an OWNER | `unit-purchase-repository.ts` | 2 of 25 (db) |
| D04 | who | individual grants ignored | `unit-purchase-repository.ts` | 1 of 25 (db) |
| D05 | who | group permissions ignored | `unit-purchase-repository.ts` | 1 of 25 (db) |
| D06 | who | a removed approver read as holding billing.manage | `unit-purchase-repository.ts` | 2 of 25 (db) |
| D07 | lock | the approver's membership not share-locked | `unit-purchase-repository.ts` | 1 of 348 (domain) |
| D08 | re-check | the check sees no subscription | `unit-purchase-repository.ts` | 9 of 25 (db) |
| D09 | re-check | a refused purchase is written anyway | `unit-purchase-repository.ts` | 4 of 25 (db) |
| D10 | write | the block holds one Unit | `unit-purchase-repository.ts` | 4 of 25 (db) |
| D11 | write | the block names the key, not the purchase | `unit-purchase-repository.ts` | 1 of 25 (db) |
| D12 | write | the block's FIFO instant is not the approval's | `unit-purchase-repository.ts` | 1 of 25 (db) |
| D13 | audit | the approval audit omits the approver's role | `unit-purchase-repository.ts` | 1 of 25 (db) |
| D14 | audit | the approval audit omits the expiry | `unit-purchase-repository.ts` | 1 of 25 (db) |
| D15 | audit | the approval audit records no price | `unit-purchase-repository.ts` | 1 of 25 (db) |
| D16 | audit | the approval audit has no actor | `unit-purchase-repository.ts` | 1 of 25 (db) |
| D17 | race | a lost same-key insert surfaces as an error | `unit-purchase-repository.ts` | 1 of 25 (db) |
| D18 | race | a collision that is not the key's answered as a replay | `unit-purchase-repository.ts` | 1 of 25 (db) |
| D19 | tenant | a period of another organization is found | `unit-purchase-repository.ts` | 1 of 25 (db) |
| D20 | read | a purchase's Units are not its block's | `unit-purchase-repository.ts` | 1 of 25 (db) |
| D21 | read | a purchase's expiry is not its period's end | `unit-purchase-repository.ts` | 3 of 25 (db) |
| L01 | audit | a block is inserted without its grant audit entry | `unit-entitlement-repository.ts` | 1 of 25 (db) |
| L02 | write | a block's FIFO instant is not the one given | `unit-entitlement-repository.ts` | 32 of 33 (ledger-db) |
| G01 | who | the group read finds no permission | `group-repository.ts` | 1 of 25 (db) |

### Required documentation

| Item | Where |
| --- | --- |
| Architecture diagram | `docs/architecture.md` status table: the Unit purchase row, and the Billing row now naming UP-3 and UP-4 |
| Entity-relationship diagram | `docs/er-diagram.md`, *UP-2*: `unit_purchases` and its three keys |
| Critical sequence diagram | this section, *Approving a purchase* |
| OpenAPI / API change summary | `docs/api-changes-up-2.md`: no HTTP API; internal `UnitPurchaseService`, `addOnPackageOffer`, the catalog prices (`@app/domain`), `createUnitPurchaseRepository` (`@app/database`) |
| Change log / release notes | the commit list above and the pull request description |
| Database migration notes | `docs/migration-notes.md`, *UP-2*: migration 27, additive |
| Completion report | this file |

Also updated: `docs/Roadmap.md`, `docs/decisions/TODO.md` (the Unit accounting
item, a new open item on the price floor) and `docs/unit-purchase-gap-analysis.md`
(what building UP-2 found).

### Activation status

Nothing paid or scheduled is activated. UP-2 adds one table and a service that
nothing calls: no route, page, worker, scheduler, credential, environment
variable, dependency or payment integration. Paid Provider Activation,
production credentials, the production scheduler and live Stripe charges remain
BLOCKED.

### Known limitations

- **The approved prices are not checked against a provider cost floor.** No
  provider route is verified, so there is no cost to check against; the table
  is the price authority until one is (`TODO.md`).
- **Card payment is refused, not built.** A self-service plan's purchase is
  refused as `CARD_PAYMENT_NOT_AVAILABLE`.
- **The block's FIFO instant is the approval instant**, so two blocks bought in
  one millisecond are ordered by id, as any two blocks are.
- **Nothing corrects a purchase made in error.** A refund for VTaVision's own
  billing error must stay possible (ADR-0053 Decision 3A); the invoice can be
  corrected outside the product, but the purchase and its Units stay. How an
  operator marks one as credited is open in `TODO.md`, to settle before UP-4's
  list is used to invoice.

### Remaining work

UP-2 waits for the product owner's yes before merge. Next: UP-3, the purchase
screen, its confirmation step and the route.
