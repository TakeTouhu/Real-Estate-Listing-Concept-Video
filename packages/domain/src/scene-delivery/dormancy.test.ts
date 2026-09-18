import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * What Phase 4C-3B-2H-3B-6A may and may not have changed.
 *
 * The capability is new and real: production source may now contain an atomic
 * validated-delivery transaction and a runner that drives it. What must remain
 * impossible is everything the phase deliberately excluded — so these
 * assertions are the cheap, structural half of that promise, and the database
 * suite is the expensive half.
 *
 * Three claims:
 *
 * 1. **Dormancy.** Nothing in production constructs the runner, schedules it or
 *    calls it. A `VALID` verdict still does not deliver by itself; turning that
 *    on is a separate reviewed decision.
 * 2. **Scope freeze.** Delivery cannot reach recovery, provider submission,
 *    composition, the deliverable, quota, the reservation or money. The only
 *    Job state it names is `SCENES_READY`.
 * 3. **No new durable shape.** No migration, no column, no second delivery
 *    status, no second pointer table, no duplicated media fact.
 */

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const DELIVERY_DIR = __dirname;
const DELIVERY_REPOSITORY = join(
  REPO_ROOT,
  "packages",
  "database",
  "src",
  "validated-scene-delivery-repository.ts",
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
        if (entry.name === "testing") continue;
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
  ]
    .filter((dir) => existsSync(dir))
    .flatMap(sourceFiles);
}

/** This phase's own production files: the domain module and the SQL repository. */
function deliverySources(): { name: string; text: string }[] {
  return [
    ...sourceFiles(DELIVERY_DIR),
    {
      name: DELIVERY_REPOSITORY.slice(REPO_ROOT.length + 1),
      text: code(readFileSync(DELIVERY_REPOSITORY, "utf8")),
    },
  ];
}

const repositoryCode = (): string => code(readFileSync(DELIVERY_REPOSITORY, "utf8"));

// ---------------------------------------------------------------------------

describe("the capability exists but nothing runs it", () => {
  it("constructs the delivery runner nowhere in production", () => {
    for (const { name, text } of productionSources()) {
      if (name.endsWith("scene-delivery/runner.ts")) continue;
      if (name.endsWith("scene-delivery/index.ts")) continue;
      if (name.endsWith("packages/domain/src/index.ts")) continue;
      for (const banned of [
        "new ValidatedSceneDeliveryRunner",
        "ValidatedSceneDeliveryRunner(",
      ]) {
        expect(`${name}:${banned}: ${text.includes(banned)}`).toBe(`${name}:${banned}: false`);
      }
    }
  });

  it("constructs the delivery repository nowhere in production", () => {
    for (const { name, text } of productionSources()) {
      if (name.endsWith("packages/database/src/validated-scene-delivery-repository.ts")) continue;
      if (name.endsWith("packages/database/src/index.ts")) continue;
      const banned = "createValidatedSceneDeliveryRepository(";
      expect(`${name}: ${text.includes(banned)}`).toBe(`${name}: false`);
    }
  });

  it("calls runOnce nowhere in production", () => {
    for (const { name, text } of productionSources()) {
      if (name.endsWith("scene-delivery/runner.ts")) continue;
      if (name.endsWith("media-validation-lifecycle/runner.ts")) continue;
      for (const banned of [".runOnce(", ".deliverValidatedScene(", ".findValidatedDeliveryCandidates("]) {
        expect(`${name}:${banned}: ${text.includes(banned)}`).toBe(`${name}:${banned}: false`);
      }
    }
  });

  it("has no scheduler, cron, interval, subprocess, network or credential read", () => {
    for (const { name, text } of deliverySources()) {
      for (const banned of [
        "setInterval",
        "setTimeout",
        "cron",
        "schedule(",
        "node:child_process",
        "execFile",
        "fetch(",
        "S3Client",
        "process.env",
        "FAL_KEY",
        "WAVESPEED_API_KEY",
        "AWS_ACCESS_KEY_ID",
      ]) {
        expect(`${name}:${banned}: ${text.includes(banned)}`).toBe(`${name}:${banned}: false`);
      }
    }
  });

  it("introduces no credential into the environment schema", () => {
    const env = code(readFileSync(join(REPO_ROOT, "packages", "shared", "src", "env.ts"), "utf8"));
    for (const banned of [
      "FAL_KEY",
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_SESSION_TOKEN",
      "S3_BUCKET",
      "FFPROBE_PATH",
    ]) {
      expect(`${banned}: ${env.includes(banned)}`).toBe(`${banned}: false`);
    }
  });
});

// ---------------------------------------------------------------------------

