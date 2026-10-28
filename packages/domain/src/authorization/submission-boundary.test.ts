import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Only the paid-submission gate moves an orchestrated attempt to `SUBMITTING`
 * in production (ADR-0096).
 *
 * The gate is what locks the cost admission, the reservation and the source,
 * and writes the paid call's audit entry with the move. The attempt
 * repository's own `armProviderBoundary` does none of that; integration tests
 * use it to build fixtures, and nothing in production may call it. The
 * within-transaction form is called by the gate's session and by that method
 * alone.
 */

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");

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
        if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".next") continue;
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

describe("only the gate moves an attempt to SUBMITTING", () => {
  it("calls the attempt repository's own arm nowhere in production", () => {
    const callers = productionSources()
      .filter(({ text }) => text.includes(".armProviderBoundary("))
      .map(({ name }) => name);
    expect(callers).toEqual([]);
  });

  it("calls the within-transaction arm only from the gate's session and its own repository", () => {
    const callers = productionSources()
      .filter(({ text }) => /armProviderBoundaryWithin\(/.test(text))
      .map(({ name }) => name)
      .sort();
    expect(callers).toEqual([
      "packages/database/src/orchestration-repositories.ts",
      "packages/database/src/paid-submission-authorization-repository.ts",
    ]);
  });
});
