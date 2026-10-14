import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * What Phase 6B may and may not have changed (ADR-0056).
 *
 * 1. **One additive migration**, this phase's, creating one table and touching
 *    no existing row.
 * 2. **Dormant.** No application code provisions a subscription or renews a
 *    period yet, so nothing here changes what any customer is charged.
 * 3. **No scheduler and no payment integration.** Renewal runs on demand; it
 *    sets no timer and calls no payment processor.
 */

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const MIGRATIONS = join(REPO_ROOT, "packages", "database", "prisma", "migrations");
const MIGRATION_DIR = "00000000000018_phase6b_organization_subscriptions";

function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === "node_modules" || name === ".next" || name === "dist") return [];
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

describe("durable shape", () => {
  it("adds exactly one migration, and it is this phase's", () => {
    const dirs = readdirSync(MIGRATIONS, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    // No longer the newest: Phase 6C added migration 19 after it, Phase 6D
    // migration 20, Phase 6F migration 21 and Phase 6G migration 22. Phase 6B still
    // contributed exactly one migration, in place.
    expect(dirs.indexOf(MIGRATION_DIR)).toBe(18);
    expect(dirs.filter((dir) => dir.includes("phase6b"))).toEqual([MIGRATION_DIR]);
    expect(dirs).toHaveLength(23);
  });

  it("creates one table, rewrites nothing, and holds the channel rule in the schema", () => {
    const sql = readFileSync(join(MIGRATIONS, MIGRATION_DIR, "migration.sql"), "utf8").replace(/--[^\n]*/g, " ");
    expect(sql.match(/CREATE TABLE/g)).toEqual([`CREATE TABLE`]);
    expect(sql).toContain(`CREATE TABLE "organization_subscriptions"`);
    for (const banned of [/^\s*UPDATE\b/m, /^\s*DELETE\b/m, /\bTRUNCATE\b/, /\bDROP\b/, /\bINSERT INTO\b/]) {
      expect(sql).not.toMatch(banned);
    }
    expect(sql.match(/ALTER TABLE "([a-z_]+)"/g)?.every((s) => s.includes(`"organization_subscriptions"`))).toBe(true);
    expect(sql).toContain(`("planKey" <> 'ENTERPRISE' OR "channel" = 'SALES_ASSISTED')`);
    expect(sql).toContain("ON DELETE RESTRICT");
  });
});

describe("dormancy", () => {
  it("has no caller in either application", () => {
    const callers = ["apps/web", "apps/worker"]
      .flatMap((app) => sourceFiles(join(REPO_ROOT, app)))
      .filter((file) => /renewEntitlementPeriod|createSubscriptionRepository/.test(code(readFileSync(file, "utf8"))));
    expect(callers).toEqual([]);
  });

  it("sets no timer and calls no payment processor", () => {
    for (const file of [
      join(REPO_ROOT, "packages", "domain", "src", "entitlement", "subscription.ts"),
      join(REPO_ROOT, "packages", "database", "src", "subscription-repository.ts"),
    ]) {
      const source = code(readFileSync(file, "utf8"));
      for (const banned of [/setInterval/, /setTimeout/, /\bcron\b/i, /stripe/i, /fetch\(/]) {
        expect(`${file}: ${banned}: ${banned.test(source)}`).toBe(`${file}: ${banned}: false`);
      }
    }
  });
});
