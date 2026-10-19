import { parseArgs } from "node:util";
import {
  UNIT_PURCHASE_CANCELLATION_LIMITS,
  type CancellableUnitPurchase,
  type CancelUnitPurchaseRequest,
  type UnitPurchaseCancellation,
  type UnitPurchaseCancellationRepository,
} from "@app/domain";
import { jstInstant, QUALITY_NAMES } from "./export-unit-purchases";

/**
 * The operator command that cancels a mistaken Unit purchase (UP-5, ADR-0070).
 *
 * Run without `--confirm`, it shows the purchase and what cancelling it would
 * do, and writes nothing. Run again with `--confirm`, it cancels it: the unused
 * Units are withdrawn, the used ones stay used, and the purchase is not
 * invoiced, used Units included. It cannot be undone. Like the other operator
 * commands, it runs with the database credentials of whoever runs it, which is
 * the privilege, and the cancellation is audited with the operator's name and
 * reason.
 */

export const USAGE = [
  "Usage: pnpm --filter @app/ops cancel-unit-purchase \\",
  "  --purchase <purchase id, e.g. upur_...> \\",
  "  --operator <your name> \\",
  "  --reason <why, e.g. bought by mistake, as the customer wrote on 2026-10-19> \\",
  "  [--confirm]   without it, nothing is cancelled: the purchase is only shown",
].join("\n");

const LIMITS = { purchase: 100, ...UNIT_PURCHASE_CANCELLATION_LIMITS } as const;

export interface CancelArguments {
  readonly request: CancelUnitPurchaseRequest;
  readonly confirm: boolean;
}

export type ParsedCancelArguments =
  | { readonly ok: true; readonly value: CancelArguments }
  | { readonly ok: false; readonly error: string };

function required(values: Record<string, unknown>, name: keyof typeof LIMITS, errors: string[]): string {
  const raw = values[name];
  const value = typeof raw === "string" ? raw.trim() : "";
  if (value === "") errors.push(`--${name} is required`);
  else if (value.length > LIMITS[name]) errors.push(`--${name} is longer than ${LIMITS[name]} characters`);
  return value;
}

/** Read and validate the command line. Every option but `--confirm` is required; nothing is defaulted. */
export function parseCancelArguments(argv: readonly string[]): ParsedCancelArguments {
  let values: Record<string, unknown>;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      strict: true,
      allowPositionals: false,
      options: {
        purchase: { type: "string" },
        operator: { type: "string" },
        reason: { type: "string" },
        confirm: { type: "boolean" },
      },
    }));
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Unreadable arguments" };
  }

  const errors: string[] = [];
  const purchaseId = required(values, "purchase", errors);
  const name = required(values, "operator", errors);
  const reason = required(values, "reason", errors);
  if (errors.length > 0) return { ok: false, error: errors.join("\n") };
  return { ok: true, value: { request: { purchaseId, operator: { name, reason } }, confirm: values.confirm === true } };
}

export interface CancelResult {
  /** 0 when shown, cancelled or already cancelled; 1 when refused. */
  readonly exitCode: 0 | 1;
  readonly message: string;
}

const YEN = new Intl.NumberFormat("ja-JP");

/**
 * The purchase in a few lines. The organization's name is whatever its members
 * typed, so it is printed as a JSON string: quoted, with any control character
 * escaped rather than sent to the terminal.
 */
export function describePurchase(purchase: CancellableUnitPurchase): string {
  const { usage } = purchase;
  return [
    `Purchase ${purchase.purchaseId} by organization ${purchase.organizationId} ` +
      `(${JSON.stringify(purchase.organizationName)}):`,
    `  ${QUALITY_NAMES[purchase.quality]} ${purchase.units} Units, ¥${YEN.format(purchase.priceYenExTax)} ` +
      `excluding tax, contract ${JSON.stringify(purchase.contractReference)}`,
    `  approved ${jstInstant(purchase.approvedAt)}, expires ${jstInstant(purchase.expiresAt)}`,
    `  used: ${usage.consumed} delivered, ${usage.inFlight} still generating; unused: ${usage.unused}`,
  ].join("\n");
}

const AFTERWARDS =
  "If it was already invoiced, refund or offset it by hand: a later export marks it cancelled " +
  "and invoices nothing for it.";

/** Show or cancel, and say plainly what happened. */
export async function runCancelUnitPurchase(
  repository: UnitPurchaseCancellationRepository,
  { request, confirm }: CancelArguments,
): Promise<CancelResult> {
  if (!confirm) {
    const purchase = await repository.find(request.purchaseId);
    if (purchase === null) {
      return { exitCode: 1, message: `Refused: there is no purchase ${request.purchaseId}. Nothing was cancelled.` };
    }
    if (purchase.cancellation !== null) return alreadyCancelled(purchase, purchase.cancellation);
    if (!purchase.invoicePaid) return cardPaid(purchase);
    const { usage } = purchase;
    return {
      exitCode: 0,
      message: [
        describePurchase(purchase),
        `Cancelling it withdraws its ${usage.unused} unused Units now, and any that a running generation ` +
          `fails to use; the ${usage.consumed} delivered stay used. The whole purchase is then not invoiced, ` +
          "used Units included. It cannot be undone.",
        "Nothing was cancelled. To cancel it, run the same command again with --confirm.",
      ].join("\n"),
    };
  }

  const outcome = await repository.cancel(request);
  switch (outcome.kind) {
    case "NOT_FOUND":
      return { exitCode: 1, message: `Refused: there is no purchase ${request.purchaseId}. Nothing was cancelled.` };
    case "ALREADY_CANCELLED":
      return alreadyCancelled(outcome.purchase, outcome.purchase.cancellation);
    case "CARD_PAID":
      return cardPaid(outcome.purchase);
    case "CANCELLED": {
      const { usage } = outcome.purchase;
      return {
        exitCode: 0,
        message: [
          describePurchase(outcome.purchase),
          `Cancelled: ${usage.unused} unused Units withdrawn, ${usage.consumed} delivered kept, ` +
            `${usage.inFlight} still generating left to finish. It will not be invoiced. ` +
            `Audited with operator ${request.operator.name}.`,
          AFTERWARDS,
        ].join("\n"),
      };
    }
  }
}

function alreadyCancelled(purchase: CancellableUnitPurchase, cancellation: UnitPurchaseCancellation): CancelResult {
  return {
    exitCode: 0,
    message:
      `${describePurchase(purchase)}\n` +
      `It was already cancelled on ${jstInstant(cancellation.cancelledAt)} by ${cancellation.operatorName}. ` +
      "Nothing was written.",
  };
}

function cardPaid(purchase: CancellableUnitPurchase): CancelResult {
  return {
    exitCode: 1,
    message:
      `${describePurchase(purchase)}\n` +
      "Refused: its payment processor charged it, so it is refunded there, not cancelled here. Nothing was cancelled.",
  };
}
