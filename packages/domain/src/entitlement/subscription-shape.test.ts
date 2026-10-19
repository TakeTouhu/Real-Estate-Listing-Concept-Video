import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * What Phase 6B may and may not have changed (ADR-0056).
 *
 * 1. **One additive migration**, this phase's, creating one table and touching
 *    no existing row.
 * 2. **Dormant.** No application code renews a period yet, so nothing here
 *    changes what any customer is charged. Since UP-1 (ADR-0066) the operator
 *    command provisions a subscription and the Units page reads one.
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
    // migration 20, Phase 6F migration 21, Phase 6G migration 22, Phase 6H
    // migration 23, the near-duplicate rule removal migration 24 and MFA-1
    // migration 25. Phase 6B still contributed exactly one migration, in place.
    expect(dirs.indexOf(MIGRATION_DIR)).toBe(18);
    expect(dirs.filter((dir) => dir.includes("phase6b"))).toEqual([MIGRATION_DIR]);
    // MFA-4 added migration 26 after them all, UP-2 migration 27 and UP-5 migration 28.
    expect(dirs).toHaveLength(29);
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
  const appSources = () =>
    ["apps/web", "apps/worker", "apps/ops"]
      .flatMap((app) => sourceFiles(join(REPO_ROOT, app)))
      .filter((file) => !/\.test\.tsx?$/.test(file));
  const callersOf = (pattern: RegExp) =>
    appSources()
      .filter((file) => pattern.test(code(readFileSync(file, "utf8"))))
      .map((file) => file.slice(REPO_ROOT.length + 1))
      .sort();

  it("renews no period from any application", () => {
    expect(callersOf(/renewEntitlementPeriod/)).toEqual([]);
  });

  it("is wired only where UP-1 reads or provisions a subscription (ADR-0066) and UP-3 buys Units (ADR-0068)", () => {
    expect(callersOf(/createSubscriptionRepository/)).toEqual([
      "apps/ops/src/bin/provision-subscription.ts",
      "apps/web/src/lib/unit-purchases.ts",
      "apps/web/src/lib/units.ts",
    ]);
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
