import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { qualityTierForResolution } from "./start";

/**
 * The start commit (GS-4b, ADR-0087): the quality a project starts at, and
 * the shape the commit must keep — its one migration, its lock order, and its
 * dormancy until the start service and route construct it.
 */

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const DATABASE_SRC = join(REPO_ROOT, "packages", "database", "src");
const MIGRATIONS = join(REPO_ROOT, "packages", "database", "prisma", "migrations");
const MIGRATION_DIR = "00000000000032_generation_start_key";

/** TypeScript with comments stripped, so prose naming a symbol is not mistaken for using it. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

/** `startWithin` and the repository that runs it, comments stripped. */
function startSource(): { within: string; repository: string } {
  const repo = code(readFileSync(join(DATABASE_SRC, "orchestration-repositories.ts"), "utf8"));
  const within = repo.indexOf("async function startWithin(");
  const repository = repo.indexOf("export function createGenerationStartRepository(");
  const after = repo.indexOf("export function createGenerationSceneRepository(");
  expect(within).toBeGreaterThan(-1);
  expect(repository).toBeGreaterThan(within);
  expect(after).toBeGreaterThan(repository);
  return { within: repo.slice(within, repository), repository: repo.slice(repository, after) };
}

/** Every production source file under `dir`, comments stripped. */
function productionSources(dir: string): { name: string; text: string }[] {
  const found: { name: string; text: string }[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".next") continue;
      found.push(...productionSources(full));
    } else if (/\.tsx?$/.test(entry.name) && !entry.name.includes(".test.")) {
      found.push({ name: full.slice(REPO_ROOT.length + 1), text: code(readFileSync(full, "utf8")) });
    }
  }
  return found;
}

describe("qualityTierForResolution", () => {
  it("starts 720p as Normal and 1080p as HQ, the product's only quality choice", () => {
    expect(qualityTierForResolution("720p")).toBe("NORMAL");
    expect(qualityTierForResolution("1080p")).toBe("HIGH_QUALITY");
  });
});

describe("the start key's migration", () => {
  it("is migration 32, and adds one nullable column, its unique index and its length check", () => {
    const dirs = readdirSync(MIGRATIONS, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(dirs.filter((dir) => dir.startsWith("00000000000032_"))).toEqual([MIGRATION_DIR]);
    const sql = readFileSync(join(MIGRATIONS, MIGRATION_DIR, "migration.sql"), "utf8")
      .replace(/--[^\n]*/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    expect(sql).toBe(
      [
        'ALTER TABLE "generation_jobs" ADD COLUMN "idempotencyKey" TEXT;',
        'CREATE UNIQUE INDEX "generation_jobs_videoProjectId_idempotencyKey_key" ON "generation_jobs"("videoProjectId", "idempotencyKey");',
        'ALTER TABLE "generation_jobs" ADD CONSTRAINT "generation_jobs_idempotency_key_check" CHECK ("idempotencyKey" IS NULL OR length("idempotencyKey") BETWEEN 1 AND 200);',
      ].join(" "),
    );
  });
});

describe("the start commit", () => {
  it("holds the project row FOR SHARE, scoped to the organization, before anything else", () => {
    const { within } = startSource();
    const lock = within.indexOf("FOR SHARE");
    expect(lock).toBeGreaterThan(-1);
    expect(within.slice(0, lock)).toContain('"organizationId" = ${organizationId}');
    for (const later of [
      "tx.generationJob.findFirst(",
      "tx.storyboardScene.findMany(",
      "tx.generationJob.create(",
      "reserveJobWithin(",
    ]) {
      expect(within.indexOf(later)).toBeGreaterThan(lock);
    }
  });

  it("answers a replay, checks the storyboard, writes the job, reserves, copies the scenes, then audits", () => {
    const { within } = startSource();
    const order = [
      "tx.generationJob.findFirst(",
      "tx.storyboardScene.findMany(",
      '"STORYBOARD_CHANGED"',
      '"QUALITY_CHANGED"',
      '"DURATION_NOT_SUPPORTED"',
      "tx.generationJob.create(",
      "reserveJobWithin(",
      "tx.generationScene.create(",
      "tx.sceneGenerationRequest.create(",
      "tx.auditLog.create(",
    ].map((needle) => within.indexOf(needle));
    expect(order.every((index) => index > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("returns every refusal before the job is written, and throws every refusal after it", () => {
    const { within } = startSource();
    const job = within.indexOf("tx.generationJob.create(");
    const before = within.slice(0, job);
    const after = within.slice(job);
    expect(before).not.toContain("throw ");
    expect(after).not.toMatch(/return \{ kind: "(?!STARTED)/);
    expect(after.match(/throw new StartRefused\(/g)).toHaveLength(2);
  });

  it("reserves the new job at its first version, from the server clock the record carries", () => {
    const { within } = startSource();
    expect(within).toContain("expectedJobVersion: 1,");
    expect(within).toContain("reservedAt: record.startedAt,");
  });

  it("admits no attempt: the job stays RESERVED and its requests PENDING", () => {
    const { within } = startSource();
    expect(within).not.toContain("admitAttemptWithin");
    expect(within).not.toContain("sceneGenerationAttempt");
    expect(within.match(/state: "[A-Z_]+"/g)).toEqual([
      'state: "CREATED"',
      'state: "PENDING"',
      'state: "PENDING"',
    ]);
  });

  it("refuses an unknown disclosure mode before the transaction opens", () => {
    const { repository } = startSource();
    const refusal = repository.indexOf("if (!isDisclosureMode(record.disclosureMode))");
    expect(refusal).toBeGreaterThan(-1);
    expect(refusal).toBeLessThan(repository.indexOf("prisma.$transaction("));
  });

  it("is constructed by nothing yet: the start service (GS-4c) and route (GS-10) will", () => {
    const constructors = [
      ...productionSources(join(REPO_ROOT, "apps")),
      ...productionSources(join(REPO_ROOT, "packages")),
    ]
      .filter(({ text }) => text.includes("createGenerationStartRepository("))
      .map(({ name }) => name);
    expect(constructors).toEqual(["packages/database/src/orchestration-repositories.ts"]);
  });
});
