import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * What UP-3 may and may not have changed (ADR-0068).
 *
 * 1. **No migration.** UP-2's purchase record holds every fact.
 * 2. **One way to buy.** Only the purchase route approves a purchase, and only
 *    after checking the post came from this site and who sent it.
 * 3. **Showing writes nothing.** The purchase screen and the offers it shows open
 *    no period and approve nothing.
 * 4. **No payment integration.** Nothing here calls a payment processor or sets
 *    a timer, and the worker does not buy.
 */

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const MIGRATIONS = join(REPO_ROOT, "packages", "database", "prisma", "migrations");
const ROUTE = "apps/web/src/app/api/organizations/[organizationId]/unit-purchases/route.ts";
const PAGE = "apps/web/src/app/organizations/[organizationId]/units/buy/page.tsx";
const WIRING = "apps/web/src/lib/unit-purchases.ts";
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

describe("UP-3 shape", () => {
  it("adds no migration of its own", () => {
    const dirs = readdirSync(MIGRATIONS, { withFileTypes: true }).filter((entry) => entry.isDirectory());
    // UP-5 added migration 28 after it, and DS-3 migration 29.
    expect(dirs).toHaveLength(31);
  });

  it("reaches the purchase service only from the purchase screen and the purchase route", () => {
    expect(matching("apps", /getUnitPurchaseService\(/)).toEqual([ROUTE, PAGE, WIRING].sort());
    expect(matching("apps", /getUnitPurchaseService\(\)\.approve\(/)).toEqual([ROUTE]);
    expect(matching("apps", /getUnitPurchaseService\(\)\.offers\(/)).toEqual([PAGE]);
    expect(matching("apps/worker", /UnitPurchase|unit-purchase/)).toEqual([]);
  });

  it("checks the origin, then the sign-in, then reads the form, then approves", () => {
    const route = read(ROUTE);
    const order = ["isSameOriginPost(request)", "getCurrentUser()", "request.formData()", ".approve("].map((step) =>
      route.indexOf(step),
    );
    expect(order.every((position) => position > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("shows the screen without writing: no approval, no period opened", () => {
    const page = read(PAGE);
    expect(page).not.toMatch(/\.approve\(/);
    expect(page.match(/<form\b[^>]*>/g)).toEqual([
      '<form method="post" action={`/api/organizations/${encodeURIComponent(organizationId)}/unit-purchases`}>',
    ]);
    const service = read(SERVICE);
    const start = service.indexOf("async offers(");
    const offers = service.slice(start, service.indexOf("async approve(", start));
    expect(start).toBeGreaterThan(-1);
    for (const banned of [/openPeriod/, /renewEntitlementPeriod/, /recordAudit/, /purchases\./]) {
      expect(`${banned}: ${banned.test(offers)}`).toBe(`${banned}: false`);
    }
  });

  it("names no payment processor, calls nothing and sets no timer", () => {
    const helpers = ["apps/web/src/lib/unit-purchase-form.ts", "apps/web/src/lib/same-origin.ts"];
    for (const path of [ROUTE, PAGE, WIRING, ...helpers]) {
      const source = read(path);
      for (const banned of [/stripe/i, /fetch\(/, /setInterval/, /setTimeout/]) {
        expect(`${path}: ${banned}: ${banned.test(source)}`).toBe(`${path}: ${banned}: false`);
      }
    }
  });
});
