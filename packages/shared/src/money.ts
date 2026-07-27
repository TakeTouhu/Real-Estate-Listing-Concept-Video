/**
 * Money is represented in integer minor units (e.g. cents) to avoid
 * floating-point rounding errors in cost and credit calculations.
 */
export interface Money {
  readonly amountMinor: number;
  readonly currency: string;
}

export function money(amountMinor: number, currency: string): Money {
  if (!Number.isInteger(amountMinor)) {
    throw new Error("Money.amountMinor must be an integer number of minor units");
  }
  return { amountMinor, currency: currency.toUpperCase() };
}

export function addMoney(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return { amountMinor: a.amountMinor + b.amountMinor, currency: a.currency };
}

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new Error(`Cannot combine Money with different currencies: ${a.currency} vs ${b.currency}`);
  }
}
