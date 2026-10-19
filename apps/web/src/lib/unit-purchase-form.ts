import {
  MAX_IDEMPOTENCY_KEY_LENGTH,
  type ApproveUnitPurchaseInput,
  type GenerationQualityTier,
  type UnitPurchaseRefusal,
} from "@app/domain";
import { AppError } from "@app/shared";

/**
 * The purchase confirmation form (ADR-0068 Decision 3): what the confirmation
 * step showed, carried back as hidden fields, and the words for every way a
 * purchase can be refused. Shape only; the purchase service decides the rest.
 */

const QUALITIES: readonly GenerationQualityTier[] = ["NORMAL", "HIGH_QUALITY"];
const WHOLE_YEN_OR_UNITS = /^[1-9][0-9]{0,8}$/;

function field(form: FormData, key: string): string {
  const value = form.get(key);
  return typeof value === "string" ? value : "";
}

/** The approval the form carries, or `null` when it cannot be one. */
export function readUnitPurchaseForm(organizationId: string, form: FormData): ApproveUnitPurchaseInput | null {
  const quality = QUALITIES.find((candidate) => candidate === field(form, "quality"));
  const units = field(form, "units");
  const price = field(form, "priceYenExTax");
  const endsAt = field(form, "periodEndsAt");
  const idempotencyKey = field(form, "idempotencyKey");
  const periodEndsAt = new Date(endsAt);
  if (
    quality === undefined ||
    !WHOLE_YEN_OR_UNITS.test(units) ||
    !WHOLE_YEN_OR_UNITS.test(price) ||
    Number.isNaN(periodEndsAt.getTime()) ||
    periodEndsAt.toISOString() !== endsAt ||
    idempotencyKey.length === 0 ||
    idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH
  ) {
    return null;
  }
  return {
    organizationId,
    quality,
    expected: { units: Number(units), priceYenExTax: Number(price), periodEndsAt },
    idempotencyKey,
  };
}

export const NOT_USABLE = "The purchase request could not be read. Nothing was bought. Review the purchase again.";

/** A confirmation sent again after VTaVision cancelled the purchase it approved (ADR-0070 Decision 8). */
export const CANCELLED_SINCE =
  "This confirmation was for a purchase VTaVision has since cancelled, which is not invoiced. Nothing new was bought. Review the purchase again.";

const REFUSALS: Record<Exclude<UnitPurchaseRefusal, "LACKS_BILLING_MANAGE">, string> = {
  NO_PLAN: "This organization has no plan yet. Nothing was bought.",
  NOT_STARTED: "Your plan has not started yet. Nothing was bought.",
  THROUGH_SALES: "Enterprise additional Units are bought through your VTaVision representative. Nothing was bought.",
  CARD_PAYMENT_NOT_AVAILABLE: "Additional Units cannot be bought by card yet. Nothing was bought.",
  NOT_OFFERED: "Your plan does not sell that package. Nothing was bought.",
  OFFER_CHANGED: "The package or its price changed after you reviewed it. Nothing was bought. Review it again.",
  PERIOD_CHANGED: "The current period changed after you reviewed the purchase. Nothing was bought. Review it again.",
  IDEMPOTENCY_KEY_REUSED:
    "This confirmation was already used for a different purchase. Nothing was bought. Review it again.",
};

export function refusalMessage(reason: Exclude<UnitPurchaseRefusal, "LACKS_BILLING_MANAGE">): string {
  return REFUSALS[reason];
}

/**
 * The words for a purchase that failed. Only a refusal, a refused permission or
 * an unusable request says nothing was bought; any other failure may have
 * happened after the write, so the customer is sent to look before trying again.
 */
export function failureMessage(error: unknown): string {
  if (error instanceof AppError && error.code === "FORBIDDEN") {
    return "You cannot buy Units for this organization. Nothing was bought.";
  }
  if (error instanceof AppError && error.code === "VALIDATION_FAILED") return NOT_USABLE;
  return "The purchase could not be confirmed. Check the Units page before trying again.";
}
