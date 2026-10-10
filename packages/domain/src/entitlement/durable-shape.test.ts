import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * What Phase 6A may and may not have changed in durable shape and lock order.
 *
 * 1. **One migration, this phase's**, adding three tables and a column pair, and
 *    rewriting no existing row: history is labelled, never re-attributed.
 * 2. **No balance column.** What remains of a period is derived; a stored
 *    counter would be a second fact that could disagree with the reservations.
 * 3. **The established lock order.** Transaction B takes the cost-admission lock
 *    before it touches the job or any reservation row, and every advisory-lock
 *    formula still lives in one module.
 * 4. **No payment integration.** The ledger takes no payment and calls nothing.
 */

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const DATABASE_SRC = join(REPO_ROOT, "packages", "database", "src");
const MIGRATIONS = join(REPO_ROOT, "packages", "database", "prisma", "migrations");
const MIGRATION_DIR = "00000000000017_phase6a_unit_entitlement_ledger";

/** TypeScript with comments stripped, so prose naming a symbol is not mistaken for using it. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

/** The migration with its SQL comments stripped, for the same reason. */
function migrationSql(): string {
  return readFileSync(join(MIGRATIONS, MIGRATION_DIR, "migration.sql"), "utf8").replace(/--[^\n]*/g, " ");
}

/** The body of `reserve(` in the orchestration repository, comments stripped. */
function reserveBody(): string {
  const repo = code(readFileSync(join(DATABASE_SRC, "orchestration-repositories.ts"), "utf8"));
  const start = repo.indexOf("async reserve(");
  const end = repo.indexOf("async findByJobId(", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return repo.slice(start, end);
}

describe("durable shape", () => {
  it("adds exactly one migration, and it is this phase's", () => {
    const dirs = readdirSync(MIGRATIONS, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(dirs.at(-1)).toBe(MIGRATION_DIR);
    expect(dirs.filter((dir) => dir.includes("phase6a"))).toEqual([MIGRATION_DIR]);
    expect(dirs).toHaveLength(18);
  });

  it("creates the three ledger tables and rewrites no existing row", () => {
    const sql = migrationSql();
    expect(sql.match(/CREATE TABLE/g)).toHaveLength(3);
    for (const table of [
      "unit_entitlement_periods",
      "unit_add_on_blocks",
      "generation_reservation_allocations",
    ]) {
      expect(sql).toContain(`CREATE TABLE "${table}"`);
    }
    for (const banned of [/^\s*UPDATE\b/m, /^\s*DELETE\b/m, /\bTRUNCATE\b/, /\bDROP TABLE\b/, /\bDROP COLUMN\b/]) {
      expect(sql).not.toMatch(banned);
    }
  });

  it("labels history as legacy once, then makes every writer choose", () => {
    const sql = migrationSql();
    expect(sql).toContain(`"funding" "GenerationReservationFunding" NOT NULL DEFAULT 'UNALLOCATED_LEGACY'`);
    expect(sql).toContain(`ALTER COLUMN "funding" DROP DEFAULT`);
    expect(sql).toContain("generation_reservations_funding_period_check");
    // No guessed source for a legacy row: nothing inserts an allocation here.
    expect(sql).not.toMatch(/INSERT INTO/);
  });

  it("stores no balance or remaining-Units column", () => {
    const schema = readFileSync(join(REPO_ROOT, "packages", "database", "prisma", "schema.prisma"), "utf8");
    for (const banned of ["remainingUnits", "usedUnits", "balanceUnits", "consumedUnits"]) {
      expect(schema).not.toContain(banned);
    }
  });
});

describe("lock order", () => {
  it("takes the job-scoped reservation-admission lock before anything else", () => {
    const body = reserveBody();
    const admission = body.indexOf("acquireReservationAdmissionLock(tx");
    expect(admission).toBeGreaterThan(-1);
    for (const later of [
      "tx.generationJob.findFirst(",
      "tx.generationReservation.findUnique(",
      "findPeriodContaining(tx",
      "acquireCostAdmissionLock(tx",
    ]) {
      expect(body.indexOf(later)).toBeGreaterThan(admission);
    }
  });

  it("takes the cost-admission lock before the job move and every reservation write", () => {
    const body = reserveBody();
    const lock = body.indexOf("acquireCostAdmissionLock(tx");
    expect(lock).toBeGreaterThan(-1);
    for (const write of [
      "tx.generationJob.updateMany(",
      "tx.generationReservation.create(",
      "tx.generationReservationAllocation.createMany(",
      "loadPeriodBalance(tx",
    ]) {
      expect(body.indexOf(write)).toBeGreaterThan(lock);
    }
  });

  it("plans the funding before writing anything, so a short entitlement writes nothing", () => {
    const body = reserveBody();
    const refusal = body.indexOf('"INSUFFICIENT_ENTITLEMENT"');
    expect(refusal).toBeGreaterThan(-1);
    expect(refusal).toBeLessThan(body.indexOf("tx.generationJob.updateMany("));
    expect(refusal).toBeLessThan(body.indexOf("tx.generationReservation.create("));
  });

  it("keeps every advisory-lock formula in the one lock module", () => {
    const holders = readdirSync(DATABASE_SRC)
      .filter((name) => name.endsWith(".ts"))
      .filter((name) => readFileSync(join(DATABASE_SRC, name), "utf8").includes("pg_advisory_xact_lock"));
    expect(holders).toEqual(["cost-admission-lock.ts"]);
  });
});

describe("no payment integration", () => {
  it("names no payment provider in the ledger", () => {
    const sources = [
      readFileSync(join(DATABASE_SRC, "unit-entitlement-repository.ts"), "utf8"),
      readFileSync(join(__dirname, "allocation.ts"), "utf8"),
      readFileSync(join(__dirname, "ports.ts"), "utf8"),
    ].map(code);
    for (const text of sources) {
      expect(text).not.toMatch(/stripe/i);
      expect(text).not.toMatch(/\bfetch\(/);
    }
  });
});
