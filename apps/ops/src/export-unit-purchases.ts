import { parseArgs } from "node:util";
import type {
  GenerationQualityTier,
  InvoiceableUnitPurchase,
  UnitPurchaseExportRequest,
  UnitPurchaseInvoicingRepository,
} from "@app/domain";
import { parseInstant } from "./instant";

/**
 * The operator command that lists invoice-paid Unit purchases for invoicing
 * (UP-4, ADR-0069 Decisions 2 to 4).
 *
 * It writes the purchases approved in a window to a new CSV file, one row each,
 * by organization, contract and approval. Like provisioning, it runs with the
 * database credentials of whoever runs it, which is the privilege; every
 * organization listed is audited with the operator's name and reason. The file
 * is new each time, so an earlier export is never overwritten.
 */

export const USAGE = [
  "Usage: pnpm --filter @app/ops export-unit-purchases \\",
  "  --from <first instant, inclusive, e.g. 2026-10-01T00:00:00+09:00> \\",
  "  --to <end instant, exclusive and not in the future, e.g. 2026-11-01T00:00:00+09:00> \\",
  "  --out <a new file, e.g. unit-purchases-2026-10.csv> \\",
  "  --operator <your name> \\",
  "  --reason <why, e.g. October invoices>",
].join("\n");

const LIMITS = { out: 500, operator: 200, reason: 500 } as const;

export interface ExportArguments {
  readonly request: UnitPurchaseExportRequest;
  readonly out: string;
}

export type ParsedExportArguments =
  | { readonly ok: true; readonly value: ExportArguments }
  | { readonly ok: false; readonly error: string };

function required(values: Record<string, unknown>, name: keyof typeof LIMITS, errors: string[]): string {
  const raw = values[name];
  const value = typeof raw === "string" ? raw.trim() : "";
  if (value === "") errors.push(`--${name} is required`);
  else if (value.length > LIMITS[name]) errors.push(`--${name} is longer than ${LIMITS[name]} characters`);
  return value;
}

/** Read and validate the command line. Every option is required; nothing is defaulted. */
export function parseExportArguments(argv: readonly string[]): ParsedExportArguments {
  let values: Record<string, unknown>;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      strict: true,
      allowPositionals: false,
      options: {
        from: { type: "string" },
        to: { type: "string" },
        out: { type: "string" },
        operator: { type: "string" },
        reason: { type: "string" },
      },
    }));
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Unreadable arguments" };
  }

  const errors: string[] = [];
  const instant = (name: "from" | "to") => {
    const raw = values[name];
    const parsed = parseInstant(typeof raw === "string" ? raw.trim() : "");
    if (parsed === null) {
      errors.push(`--${name} must be an ISO 8601 instant with a time zone, e.g. 2026-10-01T00:00:00+09:00`);
    }
    return parsed;
  };
  const from = instant("from");
  const to = instant("to");
  if (from !== null && to !== null && from.getTime() >= to.getTime()) errors.push("--from must be before --to");
  const out = required(values, "out", errors);
  const name = required(values, "operator", errors);
  const reason = required(values, "reason", errors);

  if (errors.length > 0 || from === null || to === null) return { ok: false, error: errors.join("\n") };
  return { ok: true, value: { request: { from, to, operator: { name, reason } }, out } };
}

const QUALITY_NAMES: Record<GenerationQualityTier, string> = { NORMAL: "Normal", HIGH_QUALITY: "HQ" };

const HEADER = [
  "organization_id",
  "organization_name",
  "contract_reference",
  "purchase_id",
  "approved_at",
  "quality",
  "units",
  "price_yen_ex_tax",
  "expires_at",
];

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** An instant in Japan time with its offset, e.g. `2026-10-19T10:56:00+09:00`. */
export function jstInstant(instant: Date): string {
  return `${new Date(instant.getTime() + JST_OFFSET_MS).toISOString().slice(0, 19)}+09:00`;
}

/**
 * A text cell: quoted, its quotes doubled, and a leading character a
 * spreadsheet would read as a formula neutralised, because an organization's
 * name is whatever its members typed.
 */
export function textCell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return `"${safe.replaceAll('"', '""')}"`;
}

/**
 * The purchases as CSV: RFC 4180 with CRLF line ends, and a byte order mark so
 * a spreadsheet reads Japanese names as UTF-8.
 */
export function unitPurchasesCsv(purchases: readonly InvoiceableUnitPurchase[]): string {
  const rows = purchases.map((purchase) =>
    [
      textCell(purchase.organizationId),
      textCell(purchase.organizationName),
      textCell(purchase.contractReference),
      textCell(purchase.purchaseId),
      textCell(jstInstant(purchase.approvedAt)),
      textCell(QUALITY_NAMES[purchase.quality]),
      String(purchase.units),
      String(purchase.priceYenExTax),
      textCell(jstInstant(purchase.expiresAt)),
    ].join(","),
  );
  return `\uFEFF${[HEADER.join(","), ...rows].map((row) => `${row}\r\n`).join("")}`;
}

export interface ExportFiles {
  exists(path: string): Promise<boolean>;
  /** Write a file that does not exist yet; fails rather than overwrite one. */
  writeNew(path: string, contents: string): Promise<void>;
}

export interface ExportResult {
  /** 0 when the file was written, 1 when it was refused. */
  readonly exitCode: 0 | 1;
  readonly message: string;
}

const YEN = new Intl.NumberFormat("ja-JP");

/** Export, and say plainly what happened. */
export async function runExportUnitPurchases(
  repository: UnitPurchaseInvoicingRepository,
  files: ExportFiles,
  { request, out }: ExportArguments,
  now: Date,
): Promise<ExportResult> {
  const window = `from ${jstInstant(request.from)} to ${jstInstant(request.to)}`;
  if (request.to.getTime() > now.getTime()) {
    return {
      exitCode: 1,
      message:
        "Refused: --to is in the future, so purchases still to be approved before it would be left out. " +
        "Nothing was listed or audited.",
    };
  }
  if (await files.exists(out)) {
    return { exitCode: 1, message: `Refused: ${out} already exists. Nothing was listed or audited.` };
  }

  const purchases = await repository.exportForInvoicing(request);
  await files.writeNew(out, unitPurchasesCsv(purchases));
  if (purchases.length === 0) {
    return { exitCode: 0, message: `No invoice-paid purchases were approved ${window}. Wrote ${out} with no rows.` };
  }
  const organizations = new Set(purchases.map((purchase) => purchase.organizationId)).size;
  const total = purchases.reduce((sum, purchase) => sum + purchase.priceYenExTax, 0);
  const counted = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;
  return {
    exitCode: 0,
    message:
      `Wrote ${counted(purchases.length, "purchase")} for ${counted(organizations, "organization")} ` +
      `approved ${window} to ${out}: ` +
      `¥${YEN.format(total)} excluding tax in total. ` +
      `Each organization is audited with operator ${request.operator.name}.`,
  };
}
