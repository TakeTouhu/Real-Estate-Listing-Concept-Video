import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * What UP-1 may and may not have changed (ADR-0066).
 *
 * 1. **No migration.** The subscription and the ledger already hold every fact.
 * 2. **The Units page only reads.** It opens no period, grants no block and
 *    provisions nothing.
 * 3. **Provisioning is the operator command's alone**, a package of its own that
 *    neither application depends on. It sets no timer and calls no payment
 *    processor.
 */

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const MIGRATIONS = join(REPO_ROOT, "packages", "database", "prisma", "migrations");

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

const relative = (file: string) => file.slice(REPO_ROOT.length + 1);
const read = (path: string) => code(readFileSync(join(REPO_ROOT, path), "utf8"));

function matching(root: string, pattern: RegExp): string[] {
  return sourceFiles(join(REPO_ROOT, root))
    .filter((file) => pattern.test(code(readFileSync(file, "utf8"))))
    .map(relative)
    .sort();
}

const UNITS_PAGE = "apps/web/src/app/organizations/[organizationId]/units/page.tsx";
const READERS = ["packages/domain/src/entitlement/units-overview.ts", "apps/web/src/lib/units.ts", UNITS_PAGE];

describe("UP-1 shape", () => {
  it("adds no migration of its own", () => {
    const dirs = readdirSync(MIGRATIONS, { withFileTypes: true }).filter((entry) => entry.isDirectory());
    // UP-2 added migration 27 after it, UP-5 migration 28 and DS-3 migration 29.
    expect(dirs).toHaveLength(32);
  });

  it("builds the overview only in the web app's wiring, and shows it only on the Units page", () => {
    expect(matching("apps", /new UnitsOverviewService/)).toEqual(["apps/web/src/lib/units.ts"]);
    expect(matching("apps", /getUnitsOverviewService\(/)).toEqual([UNITS_PAGE, "apps/web/src/lib/units.ts"]);
  });

  it("reads without writing: no period opened, no block granted, nothing provisioned", () => {
    for (const path of READERS) {
      const source = read(path);
      for (const banned of [
        /openPeriod/,
        /grantAddOnBlock/,
        /\.provision\(/,
        /provisionFromSalesContract/,
        /renewEntitlementPeriod/,
        /\$transaction/,
      ]) {
        expect(`${path}: ${banned}: ${banned.test(source)}`).toBe(`${path}: ${banned}: false`);
      }
    }
    expect(read("packages/domain/src/entitlement/units-overview.ts")).toMatch(
      /authorizeOrganization\(this\.deps\.identity, actorUserId, organizationId, "unit\.view"\)/,
    );
  });

  it("provisions only from the operator command", () => {
    expect(matching("apps", /provisionFromSalesContract|\.provision\(/)).toEqual([
      "apps/ops/src/provision-subscription.ts",
    ]);
    expect(matching("packages/domain/src", /provisionFromSalesContract\(/)).toEqual([
      "packages/domain/src/entitlement/subscription.ts",
    ]);
  });

  it("keeps the operator command out of both applications", () => {
    for (const app of ["web", "worker"]) {
      const manifest = JSON.parse(readFileSync(join(REPO_ROOT, "apps", app, "package.json"), "utf8")) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      expect({ ...manifest.dependencies, ...manifest.devDependencies }).not.toHaveProperty("@app/ops");
    }
    expect(matching("apps/web", /apps\/ops|@app\/ops/)).toEqual([]);
    expect(matching("apps/worker", /apps\/ops|@app\/ops|createSubscriptionRepository/)).toEqual([]);
  });

  it("gives the operator commands no timer, network call or payment processor", () => {
    const files = sourceFiles(join(REPO_ROOT, "apps", "ops", "src")).map(relative).sort();
    // UP-4 added the invoicing export and moved the instant parser to its own module (ADR-0069),
    // and UP-5 the cancellation command (ADR-0070).
    expect(files).toEqual([
      "apps/ops/src/bin/cancel-unit-purchase.ts",
      "apps/ops/src/bin/export-unit-purchases.ts",
      "apps/ops/src/bin/provision-subscription.ts",
      "apps/ops/src/cancel-unit-purchase.ts",
      "apps/ops/src/export-unit-purchases.ts",
      "apps/ops/src/instant.ts",
      "apps/ops/src/provision-subscription.ts",
    ]);
    for (const path of files) {
      const source = read(path);
      for (const banned of [/setInterval/, /setTimeout/, /\bcron\b/i, /stripe/i, /fetch\(/, /SELF_SERVICE/]) {
        expect(`${path}: ${banned}: ${banned.test(source)}`).toBe(`${path}: ${banned}: false`);
      }
    }
  });
});
