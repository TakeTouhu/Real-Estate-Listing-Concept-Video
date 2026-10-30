import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * What the failed job scene closure (ADR-0084) may and may not do.
 *
 * 1. **Dormancy.** Nothing in production constructs the runner or the
 *    repository, or calls either entry point.
 * 2. **No paid boundary.** Neither module can reach a provider, an HTTP client,
 *    storage or the paid-submission gate.
 * 3. **No money.** It moves an attempt, a request and a scene, and nothing
 *    else: never the job, never the reservation, never a delivered pointer. The
 *    only attempt it moves is one still waiting to be sent.
 * 4. **Lock order.** The cost-admission lock, then the job and scene, then the
 *    requests, then the attempts.
 */

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const MODULE_DIR = __dirname;
/**
 * The development pipeline's assembly (GS-9b, ADR-0106): it builds the steps
 * for the test provider, is refused in production, and runs nothing itself.
 */
const DEVELOPMENT_ASSEMBLY = "apps/worker/src/development-pipeline/assembly.ts";
const REPOSITORY = join(
  REPO_ROOT,
  "packages",
  "database",
  "src",
  "failed-job-scene-closure-repository.ts",
);

/** Comments stripped, so prose naming a symbol is not mistaken for using it. */
function code(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ")
    .replace(/--[^\n]*/g, " ");
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
      if (name.startsWith("packages/domain/src/failed-job-scene-closure/")) continue;
      if (name === "packages/domain/src/index.ts" || name === "packages/database/src/index.ts") {
        continue;
      }
      if (name === "packages/database/src/failed-job-scene-closure-repository.ts") continue;
      for (const banned of [
        "FailedJobSceneClosureRunner(",
        "createFailedJobSceneClosureRepository(",
        ".closeFailedJobScene(",
        ".findFailedJobSceneCandidates(",
      ]) {
        // The assembly builds both and calls neither.
        if (name === DEVELOPMENT_ASSEMBLY && !banned.startsWith(".")) continue;
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
          /: (\.\/(closure|ports|runner)|\.\.\/orchestration\/(ports|types|state-machines)|\.\.\/pricing\/units|@app\/shared)$/,
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

describe("it closes rows and moves nothing that carries money", () => {
  const text = code(readFileSync(REPOSITORY, "utf8"));

  it("updates attempts, requests and the scene only, and inserts or deletes nothing", () => {
    expect(updates(text).map((u) => u.table)).toEqual([
      "scene_generations",
      "scene_generation_requests",
      "scene_generation_requests",
      "generation_scenes",
    ]);
    for (const banned of ["INSERT", "DELETE", "tx.", "prisma.scene", "prisma.generation"]) {
      const found = banned === "tx." ? /\btx\.(?!\$queryRaw)/.test(text) : text.includes(banned);
      expect(`${banned}: ${found}`).toBe(`${banned}: false`);
    }
  });

  it("cancels only an attempt still waiting to be sent", () => {
    const attempt = updates(text).find((u) => u.table === "scene_generations");
    expect(setColumns(attempt?.set ?? "")).toEqual(["orchestrationState", "stateVersion", "updatedAt"]);
    expect(attempt?.set).toContain(`'CANCELLED_PRE_SUBMISSION'::"GenerationAttemptState"`);
    expect(text).toContain(`AND "orchestrationState" = 'QUEUED'::"GenerationAttemptState"`);
    expect(text.match(/UPDATE "scene_generations"/g)).toHaveLength(1);
  });

  it("fails a request with its instant, or cancels it, and nothing else", () => {
    const [failed, cancelled] = updates(text).filter((u) => u.table === "scene_generation_requests");
    expect(setColumns(failed?.set ?? "")).toEqual(["state", "stateVersion", "failedAt"]);
    expect(failed?.set).toContain(`'FAILED_TERMINAL'::"SceneGenerationRequestState"`);
    expect(setColumns(cancelled?.set ?? "")).toEqual(["state", "stateVersion"]);
    expect(cancelled?.set).toContain(`'CANCELLED'::"SceneGenerationRequestState"`);
  });

  it("never touches the job, the reservation or a delivered pointer", () => {
    for (const banned of [
      `UPDATE "generation_jobs"`,
      `UPDATE "generation_reservations"`,
      "FOR UPDATE OF res",
      "RELEASED",
      "CONSUMED",
      "consumedAt",
      "releasedAt",
      "deliveredAt\" =",
    ]) {
      expect(`${banned}: ${text.includes(banned)}`).toBe(`${banned}: false`);
    }
    for (const { table, set } of updates(text)) {
      expect(`${table}: ${setColumns(set).join(",")}`).not.toMatch(
        /currentDelivered|currentDeliverable/,
      );
    }
    // Read once, for the advisory key, and never locked.
    expect(text.match(/"generation_reservations"/g)).toHaveLength(1);
  });

  it("takes the cost-admission lock, then the job and scene, the requests, the attempts", () => {
    const lock = text.indexOf("acquireCostAdmissionLock(");
    const chain = text.indexOf("FOR UPDATE OF j, s\n");
    const requests = text.indexOf("FOR UPDATE\n");
    const attempts = text.indexOf("FOR UPDATE OF a\n");
    expect(lock).toBeGreaterThan(-1);
    expect(chain).toBeGreaterThan(lock);
    expect(requests).toBeGreaterThan(chain);
    expect(attempts).toBeGreaterThan(requests);
    expect(text.match(/FOR UPDATE/g)).toHaveLength(3);
    expect(text.match(/acquireCostAdmissionLock\(/g)).toHaveLength(1);
  });

  it("decides in one place", () => {
    expect(text.match(/decideFailedJobSceneClosure\(/g)).toHaveLength(1);
  });
});
