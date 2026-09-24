import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * What Phase 5A may and may not have changed.
 *
 * This phase decides which paid renditions become a customer's video, so the
 * scope claim is the whole safety argument. Five claims:
 *
 * 1. **Dormancy.** Nothing constructs the plan repository, schedules it, or
 *    calls it. There is no runner, and no actor for `COMPOSITION_PENDING`.
 * 2. **No composition.** Nothing here can reach `ffmpeg`, `ffprobe`, an object
 *    store, a provider or an HTTP client. Planning is database-only.
 * 3. **No normalization policy.** No codec, bitrate, frame rate, crop, padding
 *    or audio-mix decision is frozen yet — that is Phase 5B's.
 * 4. **No billing.** Planning consumes no unit and moves no reservation.
 * 5. **The current pointer never moves.** Planning creates a version; it never
 *    publishes one.
 *
 * Checks are architectural where that is stronger than a filename: what a module
 * *imports* and what symbols it *names* survive a rename and a copy-paste.
 */

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const MODULE_DIR = __dirname;
const PLAN_REPOSITORY = join(
  REPO_ROOT,
  "packages",
  "database",
  "src",
  "deliverable-composition-repository.ts",
);
const MIGRATION_DIR = "00000000000014_phase5a_deliverable_composition_plan";
const MIGRATION = join(
  REPO_ROOT,
  "packages",
  "database",
  "prisma",
  "migrations",
  MIGRATION_DIR,
  "migration.sql",
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
        found.push({
          name: full.slice(REPO_ROOT.length + 1),
          text: code(readFileSync(full, "utf8")),
        });
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
    join(REPO_ROOT, "packages", "database", "src"),
    join(REPO_ROOT, "packages", "video-providers", "src"),
    join(REPO_ROOT, "packages", "storage", "src"),
    join(REPO_ROOT, "packages", "domain", "src"),
    join(REPO_ROOT, "packages", "shared", "src"),
  ]
    .filter((dir) => existsSync(dir))
    .flatMap(sourceFiles);
}

/** This phase's own production files: the domain module and the SQL repository. */
function phaseSources(): { name: string; text: string }[] {
  return [
    ...sourceFiles(MODULE_DIR),
    {
      name: PLAN_REPOSITORY.slice(REPO_ROOT.length + 1),
      text: code(readFileSync(PLAN_REPOSITORY, "utf8")),
    },
  ];
}

// ---------------------------------------------------------------------------

