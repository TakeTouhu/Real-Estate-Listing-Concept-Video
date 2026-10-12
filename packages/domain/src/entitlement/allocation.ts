import type { GenerationQualityTier, GenerationReservationState } from "../orchestration/types";

/**
 * The Unit ledger's arithmetic, as pure functions (ADR-0053 Decisions 2–3,
 * ADR-0055).
 *
 * Nothing here reads a clock, a database or a price. The repository loads the
 * facts — a period's plan snapshot, its add-on blocks, and the frozen
 * allocations of every reservation drawn against it — and these functions decide
 * what is left and what a new reservation would take. Keeping the decision here
 * is what lets one test suite prove every ordering rule without a database, and
 * lets the database suite prove only what the database decides: atomicity and
 * concurrency.
 */

/** Where one allocation's Units come from. */
export type UnitEntitlementSourceType = "BASE" | "ADD_ON_BLOCK";

/** The plan facts one entitlement period was opened with, frozen on the period. */
export interface PeriodPlanEntitlement {
  /** The plan's included Units for the period. Never carried over. */
  readonly baseUnits: number;
  /** A ceiling on HQ draws **inside** `baseUnits` — never an extra pool. */
  readonly includedHighQualityUnits: number;
}

/** One purchased add-on block, as granted. Its quality never changes. */
export interface AddOnBlockGrant {
  readonly id: string;
  readonly quality: GenerationQualityTier;
  readonly quantity: number;
  /** The FIFO key: when the block was bought, in epoch milliseconds. */
  readonly purchasedAtEpochMs: number;
}

/** One frozen allocation of an existing reservation, with that reservation's state. */
export interface ExistingAllocation {
  readonly sourceType: UnitEntitlementSourceType;
  /** Present exactly when `sourceType` is `ADD_ON_BLOCK`. */
  readonly addOnBlockId: string | null;
  readonly quality: GenerationQualityTier;
  readonly quantity: number;
  readonly reservationState: GenerationReservationState;
}

/** What remains of one add-on block. */
export interface AddOnBlockBalance {
  readonly id: string;
  readonly quality: GenerationQualityTier;
  readonly remainingUnits: number;
  readonly purchasedAtEpochMs: number;
}

/** What remains of one period. */
export interface PeriodEntitlementBalance {
  readonly baseRemainingUnits: number;
  /** The included HQ ceiling still unspent, independent of `baseRemainingUnits`. */
  readonly includedHighQualityRemainingUnits: number;
  readonly blocks: readonly AddOnBlockBalance[];
}

/** One planned allocation of a new reservation. */
export type PlannedUnitAllocation =
  | {
      readonly sourceType: "BASE";
      readonly addOnBlockId: null;
      readonly quality: GenerationQualityTier;
      readonly quantity: number;
    }
  | {
      readonly sourceType: "ADD_ON_BLOCK";
      readonly addOnBlockId: string;
      readonly quality: GenerationQualityTier;
      readonly quantity: number;
    };

export type UnitAllocationPlan =
  | { readonly ok: true; readonly allocations: readonly PlannedUnitAllocation[] }
  | {
      readonly ok: false;
      readonly reason: "INSUFFICIENT_ENTITLEMENT";
      /** How many of the required Units the eligible sources could cover. */
      readonly eligibleUnits: number;
    };

/** How an allocation stands, read from its reservation and nowhere else. */
export type AllocationSettlement = "HELD" | "CONSUMED" | "RELEASED";

/**
 * The settlement of every allocation of a reservation in `state`.
 *
 * **Derived, never stored.** An allocation has no state of its own: it is held
 * while its reservation is pending, spent when the reservation is `CONSUMED`,
 * and returned when it is `RELEASED`. Both are terminal and reached by one
 * compare-and-set on the reservation, so every allocation of a reservation
 * settles in that same commit, exactly once, and a replayed consume or release
 * that loses its compare-and-set cannot move a balance a second time. A counter
 * beside it could drift; a fact derived from the one row that settles cannot.
 */
export function allocationSettlement(state: GenerationReservationState): AllocationSettlement {
  if (state === "CONSUMED") return "CONSUMED";
  if (state === "RELEASED") return "RELEASED";
  return "HELD";
}

/**
 * Whether a reservation in `state` still occupies the entitlement it was funded
 * from. Held and consumed Units are both unavailable; only a release returns them.
 */
export function occupiesEntitlement(state: GenerationReservationState): boolean {
  return allocationSettlement(state) !== "RELEASED";
}

/**
 * What remains of a period: its plan snapshot and blocks, minus every allocation
 * that still occupies them.
 *
 * A Base allocation of HQ quality counts against **both** the Base pool and the
 * included HQ ceiling; a Base allocation of Normal quality counts against the
 * Base pool only. Add-on allocations count only against their own block.
 * Allocations naming a block this period does not hold are a defect — they
 * would let a Unit be spent from nowhere — and are refused rather than ignored.
 */
