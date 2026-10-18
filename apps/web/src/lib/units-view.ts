import type { CustomerPlanKey, GenerationQualityTier, SubscriptionChannel } from "@app/domain";

/** How the Units page writes plans, qualities, channels, prices and instants. */

export const PLAN_NAMES: Record<CustomerPlanKey, string> = {
  standard: "Standard",
  premium: "Premium",
  enterprise: "Enterprise",
};

/** The only quality names a customer sees: never a model or provider. */
export const QUALITY_NAMES: Record<GenerationQualityTier, string> = {
  NORMAL: "Normal",
  HIGH_QUALITY: "HQ",
};

export const CHANNEL_NAMES: Record<SubscriptionChannel, string> = {
  SALES_ASSISTED: "Paid by invoice",
  SELF_SERVICE: "Paid by card",
};

const YEN = new Intl.NumberFormat("ja-JP");

/** A tax-exclusive amount, labelled as such (ADR-0053 Decision 1). */
export function formatYenExTax(amount: number): string {
  return `¥${YEN.format(amount)} excluding tax`;
}

const JST = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Tokyo",
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** An instant in Japan time, which is where every customer is. */
export function formatJst(instant: Date): string {
  return `${JST.format(instant)} JST`;
}
