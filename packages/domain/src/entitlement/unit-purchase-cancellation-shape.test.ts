import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * What UP-5 may and may not have changed (ADR-0070).
 *
 * 1. **One migration, the newest**: the cancellation table and the composite
 *    key it points through, additive only, storing no count of Units.
 * 2. **The purchase and its block are never rewritten.** Withdrawing is the
 *    ledger's reading of the cancellation, not a write.
 * 3. **One transaction, in the established lock order.** The cost-admission lock
 *    first, then the read the cancellation is decided on, then the
 *    cancellation and its audit entry.
 * 4. **Only the operator command cancels.** Neither application can reach it.
 */

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const MIGRATIONS = join(REPO_ROOT, "packages", "database", "prisma", "migrations");
const MIGRATION_DIR = "00000000000028_unit_purchase_cancellations";
const REPOSITORY = "packages/database/src/unit-purchase-cancellation-repository.ts";
const LEDGER = "packages/database/src/unit-entitlement-repository.ts";

function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === "node_modules" || name === ".next" || name === "dist") return [];
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

const read = (path: string) => code(readFileSync(join(REPO_ROOT, path), "utf8"));

function matching(root: string, pattern: RegExp): string[] {
  return sourceFiles(join(REPO_ROOT, root))
    .filter((file) => pattern.test(code(readFileSync(file, "utf8"))))
    .map((file) => file.slice(REPO_ROOT.length + 1))
    .sort();
}

function migrationSql(): string {
  return readFileSync(join(MIGRATIONS, MIGRATION_DIR, "migration.sql"), "utf8").replace(/--[^\n]*/g, " ");
}

describe("UP-5 shape", () => {
  it("adds exactly one migration, the newest", () => {
    const dirs = readdirSync(MIGRATIONS, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(dirs.at(-1)).toBe(MIGRATION_DIR);
    expect(dirs).toHaveLength(29);
  });

  it("creates the cancellation table and one unique index, and rewrites no existing row", () => {
    const sql = migrationSql();
    expect(sql.match(/CREATE TABLE "\w+"/g)).toEqual([`CREATE TABLE "unit_purchase_cancellations"`]);
    expect(sql.match(/CREATE (UNIQUE )?INDEX "\w+"/g)).toEqual([
      `CREATE UNIQUE INDEX "unit_purchases_id_organizationId_key"`,
    ]);
    expect(sql.match(/ALTER TABLE "\w+"/g)).toEqual([
      `ALTER TABLE "unit_purchase_cancellations"`,
      `ALTER TABLE "unit_purchase_cancellations"`,
    ]);
    for (const banned of [/^\s*UPDATE\b/m, /^\s*DELETE\b/m, /\bTRUNCATE\b/, /\bDROP\b/, /\bINSERT INTO\b/, /ON DELETE CASCADE/]) {
      expect(`${banned}: ${banned.test(sql)}`).toBe(`${banned}: false`);
    }
  });

  it("keeps a cancellation to one per purchase, inside the purchase's organization", () => {
    const sql = migrationSql();
    expect(sql).toContain(`CONSTRAINT "unit_purchase_cancellations_pkey" PRIMARY KEY ("purchaseId")`);
    expect(sql).toContain(
      `FOREIGN KEY ("purchaseId", "organizationId") REFERENCES "unit_purchases"("id", "organizationId") ON DELETE RESTRICT`,
    );
    expect(sql).toContain(`length("operatorName") BETWEEN 1 AND 200`);
    expect(sql).toContain(`length("reason") BETWEEN 1 AND 500`);
  });

  it("stores no count of Units: the ledger derives what remains from allocations alone", () => {
    const sql = migrationSql();
    const columns = [...sql.matchAll(/^\s+"(\w+)" /gm)].map(([, column]) => column);
    expect(columns).toEqual(["purchaseId", "organizationId", "operatorName", "reason", "cancelledAt"]);
  });

  it("cancels in one transaction, under the cost-admission lock, writing only the cancellation and its audit entry", () => {
    const source = read(REPOSITORY);
    expect(source.match(/\$transaction/g)).toHaveLength(1);
    expect(source.match(/\.create\(/g)).toEqual([".create(", ".create("]);
    for (const banned of [/\.update(Many)?\(/, /\.delete(Many)?\(/, /\.upsert\(/, /\.createMany\(/, /\$executeRaw/, /Unsafe/]) {
      expect(`${banned}: ${banned.test(source)}`).toBe(`${banned}: false`);
    }
    // Only the database's clock, to stamp the cancellation with.
    expect(source.match(/\$queryRaw[^`]*`[^`]*`/g)).toEqual(["$queryRaw<[{ now: Date }]>`SELECT now() AS now`"]);
    const lock = source.indexOf("acquireCostAdmissionLock(tx");
    expect(lock).toBeGreaterThan(source.indexOf("prisma.$transaction("));
    for (const later of ["read(tx", "tx.$queryRaw", "tx.unitPurchaseCancellation.create(", "tx.auditLog.create("]) {
      expect(source.indexOf(later)).toBeGreaterThan(lock);
    }
    expect(source.indexOf("tx.unitPurchaseCancellation.create(")).toBeLessThan(source.indexOf("tx.auditLog.create("));
  });

  it("withdraws a block by reading its purchase's cancellation in the one balance every reservation plans against", () => {
    const ledger = read(LEDGER);
    const body = ledger.slice(ledger.indexOf("export async function loadPeriodBalance("));
    expect(body.slice(0, body.indexOf("\n}\n"))).toContain(
      "withdrawn: block.purchases.some((purchase) => purchase.cancellations.length > 0)",
    );
    expect(matching("packages/database/src", /unitPurchaseCancellation\./)).toEqual([REPOSITORY]);
  });

  it("is built only by the operator command", () => {
    expect(matching("apps", /createUnitPurchaseCancellationRepository/)).toEqual([
      "apps/ops/src/bin/cancel-unit-purchase.ts",
    ]);
    expect(matching("apps", /\.cancel\(request\)/)).toEqual(["apps/ops/src/cancel-unit-purchase.ts"]);
    expect(matching("apps/web", /UnitPurchaseCancellationRepository|cancel-unit-purchase/)).toEqual([]);
    expect(matching("apps/worker", /UnitPurchaseCancellation|cancel-unit-purchase/)).toEqual([]);
  });
});
