import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * What Phase 4C-3B-2H-3B-6B may and may not have changed.
 *
 * The capability is real: production source may now contain a bounded automatic
 * media-failure recovery policy, a same-route pricing planner, a recovery
 * admission repository and a runner. What must remain impossible is the thing
 * the cap exists to prevent — money being spent without anyone deciding to.
 *
 * Four claims:
 *
 * 1. **Dormancy.** Nothing constructs the runner, schedules it, or calls it.
 * 2. **No paid boundary.** Nothing in this module can reach a provider, an HTTP
 *    client, a paid-submission authorization or a credential.
 * 3. **Scope freeze.** Recovery cannot mutate quota, the reservation,
 *    composition or the deliverable.
 * 4. **No new durable shape.** No migration, no column.
 *
 * Checks are architectural where that is stronger than a filename: what a
 * module *imports* and what symbols it *names* survive a rename, a moved file
 * and a copy-paste into a new location.
 */

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const RECOVERY_DIR = __dirname;
const RECOVERY_REPOSITORY = join(
  REPO_ROOT,
  "packages",
  "database",
  "src",
  "media-recovery-repository.ts",
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
function recoverySources(): { name: string; text: string }[] {
  return [
    ...sourceFiles(RECOVERY_DIR),
    {
      name: RECOVERY_REPOSITORY.slice(REPO_ROOT.length + 1),
      text: code(readFileSync(RECOVERY_REPOSITORY, "utf8")),
    },
  ];
}

// ---------------------------------------------------------------------------

describe("the capability exists but nothing runs it", () => {
  it("constructs the recovery runner nowhere in production", () => {
    for (const { name, text } of productionSources()) {
      if (name.endsWith("media-recovery/runner.ts")) continue;
      if (name.endsWith("media-recovery/index.ts")) continue;
      if (name.endsWith("packages/domain/src/index.ts")) continue;
      for (const banned of [
        "new AutomaticMediaFailureRecoveryRunner",
        "AutomaticMediaFailureRecoveryRunner(",
      ]) {
        expect(`${name}:${banned}: ${text.includes(banned)}`).toBe(`${name}:${banned}: false`);
      }
    }
  });

  it("constructs the recovery planner and repository nowhere in production", () => {
    for (const { name, text } of productionSources()) {
      if (name.endsWith("media-recovery/planner.ts")) continue;
      if (name.endsWith("media-recovery/index.ts")) continue;
      if (name.endsWith("packages/domain/src/index.ts")) continue;
      if (name.endsWith("packages/database/src/media-recovery-repository.ts")) continue;
      if (name.endsWith("packages/database/src/index.ts")) continue;
      for (const banned of [
        "new AutomaticMediaRecoveryPricingPlanner",
        "createAutomaticMediaRecoveryRepository(",
      ]) {
        expect(`${name}:${banned}: ${text.includes(banned)}`).toBe(`${name}:${banned}: false`);
      }
    }
  });

  it("invokes no recovery entry point anywhere in production", () => {
    for (const { name, text } of productionSources()) {
      if (name.endsWith("media-recovery/runner.ts")) continue;
      for (const banned of [
        ".runOnce(",
        ".admitAutomaticMediaRecovery(",
        ".findAutomaticMediaRecoveryCandidates(",
      ]) {
        // The scene-delivery and media-validation runners define their own
        // `runOnce`; what is banned here is a production *caller* of any of
        // them, which is the property that keeps all three unscheduled.
        if (name.endsWith("scene-delivery/runner.ts")) continue;
        if (name.endsWith("media-validation-lifecycle/runner.ts")) continue;
        expect(`${name}:${banned}: ${text.includes(banned)}`).toBe(`${name}:${banned}: false`);
      }
    }
  });

  it("has no scheduler, cron, interval, queue consumer or startup hook", () => {
    for (const { name, text } of recoverySources()) {
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
      ]) {
        expect(`${name}:${banned}: ${text.includes(banned)}`).toBe(`${name}:${banned}: false`);
      }
    }
  });

  it("is reachable from no application entry point", () => {
    // Architectural rather than filename-based: whatever an entry point is
    // called, it must not import this module's identifiers.
    for (const dir of [join(REPO_ROOT, "apps", "web", "src"), join(REPO_ROOT, "apps", "worker", "src")]) {
      if (!existsSync(dir)) continue;
      for (const { name, text } of sourceFiles(dir)) {
        for (const banned of [
          "media-recovery",
          "AutomaticMediaFailureRecoveryRunner",
          "AutomaticMediaRecoveryPricingPlanner",
          "createAutomaticMediaRecoveryRepository",
        ]) {
          expect(`${name}:${banned}: ${text.includes(banned)}`).toBe(`${name}:${banned}: false`);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------

describe("the paid provider boundary stays closed", () => {
  it("imports no provider, storage or HTTP capability", () => {
    for (const { name, text } of recoverySources()) {
      for (const banned of [
        "@app/video-providers",
        "@app/storage",
        "@app/ai-providers",
        "fetch(",
        "XMLHttpRequest",
        "axios",
        "undici",
        "node:http",
        "node:https",
        "S3Client",
      ]) {
        expect(`${name}:${banned}: ${text.includes(banned)}`).toBe(`${name}:${banned}: false`);
      }
    }
  });

  it("invokes no paid-submission authorization", () => {
    for (const { name, text } of recoverySources()) {
      for (const banned of [
        "armProviderBoundary",
        "PaidSubmissionAuthorization",
        "withCostAdmission",
        "paid-submission",
        "submit(",
        "VideoGenerationProvider",
      ]) {
        expect(`${name}:${banned}: ${text.includes(banned)}`).toBe(`${name}:${banned}: false`);
      }
    }
  });

  it("implements no production exchange-rate source", () => {
    // `FxRateSource` is a port. A production *implementation* of it would be
    // the network integration this phase must not add, so no production file
    // outside the port's own declaration may claim to be one.
    for (const { name, text } of productionSources()) {
      if (name.endsWith("media-recovery/ports.ts")) continue;
      for (const banned of ["implements FxRateSource", ": FxRateSource =", "FxRateSource {"]) {
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
      "FX_API_KEY",
      "FX_API_URL",
      "FX_RATE_URL",
    ]) {
      expect(`${banned}: ${env.includes(banned)}`).toBe(`${banned}: false`);
    }
    // `WAVESPEED_API_KEY` is deliberately absent from that list: it has been in
    // the environment schema since the provider was specified, long before this
    // phase, and removing it is not this phase's decision. What matters here is
    // that recovery cannot reach it — asserted below.
    expect(env.includes("WAVESPEED_API_KEY")).toBe(true);
  });

  it("names no credential anywhere in the recovery module", () => {
    for (const { name, text } of recoverySources()) {
      for (const banned of [
        "WAVESPEED_API_KEY",
        "FAL_KEY",
        "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY",
        "apiKey",
        "Authorization",
        "Bearer",
        "process.env",
      ]) {
        expect(`${name}:${banned}: ${text.includes(banned)}`).toBe(`${name}:${banned}: false`);
      }
    }
  });
});

// ---------------------------------------------------------------------------

describe("recovery cannot reach quota, the reservation, composition or the deliverable", () => {
  it("names none of the excluded vocabulary", () => {
    for (const { name, text } of recoverySources()) {
      for (const banned of [
        // Money.
        "generationReservation",
        "GenerationReservation",
        "RESERVED->",
        "CONSUMED",
        "RELEASED",
        "RECONCILIATION_HOLD",
        "quota",
        "Quota",
        "settle",
        "stripe",
        // Composition, the deliverable and everything past SCENES_READY.
        "COMPOSITION_PENDING",
        "COMPOSING",
        "DELIVERABLE_VALIDATING",
        "DELIVERABLE_READY",
        "SCENES_READY",
        "ffmpeg",
        "upscale",
        // Customer regeneration.
        "userRegenerationOrdinal",
        "usedUserRegenerationCount",
        "admitUserRegeneration",
      ]) {
        expect(`${name}:${banned}: ${text.includes(banned)}`).toBe(`${name}:${banned}: false`);
      }
    }
  });

  it("writes no row of its own and mutates no customer-facing aggregate", () => {
    const repo = code(readFileSync(RECOVERY_REPOSITORY, "utf8"));
    // Every row this phase creates is created by the shared admission helper.
    for (const banned of [
      "sceneGeneration.create",
      "sceneGeneration.update",
      "sceneGenerationRequest.create",
      "sceneGenerationRequest.update",
      "generationScene.update",
      "generationJob.update",
      "generationReservation.update",
      "generationPricingSnapshot.create",
      "managedOutputMediaValidation.update",
      "INSERT INTO",
      'UPDATE "',
      "DELETE FROM",
    ]) {
      expect(`${banned}: ${repo.includes(banned)}`).toBe(`${banned}: false`);
    }
    expect(repo.includes("admitAttemptWithin")).toBe(true);
  });

  it("takes the declared five-row lock chain, Job first and validation last", () => {
    const repo = code(readFileSync(RECOVERY_REPOSITORY, "utf8"));
    expect(repo.includes("FOR UPDATE OF j, s, r, a")).toBe(true);
    expect(repo.includes("lockSourceValidation")).toBe(true);
    const chainLock = repo.indexOf("lockRecoveryChainForTenant(");
    const validationLock = repo.indexOf("await lockSourceValidation(");
    const authorityRead = repo.indexOf("readRecoveryContext(");
    expect(chainLock).toBeGreaterThan(-1);
    expect(validationLock).toBeGreaterThan(chainLock);
    expect(authorityRead).toBeGreaterThan(validationLock);
  });

  it("keeps the domain free of storage and database imports", () => {
    for (const { name, text } of sourceFiles(RECOVERY_DIR)) {
      for (const banned of ["@app/database", "@prisma/client", "$transaction", "$queryRaw"]) {
        expect(`${name}:${banned}: ${text.includes(banned)}`).toBe(`${name}:${banned}: false`);
      }
    }
  });

  it("offers no boundary method that takes a callback", () => {
    const ports = code(readFileSync(join(RECOVERY_DIR, "ports.ts"), "utf8"));
    for (const banned of ["=> Promise<", "callback", "withPlan", "runInTransaction"]) {
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
    // Migration 12 belongs to Phase 4C-3B-2H-3B-5. This phase needed no schema
    // change: the existence of the newer SYSTEM_RECOVERY attempt is itself the
    // durable idempotency marker.
    expect(dirs.at(-1)).toBe("00000000000012_phase4c3b2h3b5_media_validation_lifecycle");
    expect(dirs.filter((dir) => dir.includes("6b") || dir.includes("recovery"))).toEqual([]);
  });

  it("adds no recovery bookkeeping column to the schema", () => {
    const schema = readFileSync(
      join(REPO_ROOT, "packages", "database", "prisma", "schema.prisma"),
      "utf8",
    );
    for (const banned of [
      "recoveryHandledAt",
      "recoverySourceValidationId",
      "mediaRecoveryStatus",
      "recoveryCounter",
      "retryCount",
      "automaticRecoveryCount",
    ]) {
      expect(`${banned}: ${schema.includes(banned)}`).toBe(`${banned}: false`);
    }
    // The facts recovery actually relies on were already there.
    for (const required of ["attemptKind", "attemptOrdinal", "GenerationAttemptKind"]) {
      expect(`${required}: ${schema.includes(required)}`).toBe(`${required}: true`);
    }
  });
});