describe("delivery cannot reach recovery, composition, the deliverable or money", () => {
  it("names none of the excluded vocabulary", () => {
    for (const { name, text } of deliverySources()) {
      for (const banned of [
        // Recovery and provider work: a different failure and cost domain.
        "SYSTEM_RECOVERY",
        "INVALID_MEDIA",
        "INTEGRITY_MISMATCH",
        "RETRYABLE",
        "providerPredictionId",
        "submissionCertainty",
        "pricingContractKey",
        // Composition, the deliverable and everything past SCENES_READY.
        "COMPOSITION_PENDING",
        "COMPOSING",
        "DELIVERABLE_VALIDATING",
        "DELIVERABLE_READY",
        "GenerationDeliverable",
        "ffmpeg",
        "upscale",
        // Money. Quota CONSUME belongs to Transaction G, RELEASE to recovery,
        // and settlement to neither.
        "reservation",
        "Reservation",
        "quota",
        "Quota",
        "CONSUME",
        "RELEASE",
        "settle",
        "entitlement",
        "stripe",
      ]) {
        expect(`${name}:${banned}: ${text.includes(banned)}`).toBe(`${name}:${banned}: false`);
      }
    }
  });

  it("names SCENES_READY as the only Job state it advances to", () => {
    const repo = repositoryCode();
    expect(repo.includes("SCENES_READY")).toBe(true);
    for (const beyond of [
      "COMPOSITION_PENDING",
      "COMPOSING",
      "DELIVERABLE_VALIDATING",
      "DELIVERABLE_READY",
      "FAILED_TERMINAL",
      "CANCELLED",
    ]) {
      expect(`${beyond}: ${repo.includes(beyond)}`).toBe(`${beyond}: false`);
    }
  });

  it("creates no row of any kind and writes no attempt", () => {
    const repo = repositoryCode();
    // Every write is an `updateMany` compare-and-set. The only row this
    // transaction creates is the transition event, and that goes through the
    // single existing event writer rather than a second one here.
    for (const banned of [
      "sceneGeneration.create",
      "sceneGeneration.update",
      "sceneGenerationRequest.create",
      "generationScene.create",
      "generationJob.create",
      "generationTransitionEvent.create",
      "managedOutputMediaValidation.update",
      "managedOutputMediaValidation.create",
      "INSERT INTO",
      // A raw update of a quoted table. `FOR UPDATE OF` is the lock clause and
      // is not followed by a quoted identifier, so it does not match.
      'UPDATE "',
      "DELETE FROM",
    ]) {
      expect(`${banned}: ${repo.includes(banned)}`).toBe(`${banned}: false`);
    }
    expect(repo.includes("appendGenerationEvent")).toBe(true);
  });

  it("re-reads authority under its own locks instead of trusting the listing", () => {
    const repo = repositoryCode();
    // The Job is locked first, and the readiness decision happens under it.
    expect(repo.includes("FOR UPDATE OF j, s, r, a")).toBe(true);
    // Latest-attempt authority is the durable ordinal, never a timestamp.
    expect(repo.includes("attemptOrdinal")).toBe(true);
    expect(repo.includes("maxAttemptOrdinal")).toBe(true);
    for (const banned of ['ORDER BY a."createdAt"', 'a."createdAt" DESC', 'MAX(sib."createdAt")']) {
      expect(`${banned}: ${repo.includes(banned)}`).toBe(`${banned}: false`);
    }
  });

  it("keeps the domain free of storage and database imports", () => {
    for (const { name, text } of sourceFiles(DELIVERY_DIR)) {
      for (const banned of ["@app/storage", "@app/database", "@prisma/client", "$transaction"]) {
        expect(`${name}:${banned}: ${text.includes(banned)}`).toBe(`${name}:${banned}: false`);
      }
    }
  });

  it("offers no boundary method that takes a callback", () => {
    // Structural: nothing external can be smuggled into Transaction F if no
    // port method accepts something to run inside it.
    const ports = code(readFileSync(join(DELIVERY_DIR, "ports.ts"), "utf8"));
    for (const banned of ["=> Promise<", "callback", "withDelivery", "runInTransaction"]) {
      expect(`${banned}: ${ports.includes(banned)}`).toBe(`${banned}: false`);
    }
  });
});

// ---------------------------------------------------------------------------

describe("no new durable shape", () => {
  it("adds no migration", () => {
    const migrations = join(REPO_ROOT, "packages", "database", "prisma", "migrations");
    const dirs = readdirSync(migrations, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    // Pinned to the newest migration, so an unreviewed one still trips this.
    // Migration 12 belongs to Phase 4C-3B-2H-3B-5; this phase needed no schema
    // change, because `deliveredAt`, `currentDeliveredRequestId` and
    // `stateVersion` already existed.
    expect(dirs.at(-1)).toBe("00000000000012_phase4c3b2h3b5_media_validation_lifecycle");
    expect(dirs.filter((dir) => dir.includes("6a") || dir.includes("delivery"))).toEqual([]);
  });

  it("adds no delivery column, status or second pointer to the schema", () => {
    const schema = readFileSync(
      join(REPO_ROOT, "packages", "database", "prisma", "schema.prisma"),
      "utf8",
    );
    for (const banned of [
      "deliveryAppliedAt",
      "processedAt",
      "deliveredVersion",
      "DeliveryStatus",
      "SceneDeliveryStatus",
      "model SceneDelivery",
      "deliveredRequestHistory",
      "mediaDurationMs",
      "deliveredSha256",
    ]) {
      expect(`${banned}: ${schema.includes(banned)}`).toBe(`${banned}: false`);
    }
    // The fields delivery actually uses were already there.
    for (const required of ["deliveredAt", "currentDeliveredRequestId", "stateVersion"]) {
      expect(`${required}: ${schema.includes(required)}`).toBe(`${required}: true`);
    }
  });

  it("keeps the request and scene state vocabularies closed", () => {
    const schema = readFileSync(
      join(REPO_ROOT, "packages", "database", "prisma", "schema.prisma"),
      "utf8",
    );
    for (const invented of [
      "DELIVERING",
      "DELIVERY_PENDING",
      "MEDIA_VALIDATED",
      "READY_PENDING",
      "SCENES_DELIVERED",
    ]) {
      expect(`${invented}: ${schema.includes(invented)}`).toBe(`${invented}: false`);
    }
  });
});
