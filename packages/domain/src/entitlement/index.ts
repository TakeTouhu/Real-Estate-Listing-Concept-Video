/**
 * The Unit entitlement ledger (Phase 6A, ADR-0055).
 *
 * Periods, quality-locked add-on blocks and the frozen allocations that fund a
 * reservation. The arithmetic is pure and lives in `allocation.ts`; the
 * repository supplies facts and enforces atomicity.
 */
export * from "./allocation";
export * from "./plan-entitlement";
export * from "./ports";
