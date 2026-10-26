import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * What the attempt failure settlement (ADR-0083) may and may not do.
 *
 * 1. **Dormancy.** Nothing in production constructs the runner or the
 *    repository, or calls either entry point.
 * 2. **No paid boundary.** Neither module can reach a provider, an HTTP client,
 *    storage or the paid-submission gate.
 * 3. **Money.** It releases a Unit and nothing else: it never consumes one,
 *    never writes a delivered pointer and never touches an attempt.
 * 4. **Lock order.** The cost-admission lock, then the reservation, then the
 *    job, scene and request.
 */

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const MODULE_DIR = __dirname;
const REPOSITORY = join(
  REPO_ROOT,
  "packages",
  "database",
  "src",
  "attempt-failure-settlement-repository.ts",
);

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

/** Every SQL `UPDATE "table" SET ... WHERE` in a source, by table. */
function updates(text: string): { table: string; set: string }[] {
  return [...text.matchAll(/UPDATE\s+"([a-z_]+)"\s+SET([\s\S]*?)\bWHERE\b/g)].map((m) => ({
    table: m[1] ?? "",
    set: m[2] ?? "",
  }));
}

function setColumns(set: string): string[] {
  return [...set.matchAll(/"([A-Za-z]+)"\s*=/g)].map((m) => m[1] ?? "");
}

describe("the capability exists but nothing runs it", () => {
  it("constructs neither the runner nor the repository in production", () => {
    for (const { name, text } of productionSources()) {
      if (name.startsWith("packages/domain/src/attempt-failure-settlement/")) continue;
      if (name === "packages/domain/src/index.ts" || name === "packages/database/src/index.ts") {
        continue;
      }
      if (name === "packages/database/src/attempt-failure-settlement-repository.ts") continue;
      for (const banned of [
        "AttemptFailureSettlementRunner(",
        "createAttemptFailureSettlementRepository(",
        ".settleAttemptFailure(",
        ".findAttemptFailureCandidates(",
      ]) {
        expect(`${name}: ${banned} ${text.includes(banned)}`).toBe(`${name}: ${banned} false`);
      }
    }
  });
});

describe("no paid boundary is reachable", () => {
  it("keeps the domain module to the orchestration vocabulary", () => {
    for (const { name, text } of sourceFiles(MODULE_DIR)) {
      for (const source of imports(text)) {
        expect(`${name}: ${source}`).toMatch(
          /: (\.\/(settlement|ports|runner)|\.\.\/orchestration\/(ports|types|state-machines)|\.\.\/pricing\/units|@app\/shared)$/,
        );
      }
    }
  });

  it("keeps the repository to the database and the domain", () => {
    expect(imports(code(readFileSync(REPOSITORY, "utf8"))).sort()).toEqual([
      "./cost-admission-lock",
      "./orchestration-repositories",
      "@app/domain",
      "@prisma/client",
    ]);
  });
});

describe("it releases a Unit and moves nothing else that carries money", () => {
  const text = code(readFileSync(REPOSITORY, "utf8"));

  it("updates the request, scene, job and reservation only, and inserts or deletes nothing", () => {
    expect(updates(text).map((u) => u.table)).toEqual([
      "scene_generation_requests",
      "generation_reservations",
      "generation_scenes",
      "generation_jobs",
    ]);
    for (const banned of ["INSERT", "DELETE", "tx.", "prisma.scene", "prisma.generation"]) {
      const found = banned === "tx." ? /\btx\.(?!\$queryRaw)/.test(text) : text.includes(banned);
      expect(`${banned}: ${found}`).toBe(`${banned}: false`);
    }
  });

  it("moves the reservation only to RELEASED, with its instant", () => {
    const reservation = updates(text).find((u) => u.table === "generation_reservations");
    expect(setColumns(reservation?.set ?? "")).toEqual([
      "state",
      "stateVersion",
      "releasedAt",
      "updatedAt",
    ]);
    expect(reservation?.set).toContain(`"state" = 'RELEASED'::"GenerationReservationState"`);
  });

  it("never consumes a Unit, writes a delivered pointer or touches an attempt", () => {
    for (const banned of ["consumedAt", "deliveredAt\" =", "scene_generations\" SET"]) {
      expect(`${banned}: ${text.includes(banned)}`).toBe(`${banned}: false`);
    }
    for (const { table, set } of updates(text)) {
      expect(`${table}: ${setColumns(set).join(",")}`).not.toMatch(
        /currentDelivered|currentDeliverable|CONSUMED/,
      );
      expect(set).not.toContain("CONSUMED");
    }
    expect(updates(text).find((u) => u.table === "scene_generation_requests")?.set).toContain(
      `"failedAt" = `,
    );
  });

  it("takes the cost-admission lock, then the reservation, then the job chain", () => {
    const lock = text.indexOf("acquireCostAdmissionLock(");
    const reservation = text.indexOf("FOR UPDATE OF res");
    const chain = text.indexOf("FOR UPDATE OF j, s, r");
    expect(lock).toBeGreaterThan(-1);
    expect(reservation).toBeGreaterThan(lock);
    expect(chain).toBeGreaterThan(reservation);
    expect(text.match(/FOR UPDATE/g)).toHaveLength(2);
    expect(text.match(/acquireCostAdmissionLock\(/g)).toHaveLength(1);
  });

  it("decides in one place", () => {
    expect(text.match(/decideAttemptFailureSettlement\(/g)).toHaveLength(1);
  });
});
