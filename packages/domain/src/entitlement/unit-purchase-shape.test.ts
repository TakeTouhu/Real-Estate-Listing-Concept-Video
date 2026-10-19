import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * What UP-2 may and may not have changed (ADR-0067).
 *
 * 1. **One migration, this change's**: the purchase table, additive only.
 * 2. **Dormant until UP-3.** No application built the purchase service or its
 *    repository; UP-3 wires them for the purchase screen and route (ADR-0068).
 * 3. **One transaction, in the established lock order.** The cost-admission lock
 *    first, then the re-check, then the block, the purchase and the audit entry.
 * 4. **No payment integration.** Nothing here calls a payment processor.
 */

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const MIGRATIONS = join(REPO_ROOT, "packages", "database", "prisma", "migrations");
const MIGRATION_DIR = "00000000000027_unit_purchases";
const REPOSITORY = "packages/database/src/unit-purchase-repository.ts";
const SERVICE = "packages/domain/src/entitlement/unit-purchase.ts";

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

describe("durable shape", () => {
  it("adds exactly one migration, the newest", () => {
    const dirs = readdirSync(MIGRATIONS, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(dirs.at(-1)).toBe(MIGRATION_DIR);
    expect(dirs).toHaveLength(28);
  });

  it("creates the purchase table only, and rewrites no existing row", () => {
    const sql = migrationSql();
    expect(sql.match(/CREATE TABLE/g)).toEqual(["CREATE TABLE"]);
    expect(sql).toContain(`CREATE TABLE "unit_purchases"`);
    expect(sql.match(/ALTER TABLE "(\w+)"/g)?.every((statement) => statement === `ALTER TABLE "unit_purchases"`)).toBe(
      true,
    );
    for (const banned of [/^\s*UPDATE\b/m, /^\s*DELETE\b/m, /\bTRUNCATE\b/, /\bDROP\b/, /\bINSERT INTO\b/]) {
      expect(sql).not.toMatch(banned);
    }
  });

  it("ties a purchase to a block of its own period and quality, and keeps the approver as evidence", () => {
    const sql = migrationSql();
    const toBlock = `FOREIGN KEY ("addOnBlockId", "entitlementPeriodId", "quality") REFERENCES "unit_add_on_blocks"`;
    expect(sql).toContain(`${toBlock}("id", "entitlementPeriodId", "quality") ON DELETE RESTRICT`);
    expect(sql).toContain(`CREATE UNIQUE INDEX "unit_purchases_addOnBlockId_key"`);
    expect(sql).toContain(`CREATE UNIQUE INDEX "unit_purchases_organizationId_idempotencyKey_key"`);
    expect(sql).not.toMatch(/FOREIGN KEY \("approvedByUserId"\)/);
    expect(sql).not.toMatch(/ON DELETE CASCADE/);
    expect(sql).toContain(`"priceYenExTax" > 0`);
  });
});

describe("dormant until UP-3", () => {
  it("builds the purchase service and its repository only in the web app's purchase wiring", () => {
    expect(matching("apps", /\bUnitPurchaseService\b|\bcreateUnitPurchaseRepository\b/)).toEqual([
      "apps/web/src/lib/unit-purchases.ts",
    ]);
  });

  it("has no caller of the purchase but its own service", () => {
    expect(matching("packages", /\bpurchases\.approve\(/)).toEqual([SERVICE]);
  });
});

describe("one transaction, in the established lock order", () => {
  const body = () => {
    const repo = read(REPOSITORY);
    const start = repo.indexOf("const approveWithin");
    const end = repo.indexOf("return {", repo.indexOf("return { kind: \"APPROVED\"", start));
    expect(start).toBeGreaterThan(-1);
    return repo.slice(start, end);
  };

  it("writes inside one transaction", () => {
    expect(body().match(/\$transaction/g)).toHaveLength(1);
  });

  it("takes the cost-admission lock before reading anything it decides on", () => {
    const text = body();
    const lock = text.indexOf("acquireCostAdmissionLock(tx");
    expect(lock).toBeGreaterThan(-1);
    for (const later of [
      "findByKey(tx",
      "approverWithin(tx",
      "tx.organizationSubscription.findUnique(",
      "check(",
      "insertAddOnBlockWithin(tx",
      "tx.unitPurchase.create(",
      "tx.auditLog.create(",
    ]) {
      expect(`${later}: ${text.indexOf(later) > lock}`).toBe(`${later}: true`);
    }
  });

  it("checks before writing, so a refused purchase writes nothing", () => {
    const text = body();
    const refused = text.indexOf(`kind: "REFUSED"`);
    expect(refused).toBeGreaterThan(text.indexOf("check("));
    for (const write of ["insertAddOnBlockWithin(tx", "tx.unitPurchase.create(", "tx.auditLog.create("]) {
      expect(text.indexOf(write)).toBeGreaterThan(refused);
    }
  });

  it("share-locks the approver's membership", () => {
    const membershipShareLock =
      /FROM "memberships"\s+WHERE "organizationId" = \$\{organizationId\} AND "userId" = \$\{userId\}\s+FOR SHARE/;
    expect(read(REPOSITORY)).toMatch(membershipShareLock);
  });

  it("inserts every block, granted or bought, through one helper", () => {
    expect(matching("packages/database/src", /insertAddOnBlockWithin\(tx/)).toEqual([
      "packages/database/src/unit-entitlement-repository.ts",
      REPOSITORY,
    ]);
    expect(matching("packages/database/src", /tx\.unitAddOnBlock\.create\(/)).toEqual([
      "packages/database/src/unit-entitlement-repository.ts",
    ]);
  });
});

describe("no payment integration", () => {
  it("names no payment processor and calls nothing", () => {
    for (const path of [REPOSITORY, SERVICE]) {
      const source = read(path);
      for (const banned of [/stripe/i, /fetch\(/, /setInterval/, /setTimeout/]) {
        expect(`${path}: ${banned}: ${banned.test(source)}`).toBe(`${path}: ${banned}: false`);
      }
    }
  });
});
