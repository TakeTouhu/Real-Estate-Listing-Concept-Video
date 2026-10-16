# API Changes — UP-1

Plan provisioning and the Units page (ADR-0066). No HTTP route is added or
changed. One page and one operator command are added.

## Pages

### Added: `/organizations/{organizationId}/units`

An organization's plan and what it has left to generate with this period.

| Case | Shown |
| --- | --- |
| not signed in, or the sign-in has not passed MFA | redirect to `/login` |
| not a member, no such organization, or a member without `unit.view` | "You cannot view this organization's Units." (the same for all three) |
| no plan | "This organization has no plan yet. VTaVision sets it up when your contract starts." |
| before the plan's start | the plan, and when it starts |
| otherwise | the plan; the period in Japan time; Base Units left and how many can fund HQ; each additional Unit block, oldest first; that Normal and HQ blocks never fund each other; when the plan sells no HQ package, that it does not |

A holder of `billing.view` also sees how the plan is paid and its monthly price,
excluding tax. Viewing writes nothing.

### Changed: `/` (the dashboard)

Each organization links to its Units page ("Units and plan").

## Operator command

### Added: `pnpm --filter @app/ops provision-subscription`

Not an HTTP interface: run by a VTaVision operator with database credentials.

| Option | Value |
| --- | --- |
| `--organization` | organization id (up to 100 characters) |
| `--plan` | `standard`, `premium` or `enterprise` |
| `--starts` | ISO 8601 instant with an explicit offset, e.g. `2026-11-01T00:00:00+09:00` |
| `--contract` | contract number (up to 200 characters) |
| `--operator` | operator's name (up to 200 characters) |
| `--reason` | why (up to 500 characters) |

Exit code 0: provisioned, or already exactly this plan. Exit code 1: refused (a
different plan or contract already there, shown; or no such organization). Exit
code 2: unusable arguments, with every problem listed.

## Internal API (`@app/domain`)

- `UnitsOverviewService.overview(actorUserId, organizationId)` and the
  `UnitsOverview` result (`NO_PLAN`, `NOT_STARTED`, `ACTIVE`).
- `provisionFromSalesContract`, `salesContractSubscriptionId`,
  `SalesContractProvisioning` and `OperatorAttribution`.
- `ProvisionSubscriptionInput.operator` (optional): written to the
  `subscription.provisioned` audit entry as `operator` and `reason`.
- `InMemoryUnitsReader` in `@app/domain/testing`.
