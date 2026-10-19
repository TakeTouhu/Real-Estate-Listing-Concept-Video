# ADR-0069 — This period's purchases, and the invoicing export

Status: Accepted (UP-4, the last of four Unit purchase pull requests).
Implements: the Unit purchase proposal's Design 2 (each package bought this
period on the Units page) and Design 8 (an operator lists each period's
purchases per organization and contract for invoicing), and ADR-0053 Decisions
1 and 5A (prices shown excluding tax; billing facts for billing holders).
Builds on: ADR-0068 (the purchase screen and route), ADR-0067 (the purchase
record) and ADR-0066 (the Units page and the operator command pattern).

## Context

After UP-3 an invoice-paid organization can buy additional Units, and each
purchase is recorded with the price it was approved at and the contract it is
invoiced under (ADR-0067 Decision 2). Two things are missing:

- the customer cannot see what was bought this period, at what price and by
  whom: the Units page shows only what is left of each block;
- VTaVision has no way to list the purchases it must invoice.

No migration is needed: the purchase record already holds every fact listed.

---

## Decision 1 — This period's purchases on the Units page

The Units page gains a "Purchases this period" card, for holders of
`billing.view` only (`OWNER`, `ADMIN` and `BILLING` by default, or anyone an
`OWNER` granted it). A purchase is billing information, as the plan's price is
(ADR-0066 Decision 3). Anyone else with `unit.view` still sees each block and
what is left of it, as before, and the overview does not read the purchases for
them at all.

Each purchase shows:

- the package, for example "+10 Normal Units";
- the price it was approved at, excluding tax;
- when it was approved, in Japan time;
- who approved it, by name, while that person is still a member. Once they have
  left, it says "a former member". A purchase is a charge, so the organization
  sees who made it; a former member's current name is no longer the
  organization's to see.

The list is the ledger's period containing now, oldest approval first. A period
nobody has opened has no purchases, because approving one opens its period
(ADR-0067 Decision 3), so the card says none were bought without reading
anything. When there are purchases, the card says VTaVision invoices each one
under the contract, with consumption tax added. Viewing still writes nothing.

## Decision 2 — The operator command

```bash
pnpm --filter @app/ops export-unit-purchases \
  --from 2026-10-01T00:00:00+09:00 --to 2026-11-01T00:00:00+09:00 \
  --out unit-purchases-2026-10.csv \
  --operator "Your name" --reason "October invoices"
```

- **Every option is required**, as with provisioning (ADR-0066 Decision 1).
- **The window is half-open.** `--from` is included and `--to` excluded, so
  consecutive windows (October, then November) neither overlap nor leave a gap.
  Each is an instant with an explicit offset, so no one's local time zone
  decides it.
- **The window must have ended.** A `--to` in the future is refused before
  anything is read: purchases approved later in the window would be missing
  from the file, and the next window would start after them.
- **A new file each time.** `--out` must not exist; the command refuses before
  reading anything, and writes the file only if it still does not exist
  (`wx`), readable by its owner alone. An earlier export is never overwritten.
  If the file appears while the purchases are read, the command fails without
  writing it; the audit entries stay, recording a read that produced no file.
  The CSV goes to a file rather than to standard output because `pnpm` prints
  its own lines there, which would end up in the invoice data.

Exit codes are 0 written, 1 refused, 2 unusable arguments. The command says how
many purchases it wrote for how many organizations, and their total excluding
tax.

## Decision 3 — What it lists

Every purchase approved in the window and paid by invoice (`SALES_ASSISTED`),
by organization, then contract, then approval time. **A card-paid purchase is
never listed**: its payment processor will charge it, and invoicing it as well
would bill it twice. None exists yet, because card payment is not built.

| Column | What it holds |
| --- | --- |
| `organization_id` | the organization |
| `organization_name` | its name now, as its members set it |
| `contract_reference` | the contract it is invoiced under, as the subscription said when it was approved |
| `purchase_id` | the purchase, for tracing an invoice line back to its record and audit entry |
| `approved_at` | when it was approved, in Japan time with its offset (`2026-10-19T10:56:07+09:00`) |
| `quality` | `Normal` or `HQ`: the only quality names a customer sees |
| `units` | its block's Units |
| `price_yen_ex_tax` | the price it was approved at, excluding tax |
| `expires_at` | its period's end, in Japan time |

Consumption tax is added on the invoice, not here (ADR-0053 Decision 1).

## Decision 4 — The file's format

- RFC 4180, with a header row and CRLF line ends, and a UTF-8 byte order mark
  so a spreadsheet reads Japanese names correctly.
- Every text cell is quoted, with its quotes doubled.
- **A text cell a spreadsheet would read as a formula is neutralised**: one
  starting with `=`, `+`, `-`, `@`, a tab or a carriage return gets a leading
  `'`. An organization's name is whatever its members typed, so the file must
  never let it run as a formula on an operator's machine.
- Numbers are written bare.

## Decision 5 — The audit

Reading purchases across organizations is an operator's privilege. Each
organization listed gets one `unit_purchase.exported` entry, written in the same
transaction as the read, so an organization is audited exactly when its
purchases are listed:

- no actor user, because the operator is not a member;
- the operator's name and reason, trimmed;
- the window, and how many purchases were listed and their total excluding tax.

An organization with nothing in the window is not audited, because nothing of
its was read. The export writes nothing else.

---

## Decision 6 — What stays out

- **Correcting a purchase made in error.** The product still cannot mark a
  purchase as credited, so a corrected invoice's purchase is listed again if the
  same window is exported again. The product owner is deciding how a purchase
  made in error is corrected (`TODO.md`); the recommendation is an operator
  command that records a credit, audited, and shows it in the export, with the
  Units left in place.
- **No record of what was invoiced.** The window is the boundary: exporting
  consecutive windows invoices each purchase once.
- **No filter by organization.** One export covers every invoice-paid
  organization; a spreadsheet filters it.
- **No index on approval time alone.** The read scans purchases across
  organizations by approval time; the existing index leads with the
  organization. Purchases are few, and the index can come with the first need.

## Consequences

- A billing holder sees what was bought this period, at what price and by whom.
- VTaVision can invoice each month's purchases from one file per window,
  audited per organization.
- Card-paid purchases can be added later without being invoiced twice.

Paid Provider Activation, production Provider credentials, production paid AI
calls, production scheduler activation and live Stripe charges remain BLOCKED.
Nothing here touches them.
