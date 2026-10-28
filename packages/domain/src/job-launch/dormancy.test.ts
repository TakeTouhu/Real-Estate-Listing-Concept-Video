import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * What the launch planner (ADR-0094) may and may not do.
 *
 * 1. **Dormancy.** Nothing in production constructs the planner. The launch
 *    commit (GS-7b) and the pipeline command (GS-9) are what will.
 * 2. **No paid boundary.** It reads catalogs and a rate source and calls no
 *    provider, HTTP client, storage or database.
 * 3. **One pricing authority.** Which contracts are in force for a route is
 *    decided in the pricing domain, for this planner and the media recovery's
 *    alike.
 */

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const MODULE_DIR = __dirname;

/** Comments stripped, so prose naming a symbol is not mistaken for using it. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

function sourceFiles(dir: string): { name: string; text: string }[] {
  const found: { name: string; text: string }[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "testing" || entry.name === "node_modules") continue;
        walk(full);
      } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
        if (entry.name.includes(".test.")) continue;
        found.push({ name: full.slice(REPO_ROOT.length + 1), text: code(readFileSync(full, "utf8")) });
      }
    }
  };
  walk(dir);
  return found;
}

function productionSources(): { name: string; text: string }[] {
  return [
    join(REPO_ROOT, "apps", "web", "src"),
    join(REPO_ROOT, "apps", "worker", "src"),
    join(REPO_ROOT, "apps", "ops", "src"),
    join(REPO_ROOT, "packages"),
  ]
    .filter((dir) => existsSync(dir))
    .flatMap(sourceFiles);
}

function imports(text: string): string[] {
  return [...text.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1] ?? "");
}

describe("the planner exists but nothing runs it", () => {
  it("is not constructed in production", () => {
    for (const { name, text } of productionSources()) {
      if (name.startsWith("packages/domain/src/job-launch/")) continue;
      expect(`${name}: ${text.includes("JobLaunchPlanner(")}`).toBe(`${name}: false`);
    }
  });
});

describe("no paid boundary is reachable", () => {
  it("keeps the module to the domain's catalogs, prompt renderer and pricing", () => {
    for (const { name, text } of sourceFiles(MODULE_DIR)) {
      for (const source of imports(text)) {
        expect(`${name}: ${source}`).toMatch(
          new RegExp(
            ": (" +
              [
                "\\./(limit|planner|ports)",
                "\\.\\./authorization/routing",
                "\\.\\./generation/(capability|model-catalog|prompt-render)",
                "\\.\\./media-recovery/ports",
                "\\.\\./orchestration/(entitlement|types)",
                "\\.\\./pricing/(pricing-eligibility|pricing-snapshot|provider-cost-calculator|" +
                  "provider-pricing-catalog|provider-pricing-contract|units)",
                "@app/shared",
              ].join("|") +
              ")$",
          ),
        );
      }
    }
  });

  it("takes only types from the recovery module, never its planner", () => {
    const planner = code(readFileSync(join(MODULE_DIR, "planner.ts"), "utf8"));
    expect(planner).toMatch(/import type \{ FxRateSource \} from "\.\.\/media-recovery\/ports"/);
    for (const banned of ["fetch(", "createGeneration(", "prisma", "$transaction", "setTimeout(", "setInterval("]) {
      expect(`${banned}: ${planner.includes(banned)}`).toBe(`${banned}: false`);
    }
  });
});

describe("one pricing authority", () => {
  it("is the only lookup of a route's contracts in force, for both planners", () => {
    const definitions: string[] = [];
    const callers: string[] = [];
    for (const { name, text } of sourceFiles(join(REPO_ROOT, "packages", "domain", "src"))) {
      if (/function currentlyEligibleContractsForRoute\(/.test(text)) definitions.push(name);
      if (/currentlyEligibleContractsForRoute\(\s*this/.test(text)) callers.push(name);
      // The recovery planner's private copy is gone, not merely unused.
      expect(`${name}: ${text.includes("currentContractsForRoute(")}`).toBe(`${name}: false`);
    }
    expect(definitions).toEqual(["packages/domain/src/pricing/pricing-eligibility.ts"]);
    expect(callers.sort()).toEqual([
      "packages/domain/src/job-launch/planner.ts",
      "packages/domain/src/media-recovery/planner.ts",
    ]);
  });
});