describe("the capability exists but nothing runs it", () => {
  it("constructs the plan repository nowhere in production", () => {
    for (const { name, text } of productionSources()) {
      if (name.endsWith("packages/database/src/deliverable-composition-repository.ts")) continue;
      if (name.endsWith("packages/database/src/index.ts")) continue;
      expect(`${name}: ${text.includes("createDeliverableCompositionPlanRepository(")}`).toBe(
        `${name}: false`,
      );
    }
  });

  it("invokes the admission entry point nowhere in production", () => {
    for (const { name, text } of productionSources()) {
      if (name.endsWith("packages/database/src/deliverable-composition-repository.ts")) continue;
      expect(`${name}: ${text.includes(".admitCompositionPlan(")}`).toBe(`${name}: false`);
    }
  });

  it("ships no runner and no candidate discovery", () => {
    // A queue with nothing draining it would suggest work is happening that is
    // not. Phase 5B owns both.
    expect(existsSync(join(MODULE_DIR, "runner.ts"))).toBe(false);
    for (const { name, text } of phaseSources()) {
      for (const banned of ["Runner", "findCompositionCandidates", "claim(", "lease"]) {
        expect(`${name}:${banned}: ${text.includes(banned)}`).toBe(`${name}:${banned}: false`);
      }
    }
  });

  it("has no scheduler, cron, interval, queue consumer or startup hook", () => {
    for (const { name, text } of phaseSources()) {
      for (const banned of [
        "setInterval",
        "setTimeout",
        "setImmediate",
        "cron",
        "schedule(",
        "queueMicrotask",
        "process.on",
        "node:child_process",
        "execFile",
        "spawn(",
      ]) {
        expect(`${name}:${banned}: ${text.includes(banned)}`).toBe(`${name}:${banned}: false`);
      }
    }
  });

  it("is reachable from no application entry point", () => {
    for (const dir of [
      join(REPO_ROOT, "apps", "web", "src"),
      join(REPO_ROOT, "apps", "worker", "src"),
    ]) {
      if (!existsSync(dir)) continue;
      for (const { name, text } of sourceFiles(dir)) {
        for (const banned of [
          "deliverable-composition",
          "createDeliverableCompositionPlanRepository",
          "admitCompositionPlan",
          "computeDeliverableInputFingerprint",
        ]) {
          expect(`${name}:${banned}: ${text.includes(banned)}`).toBe(`${name}:${banned}: false`);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------

describe("planning composes nothing", () => {
  it("reaches no media tool, object store, provider or HTTP client", () => {
    for (const { name, text } of phaseSources()) {
      for (const banned of [
        "ffmpeg",
        "ffprobe",
        "@app/video-providers",
        "@app/storage",
        "@app/ai-providers",
        "fetch(",
        "axios",
        "undici",
        "node:http",
        "node:https",
        "node:fs",
        "@aws-sdk",
        "outputStorageKey",
        "signedUrl",
      ]) {
        expect(`${name}:${banned}: ${text.includes(banned)}`).toBe(`${name}:${banned}: false`);
      }
    }
  });

  it("names no credential", () => {
    for (const { name, text } of phaseSources()) {
      for (const banned of [
        "FAL_KEY",
        "WAVESPEED_API_KEY",
        "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY",
        "STORAGE_SIGNING_SECRET",
        "armProviderBoundary",
        "authorizePaidSubmission",
      ]) {
        expect(`${name}:${banned}: ${text.includes(banned)}`).toBe(`${name}:${banned}: false`);
      }
    }
  });

  it("freezes no normalization or encoder policy", () => {
    // Phase 5B decides these, before any byte is produced. A guess recorded now
    // would be a policy nobody chose, stored as if someone had.
    for (const { name, text } of phaseSources()) {
      for (const banned of [
        "bitrate",
        "codec",
        "frameRate",
        "framerate",
        "letterbox",
        "crop",
        "padding",
        "watermark",
        "audioMix",
        "transition",
        "UPSCALE",
        "DOWNSCALE",
      ]) {
        expect(`${name}:${banned}: ${text.includes(banned)}`).toBe(`${name}:${banned}: false`);
      }
    }
  });
});

// ---------------------------------------------------------------------------

describe("planning never bills and never publishes", () => {
  it("consumes no unit and moves no reservation", () => {
    for (const { name, text } of phaseSources()) {
      for (const banned of [
        "'CONSUMED'",
        '"CONSUMED"::',
        "consumedAt",
        "releasedAt",
        "generationReservation.update",
        "quota",
        "Quota",
        "ledger",
      ]) {
        // The reservation *state* is read as evidence of which composition cycle
        // this is; the banned forms above are the written ones.
        if (name.endsWith("deliverable-composition-repository.ts") && banned === "'CONSUMED'") {
          continue;
        }
        expect(`${name}:${banned}: ${text.includes(banned)}`).toBe(`${name}:${banned}: false`);
      }
    }
  });

  it("never writes the job's current deliverable pointer", () => {
    const repo = code(readFileSync(PLAN_REPOSITORY, "utf8"));
    // An allowlist rather than a banned substring, because the column has to
    // appear here: it is read to decide the composition cycle and read again to
    // prove it unmoved. Every line that names it must be one of those reads, so
    // a line that *writes* it has nowhere to hide.
    const reads = [
      'AS "currentDeliverableVersionId"',
      "readonly currentDeliverableVersionId:",
      "currentDeliverableVersionId: true",
      ".currentDeliverableVersionId ===",
      ".currentDeliverableVersionId !==",
    ];
    for (const line of repo.split("\n")) {
      if (!line.includes("currentDeliverableVersionId")) continue;
      expect(`${line.trim()}: ${reads.some((read) => line.includes(read))}`).toBe(
        `${line.trim()}: true`,
      );
    }
    expect(repo).not.toContain('SET "currentDeliverableVersionId"');
    expect(repo).toContain("CURRENT_DELIVERABLE_POINTER_MOVED");
  });

  it("advances the job no further than COMPOSITION_PENDING", () => {
    const repo = code(readFileSync(PLAN_REPOSITORY, "utf8"));
    for (const banned of ["COMPOSING", "DELIVERABLE_VALIDATING", "DELIVERABLE_READY"]) {
      expect(`${banned}: ${repo.includes(banned)}`).toBe(`${banned}: false`);
    }
  });

  it("mutates no source history row", () => {
    const repo = code(readFileSync(PLAN_REPOSITORY, "utf8"));
    for (const banned of [
      "sceneGenerationRequest.update",
      "sceneGeneration.update",
      "managedOutputMediaValidation.update",
      "generationScene.update",
      'UPDATE "scene_generation_requests"',
      'UPDATE "scene_generations"',
      'UPDATE "managed_output_media_validations"',
      'UPDATE "generation_scenes"',
    ]) {
      expect(`${banned}: ${repo.includes(banned)}`).toBe(`${banned}: false`);
    }
  });
});

// ---------------------------------------------------------------------------

describe("durable shape", () => {
  it("adds exactly one migration, and it is this phase's", () => {
    const migrations = join(REPO_ROOT, "packages", "database", "prisma", "migrations");
    const dirs = readdirSync(migrations, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(dirs.at(-1)).toBe(MIGRATION_DIR);
    expect(dirs.filter((dir) => dir.includes("phase5a"))).toEqual([MIGRATION_DIR]);
  });

  it("backfills nothing and rewrites no orchestration row", () => {
    const migration = readFileSync(MIGRATION, "utf8");
    // `UPDATE "` rather than `UPDATE `, because `ON UPDATE CASCADE` is a foreign
    // key clause and not a data rewrite.
    for (const banned of ['UPDATE "', "INSERT INTO", "DELETE FROM", "SELECT "]) {
      expect(`${banned}: ${migration.includes(banned)}`).toBe(`${banned}: false`);
    }
    // The job table is touched for exactly one thing: the foreign key that binds
    // its existing pointer column. No column is added, dropped or rewritten.
    const jobStatements = migration
      .split("\n")
      .filter((line) => line.includes('ALTER TABLE "generation_jobs"'));
    expect(jobStatements).toHaveLength(1);
    expect(jobStatements[0]).toContain("ADD CONSTRAINT");
    expect(jobStatements[0]).toContain("FOREIGN KEY");
  });

  it("keeps the shape constraints in the database, not only in TypeScript", () => {
    const migration = readFileSync(MIGRATION, "utf8");
    expect(migration).toContain("generation_deliverable_version_ordinal_check");
    expect(migration).toContain("generation_deliverable_input_position_check");
    expect(migration).toContain("generation_deliverable_input_receipt_check");
    expect(migration).toContain("generation_deliverable_versions_generationJobId_ordinal_key");
    expect(migration).toContain("generation_deliverable_inputs_deliverableVersionId_position_key");
    expect(migration).toContain("generation_deliverable_inputs_deliverableVersionId_generati_key");
  });

  it("binds the job pointer to a version of the same job", () => {
    const migration = readFileSync(MIGRATION, "utf8");
    // The composite key is the whole ownership guarantee. A single-column FK
    // would permit one job to point at another job's deliverable.
    expect(migration).toContain("generation_deliverable_versions_id_generationJobId_key");
    expect(migration).toContain(
      'FOREIGN KEY ("currentDeliverableVersionId", "id") REFERENCES "generation_deliverable_versions"("id", "generationJobId")',
    );
  });

  it("restricts every history foreign key", () => {
    const migration = readFileSync(MIGRATION, "utf8");
    const keys = migration.split("\n").filter((line) => line.includes("FOREIGN KEY"));
    expect(keys.length).toBeGreaterThanOrEqual(6);
    for (const key of keys) {
      expect(`${key.slice(0, 60)}: ${key.includes("ON DELETE RESTRICT")}`).toBe(
        `${key.slice(0, 60)}: true`,
      );
    }
  });
});

// ---------------------------------------------------------------------------

describe("the authorities the transaction must use", () => {
  it("selects scene inputs by the delivered pointer, never by recency", () => {
    const repo = code(readFileSync(PLAN_REPOSITORY, "utf8"));
    expect(repo).toContain('r."id" = s."currentDeliveredRequestId"');
    expect(repo).toContain('r."generationSceneId" = s."id"');
    // `createdAt` would order two requests admitted in the same millisecond
    // arbitrarily, and "newest" is not what the customer currently holds.
    expect(repo).not.toContain('r."createdAt"');
    expect(repo).not.toContain("orderBy: { createdAt");
  });

  it("selects the latest attempt by ordinal, never by createdAt", () => {
    const repo = code(readFileSync(PLAN_REPOSITORY, "utf8"));
    expect(repo).toContain('MAX(sib."attemptOrdinal")');
    expect(repo).not.toContain('a."createdAt"');
  });

  it("derives the ordinal inside the transaction and accepts none", () => {
    const repo = code(readFileSync(PLAN_REPOSITORY, "utf8"));
    expect(repo).toContain("generationDeliverableVersion.aggregate");
    expect(repo).toContain("_max: { ordinal: true }");
    // The port offers no ordinal to supply.
    const ports = code(readFileSync(join(MODULE_DIR, "ports.ts"), "utf8"));
    expect(ports).not.toContain("ordinal");
  });

  it("takes the job lock before the scene chain", () => {
    const repo = code(readFileSync(PLAN_REPOSITORY, "utf8"));
    const job = repo.indexOf("lockJobForTenant(tx");
    const scenes = repo.indexOf("lockSceneChain(tx");
    expect(job).toBeGreaterThan(-1);
    expect(scenes).toBeGreaterThan(-1);
    expect(job).toBeLessThan(scenes);
    // Named aliases, so the project and reservation joined as evidence are not
    // locked along with the row this transaction actually moves.
    expect(repo).toContain("FOR UPDATE OF j");
    expect(repo).toContain("FOR UPDATE OF r, a");
  });

  it("takes no cost-admission advisory lock", () => {
    // Planning authorizes no provider call and moves no quota, so it must not
    // serialize against the gate that does.
    const repo = code(readFileSync(PLAN_REPOSITORY, "utf8"));
    for (const banned of ["pg_advisory", "acquireCostAdmissionLock", "costAdmissionLockKeys"]) {
      expect(`${banned}: ${repo.includes(banned)}`).toBe(`${banned}: false`);
    }
  });
});
