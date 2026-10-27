import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * What UP-4 may and may not have changed (ADR-0069).
 *
 * 1. **No migration.** The purchase record already holds every fact listed.
 * 2. **The export reads, and writes only its audit entries**, in one
 *    transaction, and lists invoice-paid purchases only.
 * 3. **It reads a settled window under a lock on the purchases** (Decision 6):
 *    the database's clock first, then the lock, then the read.
 * 4. **Only the operator command exports.** Neither application can reach it.
 */

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const MIGRATIONS = join(REPO_ROOT, "packages", "database", "prisma", "migrations");
const REPOSITORY = "packages/database/src/unit-purchase-invoicing-repository.ts";

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

function matching(root: string, pattern: RegExp): string[] {
  return sourceFiles(join(REPO_ROOT, root))
    .filter((file) => pattern.test(code(readFileSync(file, "utf8"))))
    .map((file) => file.slice(REPO_ROOT.length + 1))
    .sort();
}

const repository = () => code(readFileSync(join(REPO_ROOT, REPOSITORY), "utf8"));

describe("UP-4 shape", () => {
  it("adds no migration", () => {
    const dirs = readdirSync(MIGRATIONS, { withFileTypes: true }).filter((entry) => entry.isDirectory());
    // UP-5 added migration 28 after it, and DS-3 migration 29.
    expect(dirs).toHaveLength(33);
  });

  it("reads and audits in one transaction, and writes nothing else", () => {
    const source = repository();
    expect(source.match(/\$transaction/g)).toHaveLength(1);
    expect(source.match(/\.create\(/g)).toEqual([".create("]);
    expect(source).toContain("tx.auditLog.create(");
    for (const banned of [/\.update(Many)?\(/, /\.delete(Many)?\(/, /\.upsert\(/, /\.createMany\(/, /Unsafe/]) {
      expect(`${banned}: ${banned.test(source)}`).toBe(`${banned}: false`);
    }
    expect(source.match(/\$executeRaw`[^`]*`/g)).toEqual(['$executeRaw`LOCK TABLE "unit_purchases" IN SHARE MODE`']);
    expect(source.match(/\$queryRaw[^`]*`[^`]*`/g)).toEqual(["$queryRaw<[{ now: Date }]>`SELECT clock_timestamp() AS now`"]);
    expect(source.indexOf("tx.unitPurchase.findMany(")).toBeLessThan(source.indexOf("tx.auditLog.create("));
  });

  it("reads the database's clock, then locks the purchases, then reads them", () => {
    const source = repository();
    const clock = source.indexOf("tx.$queryRaw");
    const lock = source.indexOf("tx.$executeRaw");
    expect(clock).toBeGreaterThan(source.indexOf("prisma.$transaction("));
    expect(lock).toBeGreaterThan(clock);
    expect(source.indexOf("tx.unitPurchase.findMany(")).toBeGreaterThan(lock);
  });

  it("lists invoice-paid purchases only", () => {
    expect(repository()).toMatch(/where: \{ channel: "SALES_ASSISTED", approvedAt: \{ gte: from, lt: to \} \}/);
  });

  it("is built only by the operator command", () => {
    expect(matching("apps", /createUnitPurchaseInvoicingRepository/)).toEqual([
      "apps/ops/src/bin/export-unit-purchases.ts",
    ]);
    expect(matching("apps", /\.exportForInvoicing\(/)).toEqual(["apps/ops/src/export-unit-purchases.ts"]);
    expect(matching("packages", /\.exportForInvoicing\(/)).toEqual([]);
  });
});