export function periodEntitlementBalance(input: {
  readonly plan: PeriodPlanEntitlement;
  readonly blocks: readonly AddOnBlockGrant[];
  readonly allocations: readonly ExistingAllocation[];
}): PeriodEntitlementBalance {
  let baseUsed = 0;
  let highQualityBaseUsed = 0;
  const blockUsed = new Map<string, number>();
  for (const block of input.blocks) {
    if (blockUsed.has(block.id)) throw new EntitlementLedgerDefect("DUPLICATE_ADD_ON_BLOCK");
    blockUsed.set(block.id, 0);
  }

  for (const allocation of input.allocations) {
    if (!occupiesEntitlement(allocation.reservationState)) continue;
    if (allocation.sourceType === "BASE") {
      baseUsed += allocation.quantity;
      if (allocation.quality === "HIGH_QUALITY") highQualityBaseUsed += allocation.quantity;
      continue;
    }
    const blockId = allocation.addOnBlockId;
    const used = blockId === null ? undefined : blockUsed.get(blockId);
    if (blockId === null || used === undefined) {
      throw new EntitlementLedgerDefect("ALLOCATION_NAMES_UNKNOWN_BLOCK");
    }
    blockUsed.set(blockId, used + allocation.quantity);
  }

  return {
    baseRemainingUnits: input.plan.baseUnits - baseUsed,
    includedHighQualityRemainingUnits: input.plan.includedHighQualityUnits - highQualityBaseUsed,
    blocks: input.blocks.map((block) => ({
      id: block.id,
      quality: block.quality,
      remainingUnits: block.quantity - (blockUsed.get(block.id) ?? 0),
      purchasedAtEpochMs: block.purchasedAtEpochMs,
    })),
  };
}

/**
 * Plan the frozen allocations of a new reservation (ADR-0053 Decision 3, CTO
 * decision on multi-Unit funding).
 *
 * **Eligibility first, across the whole quantity:**
 *
 * 1. Base Units — for HQ, limited by both the Base Units left and the included
 *    HQ ceiling left. Whatever Base capacity is eligible is used, even if it
 *    covers only part of the request.
 * 2. Add-on blocks of the **requested quality only**, oldest first — by purchase
 *    time, then by id so equal instants still order the same way every time —
 *    continuing to the next-oldest until the quantity is met.
 *
 * A block of the other quality is never eligible and is skipped; skipping it is
 * not a FIFO violation, because it was never in this request's queue. There is
 * no fallback between qualities in either direction.
 *
 * **All or nothing.** If the eligible total is short, nothing is planned and the
 * caller writes nothing. A partially funded reservation would be a promise the
 * ledger cannot keep.
 */
export function planUnitAllocation(input: {
  readonly quality: GenerationQualityTier;
  readonly units: number;
  readonly balance: PeriodEntitlementBalance;
}): UnitAllocationPlan {
  if (!Number.isSafeInteger(input.units) || input.units <= 0) {
    throw new EntitlementLedgerDefect("UNITS_NOT_A_POSITIVE_INTEGER");
  }

  const allocations: PlannedUnitAllocation[] = [];
  let needed = input.units;

  const baseEligible = Math.max(
    0,
    input.quality === "HIGH_QUALITY"
      ? Math.min(input.balance.baseRemainingUnits, input.balance.includedHighQualityRemainingUnits)
      : input.balance.baseRemainingUnits,
  );
  const fromBase = Math.min(needed, baseEligible);
  if (fromBase > 0) {
    allocations.push({
      sourceType: "BASE",
      addOnBlockId: null,
      quality: input.quality,
      quantity: fromBase,
    });
    needed -= fromBase;
  }

  for (const block of fifoEligibleBlocks(input.balance.blocks, input.quality)) {
    if (needed === 0) break;
    const take = Math.min(needed, block.remainingUnits);
    allocations.push({
      sourceType: "ADD_ON_BLOCK",
      addOnBlockId: block.id,
      quality: input.quality,
      quantity: take,
    });
    needed -= take;
  }

  if (needed > 0) {
    return { ok: false, reason: "INSUFFICIENT_ENTITLEMENT", eligibleUnits: input.units - needed };
  }
  return { ok: true, allocations };
}

/** Blocks a request of `quality` may draw from, oldest first. */
function fifoEligibleBlocks(
  blocks: readonly AddOnBlockBalance[],
  quality: GenerationQualityTier,
): AddOnBlockBalance[] {
  return blocks
    .filter((block) => block.quality === quality && block.remainingUnits > 0)
    .sort(
      (a, b) =>
        a.purchasedAtEpochMs - b.purchasedAtEpochMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
}

/**
 * Whether a reservation's frozen allocations fund exactly what it reserved.
 *
 * Checked by Transaction G before it spends the reservation: every allocation
 * must carry the job's quality, and together they must cover the reserved Units
 * exactly. A short set would deliver Units nobody funded; a long one would spend
 * more than the customer asked for.
 */
export function frozenFundingCoversReservation(input: {
  readonly quality: GenerationQualityTier;
  readonly reservedUnits: number;
  readonly allocations: readonly { readonly quality: GenerationQualityTier; readonly quantity: number }[];
}): boolean {
  // An empty set totals 0, and a reservation always holds at least one Unit.
  let total = 0;
  for (const allocation of input.allocations) {
    if (allocation.quality !== input.quality || allocation.quantity <= 0) return false;
    total += allocation.quantity;
  }
  return total === input.reservedUnits;
}

export type EntitlementLedgerDefectCode =
  | "DUPLICATE_ADD_ON_BLOCK"
  | "ALLOCATION_NAMES_UNKNOWN_BLOCK"
  | "UNITS_NOT_A_POSITIVE_INTEGER";

/**
 * A ledger fact that cannot be true of a consistent database.
 *
 * Thrown rather than returned: each code describes corrupted or impossible input,
 * and a caller that could branch on it would be choosing a way to continue
 * spending against a ledger it already knows is wrong.
 */
export class EntitlementLedgerDefect extends Error {
  constructor(readonly code: EntitlementLedgerDefectCode) {
    super(`Unit entitlement ledger defect: ${code}`);
    this.name = "EntitlementLedgerDefect";
  }
}
