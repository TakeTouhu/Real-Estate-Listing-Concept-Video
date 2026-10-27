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
  it("takes Transaction B's two locks before it holds the project row", () => {
    // The cost-admission lock is the outermost lock in the system: no row lock
    // may be held while it is acquired (cost-admission-lock.ts).
    const { within } = startSource();
    const order = [
      "acquireReservationAdmissionLock(tx, organizationId, record.jobId)",
      "findPeriodContaining(tx, organizationId, record.startedAt)",
      "acquireCostAdmissionLock(tx, organizationId, period.billingCycleKey)",
      "FOR SHARE",
    ].map((needle) => within.indexOf(needle));
    expect(order.every((index) => index > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // A start no period covers is refused before the job, so Transaction B
    // never takes a cost-admission lock under the project row.
    expect(within.indexOf('if (period === null) return { kind: "NO_ENTITLEMENT_PERIOD" };')).toBeLessThan(
      within.indexOf("tx.generationJob.create("),
    );
  });

  it("holds the project row FOR SHARE, scoped to the organization, before it reads or writes anything", () => {
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

  it("refuses an unknown disclosure mode and a key the column cannot hold before the transaction opens", () => {
    const { repository } = startSource();
    const transaction = repository.indexOf("prisma.$transaction(");
    for (const refusal of [
      "if (!isDisclosureMode(record.disclosureMode))",
      'if (typeof key !== "string" || key.length < 1 || key.length > MAX_IDEMPOTENCY_KEY_LENGTH)',
    ]) {
      expect(repository.indexOf(refusal)).toBeGreaterThan(-1);
      expect(repository.indexOf(refusal)).toBeLessThan(transaction);
    }
  });

  it("files the audit entry under the organization whose project it locked", () => {
    const { within } = startSource();
    const check = within.indexOf("if (audit.organizationId !== organizationId)");
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(within.indexOf("tx.auditLog.create("));
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

describe("the project row and the cost-admission lock", () => {
  /** Each lock or write on a `video_projects` row in the database package, by file. */
  function projectRowLocks(): Record<string, string[]> {
    const found: Record<string, string[]> = {};
    for (const name of readdirSync(DATABASE_SRC).filter((file) => file.endsWith(".ts") && !file.includes(".test."))) {
      const text = code(readFileSync(join(DATABASE_SRC, name), "utf8"));
      const locks: string[] = [];
      for (const [query] of text.matchAll(/`[^`]*`/g)) {
        if (!query.includes("video_projects")) continue;
        // Unqualified, the lock covers every table the query joins.
        for (const [lock] of query.matchAll(/FOR (?:NO KEY UPDATE|UPDATE|KEY SHARE|SHARE)(?! OF)/g)) locks.push(lock);
        if (/UPDATE "video_projects"|DELETE FROM "video_projects"/.test(query)) locks.push("raw write");
      }
      for (const [write] of text.matchAll(/videoProject\.(?:update|updateMany|upsert|delete|deleteMany)\(/g)) {
        locks.push(write);
      }
      if (locks.length > 0) found[name] = locks;
    }
    return found;
  }

  it("is locked or written only by job creation, composition and the start", () => {
    // A new one must be checked against the lock order before it is added
    // here: nothing may hold a project row while it acquires the
    // cost-admission lock (ADR-0087 Decision 3).
    expect(projectRowLocks()).toEqual({
      // Job creation's snapshot read, then the start's.
      "orchestration-repositories.ts": ["FOR SHARE", "FOR SHARE"],
      // Composition's lock and write, and `projects.update`.
      "storyboard-repositories.ts": ["FOR NO KEY UPDATE", "videoProject.updateMany(", "videoProject.update("],
    });
  });

  it("is never held by composition or job creation while an advisory lock is taken", () => {
    const storyboard = code(readFileSync(join(DATABASE_SRC, "storyboard-repositories.ts"), "utf8"));
    expect(storyboard).not.toMatch(/acquire\w*Lock\(/);
    const repo = code(readFileSync(join(DATABASE_SRC, "orchestration-repositories.ts"), "utf8"));
    const jobs = repo.slice(
      repo.indexOf("export function createGenerationJobRepository("),
      repo.indexOf("async function reserveJobWithin("),
    );
    expect(jobs).toContain("lockProjectOutputConfig(");
    expect(jobs).not.toMatch(/acquire\w*Lock\(/);
  });
});
