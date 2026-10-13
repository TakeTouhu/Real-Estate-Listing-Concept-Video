/**
 * The Unit entitlement ledger (Phase 6A, ADR-0055) and the subscription that
 * renews it (Phase 6B, ADR-0056).
 *
 * Periods, quality-locked add-on blocks and the frozen allocations that fund a
 * reservation. The arithmetic is pure and lives in `allocation.ts` and
 * `subscription.ts`; the repositories supply facts and enforce atomicity.
 */
export * from "./allocation";
export * from "./plan-entitlement";
export * from "./ports";
export * from "./subscription";
