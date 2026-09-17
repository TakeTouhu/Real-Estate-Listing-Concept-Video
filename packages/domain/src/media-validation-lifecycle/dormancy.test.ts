import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * What Phase 4C-3B-2H-3B-5 may and may not have changed.
 *
 * The dormancy claim moved with this phase and the assertions have to move with
 * it honestly. Production source is now *allowed* to contain a durable
 * lifecycle model, a repository, and a lifecycle runner — that is the whole
 * point of the phase. What is still forbidden is any production composition
 * root that constructs the runner, schedules it, invokes it, builds the
 * concrete media validator for live use, runs `ffprobe`, performs a production
 * media-validation S3 read, or wires a credential.
 *
 * The second group of assertions is the state freeze: this phase makes a media
 * verdict durable and says nothing about what it *means*. A `VALID` record must
 * not make a Scene ready, and an `INVALID_MEDIA` or `INTEGRITY_MISMATCH` record
 * must not create a recovery attempt, fail a Scene, or move quota. Those are
 * decisions for the next reviewed package, and the cheapest way to keep them
 * there is to prove the lifecycle code cannot reach them.
 */

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const LIFECYCLE_DIR = __dirname;

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

/** The lifecycle's own production files, comments stripped. */
function lifecycleSources(): { name: string; text: string }[] {
  return sourceFiles(LIFECYCLE_DIR);
}

// ---------------------------------------------------------------------------

describe("the lifecycle exists but nothing runs it", () => {
  it("constructs the lifecycle runner nowhere in production", () => {
    const OWN = "media-validation-lifecycle/runner.ts";
    const INDEX = "media-validation-lifecycle/index.ts";
    for (const { name, text } of productionSources()) {
      if (name.endsWith(OWN) || name.endsWith(INDEX)) continue;
      if (name.endsWith("packages/domain/src/index.ts")) continue;
      for (const banned of [
        "new MediaValidationLifecycleRunner",
        "MediaValidationLifecycleRunner(",
      ]) {
        expect(`${name}:${banned}: ${text.includes(banned)}`).toBe(`${name}:${banned}: false`);
      }
    }
  });

  it("calls runOnce or runOne nowhere in production", () => {
    const OWN = "media-validation-lifecycle/runner.ts";
    for (const { name, text } of productionSources()) {
      if (name.endsWith(OWN)) continue;
      for (const banned of [".runOnce(", ".runOne("]) {
        // Other runners exist; this asserts no production *caller* of any of
        // them appeared, which is the property that keeps this one unscheduled.
        expect(`${name}:${banned}: ${text.includes(banned)}`).toBe(`${name}:${banned}: false`);
      }
    }
  });

  it("constructs the concrete media validator nowhere in production", () => {
    for (const { name, text } of productionSources()) {
      for (const banned of [
        "new S3ManagedOutputMediaValidator",
        "new FfprobeMediaProbe",
        "createDefaultProcessRunner(",
      ]) {
        if (name.endsWith("managed-output/ffprobe.ts") && banned === "createDefaultProcessRunner(") {
          // Its own definition.
          continue;
        }
        if (name.endsWith("managed-output/index.ts")) continue;
        if (name.endsWith("packages/storage/src/index.ts")) continue;
        expect(`${name}:${banned}: ${text.includes(banned)}`).toBe(`${name}:${banned}: false`);
      }
    }
  });

  it("has no scheduler, cron, interval or queue consumer for the lifecycle", () => {
    for (const { name, text } of lifecycleSources()) {
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

describe("the lifecycle cannot reach Scene, Job, reservation or quota state", () => {
  it("names no other aggregate's state vocabulary", () => {
    for (const { name, text } of lifecycleSources()) {
      for (const banned of [
        // Scene / Job readiness and delivery.
        "SCENES_READY",
        "READY_FOR_COMPOSITION",
        "GenerationSceneState",
        "GenerationJobState",
        "currentDeliveredRequestId",
        // Recovery, quota and money. `RESERVATION_` rather than a bare
        // `RELEASE`, because this module has its own `RELEASED` run outcome —
        // the ban must catch the reservation vocabulary, not a substring of it.
        "SYSTEM_RECOVERY",
        "CONSUMED",
        "RESERVATION_",
        "GenerationReservation",
        "reservation",
        "quota",
        "entitlement",
        // Composition and delivery, which this phase does not touch.
        "upscale",
        "compose",
      ]) {
        expect(`${name}:${banned}: ${text.includes(banned)}`).toBe(`${name}:${banned}: false`);
      }
    }
  });

  it("changes no existing orchestration vocabulary", () => {
    // OUTPUT_VERIFIED keeps its exact meaning; no state was appended after it.
    const types = code(
      readFileSync(join(REPO_ROOT, "packages", "domain", "src", "orchestration", "types.ts"), "utf8"),
    );
    for (const invented of ["MEDIA_VERIFIED", "MEDIA_INVALID", "OUTPUT_INVALID", "MEDIA_PENDING"]) {
      expect(`${invented}: ${types.includes(invented)}`).toBe(`${invented}: false`);
    }
    expect(types.includes("OUTPUT_VERIFIED")).toBe(true);
  });

  it("keeps the durable status vocabulary closed and free of a retryable verdict", () => {
    const durable = code(readFileSync(join(LIFECYCLE_DIR, "durable.ts"), "utf8"));
    // RETRYABLE_FAILURE is the validator's transient outcome and must never
    // become a durable terminal state.
    expect(durable.includes('"RETRYABLE_FAILURE",\n')).toBe(false);
    for (const required of [
      '"PENDING"',
      '"RUNNING"',
      '"VALID"',
      '"INVALID_MEDIA"',
      '"INTEGRITY_MISMATCH"',
    ]) {
      expect(`${required}: ${durable.includes(required)}`).toBe(`${required}: true`);
    }
  });

  it("offers no repository method that takes a callback", () => {
    // Structural: a repository transaction cannot wrap S3, temp-file I/O or
    // ffprobe if no method accepts something to run inside one.
    const ports = code(readFileSync(join(LIFECYCLE_DIR, "ports.ts"), "utf8"));
    for (const banned of ["=> Promise<", "callback", "withClaim", "runInTransaction", "$transaction"]) {
      expect(`${banned}: ${ports.includes(banned)}`).toBe(`${banned}: false`);
    }
  });
});

// ---------------------------------------------------------------------------

describe("dependency direction is preserved", () => {
  it("keeps the domain free of storage and database imports", () => {
    for (const { name, text } of lifecycleSources()) {
      for (const banned of ["@app/storage", "@app/database", "@prisma/client"]) {
        expect(`${name}:${banned}: ${text.includes(banned)}`).toBe(`${name}:${banned}: false`);
      }
    }
  });

  it("keeps the database repository free of storage imports", () => {
    const repo = code(
      readFileSync(
        join(REPO_ROOT, "packages", "database", "src", "media-validation-lifecycle-repository.ts"),
        "utf8",
      ),
    );
    expect(repo.includes("@app/storage")).toBe(false);
    // It coordinates nothing external: no S3, no subprocess, no network.
    for (const banned of ["S3Client", "execFile", "node:child_process", "fetch("]) {
      expect(`${banned}: ${repo.includes(banned)}`).toBe(`${banned}: false`);
    }
  });
});
