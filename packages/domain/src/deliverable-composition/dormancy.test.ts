import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * What Phase 5A may and may not have changed.
 *
 * This phase decides which paid renditions become a customer's video, so the
 * scope claim is the whole safety argument. Five claims:
 *
 * 1. **Dormancy.** Nothing in production constructs the plan repository or
 *    its runner (ADR-0104), or calls the repository except that runner.
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
    join(REPO_ROOT, "apps", "ops", "src"),
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

/**
 * The repository split in two: discovery's method (ADR-0104), and everything
 * else. Discovery may read what the transaction must only read under a lock, so
 * each guard below says which part it is about.
 */
function repositoryParts(): { discovery: string; rest: string } {
  const repo = code(readFileSync(PLAN_REPOSITORY, "utf8"));
  const start = repo.indexOf("async findCompositionPlanCandidates");
  const end = repo.indexOf("async admitCompositionPlan");
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return { discovery: repo.slice(start, end), rest: repo.slice(0, start) + repo.slice(end) };
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

  it("calls the repository nowhere in production but from its own runner", () => {
    for (const { name, text } of productionSources()) {
      if (name.endsWith("packages/database/src/deliverable-composition-repository.ts")) continue;
      if (name === "packages/domain/src/deliverable-composition/runner.ts") continue;
      for (const banned of [".admitCompositionPlan(", ".findCompositionPlanCandidates("]) {
        expect(`${name}:${banned}: ${text.includes(banned)}`).toBe(`${name}:${banned}: false`);
      }
    }
  });

  it("constructs the runner nowhere in production", () => {
    // The pipeline command (GS-9) is what will run it, on the test provider.
    for (const { name, text } of productionSources()) {
      expect(`${name}: ${text.includes("CompositionPlanRunner(")}`).toBe(`${name}: false`);
    }
  });

  it("discovers through one plain read, and claims and leases nothing", () => {
    // Transaction I is its own idempotence, so the pass needs no work row. The
    // composition claim's queue (J1) is not this module's to read.
    for (const { name, text } of phaseSources()) {
      for (const banned of ["findCompositionCandidates", "claim(", "lease"]) {
        expect(`${name}:${banned}: ${text.includes(banned)}`).toBe(`${name}:${banned}: false`);
      }
    }
    const { discovery } = repositoryParts();
    expect(discovery).toContain("validateCompositionPlanBatchLimit(requested)");
    expect(discovery).toContain("prisma.$queryRaw");
    for (const banned of ["FOR UPDATE", "FOR SHARE", "$transaction", "tx.", "UPDATE ", "INSERT", "DELETE"]) {
      expect(`${banned}: ${discovery.includes(banned)}`).toBe(`${banned}: false`);
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
          "CompositionPlanRunner",
          "findCompositionPlanCandidates",
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
        // Discovery reads the reservation *state* as a hint of which composition
        // cycle this is, and is checked below; the banned forms above are the
        // written ones.
        if (name.endsWith("deliverable-composition-repository.ts") && banned === "'CONSUMED'") {
          continue;
        }
        expect(`${name}:${banned}: ${text.includes(banned)}`).toBe(`${name}:${banned}: false`);
      }
    }
    const { discovery, rest } = repositoryParts();
    expect(rest).not.toContain("'CONSUMED'");
    expect(discovery.split("'CONSUMED'")).toHaveLength(2);
    expect(discovery).toContain(`AND res."state" = 'CONSUMED'::"GenerationReservationState"))`);
  });

  it("never writes the job's current deliverable pointer", () => {
    const repo = code(readFileSync(PLAN_REPOSITORY, "utf8"));
    const { discovery, rest } = repositoryParts();
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
      // A lookup key, not an assignment: the replay path resolves the current
      // version through the database rather than trusting the pointer value.
      "where: { id: job.currentDeliverableVersionId,",
    ];
    for (const line of rest.split("\n")) {
      if (!line.includes("currentDeliverableVersionId")) continue;
      expect(`${line.trim()}: ${reads.some((read) => line.includes(read))}`).toBe(
        `${line.trim()}: true`,
      );
    }
    // Discovery names it on exactly two lines, its mirror of the two
    // composition cycles (ADR-0104), and on no other.
    expect(
      discovery
        .split("\n")
        .filter((line) => line.includes("currentDeliverableVersionId"))
        .map((line) => line.trim()),
    ).toEqual(['AND ((j."currentDeliverableVersionId" IS NULL', 'OR (j."currentDeliverableVersionId" IS NOT NULL']);
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
    // Pinned by index rather than as the newest: Phase 5B appends migration 15
    // for composition *execution*, which is a different table and a different
    // review. What this phase still owns is exactly one migration, at the
    // position it was added, and no second one named for it.
    expect(dirs[14]).toBe(MIGRATION_DIR);
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

  it("locks the entitlement hold, then the job, then the scene chain", () => {
    const repo = code(readFileSync(PLAN_REPOSITORY, "utf8"));
    // The *call* sites inside the transaction, not the helper definitions
    // further down the file — acquisition order is what matters.
    const body = repo.slice(repo.indexOf("async admitCompositionPlan"));
    const hold = body.indexOf("await lockReservationForComposition(");
    const job = body.indexOf("await lockJobForComposition(");
    const scenes = body.indexOf("await lockSceneChain(tx");
    expect(hold).toBeGreaterThan(-1);
    expect(job).toBeGreaterThan(-1);
    expect(scenes).toBeGreaterThan(-1);
    // Reservation before job, matching Transaction H's *measured* acquisition
    // order. Reversing the pair would let Transaction I hold the job while
    // waiting for the reservation that settlement already holds.
    expect(hold).toBeLessThan(job);
    expect(job).toBeLessThan(scenes);
    expect(repo).toContain("FOR UPDATE OF j");
    expect(repo).toContain("FOR UPDATE OF res");
    expect(repo).toContain("FOR UPDATE OF r, a");
    // The media verdicts are authority too, and are locked last.
    expect(repo).toContain("FOR UPDATE OF v");
  });

  it("decides on a reservation state that was read under the reservation lock", () => {
    const repo = code(readFileSync(PLAN_REPOSITORY, "utf8"));
    // The state used by the cycle decision comes from the locking helper, and
    // the unlocked value carried by the job read is explicitly overwritten.
    expect(repo).toContain("const reservationState = await lockReservationForComposition(");
    expect(repo).toContain("const job: JobContextRow = { ...locked, reservationState };");
    // And the locking helper is the only place outside discovery that selects
    // `res."state"`. Discovery reads it unlocked as a hint and decides nothing
    // (ADR-0104).
    const { rest } = repositoryParts();
    const selects = rest.split("$queryRaw").filter((s) => s.includes('res."state"'));
    expect(selects).toHaveLength(1);
    for (const statement of selects) {
      expect(`res.state selected without FOR UPDATE OF res: ${statement.includes("FOR UPDATE OF res")}`)
        .toBe("res.state selected without FOR UPDATE OF res: true");
    }
  });

  it("locks every selected media verdict, not just the attempts", () => {
    const repo = code(readFileSync(PLAN_REPOSITORY, "utf8"));
    const lockChain = repo.slice(
      repo.indexOf("async function lockSceneChain"),
      repo.indexOf("async function readSceneInputs"),
    );
    expect(lockChain).toContain('JOIN "managed_output_media_validations" v');
    expect(lockChain).toContain("FOR UPDATE OF v");
    // Same deterministic order as the scene and attempt locks above it.
    expect(lockChain.split("ORDER BY").length - 1).toBe(3);
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
