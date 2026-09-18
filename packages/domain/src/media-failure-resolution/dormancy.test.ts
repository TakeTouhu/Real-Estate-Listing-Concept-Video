import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * What Phase 4C-3B-2H-3B-6C may and may not have changed.
 *
 * This phase terminalizes customers and releases entitlements, so the dormancy
 * claim matters more here than in any phase before it. Five claims:
 *
 * 1. **Dormancy.** Nothing constructs the coordinator, schedules it, or calls it.
 * 2. **One authority.** Phase 6B's own runner is gone, not left beside this one.
 * 3. **No paid boundary.** Nothing in this module can reach a provider, an HTTP
 *    client, a paid-submission authorization or a credential.
 * 4. **Scope freeze.** Settlement never consumes quota and never releases a
 *    reservation that a delivered video already consumed.
 * 5. **One migration, and one cost lock.** Migration 13 is this phase's, and the
 *    advisory-lock key formula exists in exactly one place.
 *
 * Checks are architectural where that is stronger than a filename: what a module
 * *imports* and what symbols it *names* survive a rename and a copy-paste.
 */

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const MODULE_DIR = __dirname;
const RESOLUTION_REPOSITORY = join(
  REPO_ROOT,
  "packages",
  "database",
  "src",
  "media-failure-resolution-repository.ts",
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
      name: RESOLUTION_REPOSITORY.slice(REPO_ROOT.length + 1),
      text: code(readFileSync(RESOLUTION_REPOSITORY, "utf8")),
    },
  ];
}

// ---------------------------------------------------------------------------

describe("the capability exists but nothing runs it", () => {
  it("constructs the coordinator nowhere in production", () => {
    for (const { name, text } of productionSources()) {
      if (name.endsWith("media-failure-resolution/runner.ts")) continue;
      if (name.endsWith("media-failure-resolution/index.ts")) continue;
      if (name.endsWith("packages/domain/src/index.ts")) continue;
      for (const banned of [
        "new MediaFailureResolutionRunner",
        "MediaFailureResolutionRunner(",
      ]) {
        expect(`${name}:${banned}: ${text.includes(banned)}`).toBe(`${name}:${banned}: false`);
      }
    }
  });

  it("constructs the resolution repository nowhere in production", () => {
    for (const { name, text } of productionSources()) {
      if (name.endsWith("packages/database/src/media-failure-resolution-repository.ts")) continue;
      if (name.endsWith("packages/database/src/index.ts")) continue;
      expect(
        `${name}: ${text.includes("createMediaFailureResolutionRepository(")}`,
      ).toBe(`${name}: false`);
    }
  });

  it("invokes no settlement or work entry point in production", () => {
    for (const { name, text } of productionSources()) {
      if (name.endsWith("media-failure-resolution/runner.ts")) continue;
      if (name.endsWith("packages/database/src/media-failure-resolution-repository.ts")) continue;
      for (const banned of [
        ".settleExhaustedMediaFailure(",
        ".findResolutionCandidates(",
        ".resolveRecoveryAdmitted(",
      ]) {
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
          "media-failure-resolution",
          "MediaFailureResolutionRunner",
          "createMediaFailureResolutionRepository",
          "settleExhaustedMediaFailure",
        ]) {
          expect(`${name}:${banned}: ${text.includes(banned)}`).toBe(`${name}:${banned}: false`);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------

describe("one orchestration authority, not two", () => {
  it("has no Phase 6B recovery runner left anywhere", () => {
    expect(existsSync(join(REPO_ROOT, "packages", "domain", "src", "media-recovery", "runner.ts")))
      .toBe(false);
    for (const { name, text } of productionSources()) {
      expect(`${name}: ${text.includes("AutomaticMediaFailureRecoveryRunner")}`).toBe(
        `${name}: false`,
      );
    }
  });

  it("drives its sweep from the resolution work, never from the 6B discovery", () => {
    const runner = readFileSync(join(MODULE_DIR, "runner.ts"), "utf8");
    expect(code(runner).includes("findAutomaticMediaRecoveryCandidates")).toBe(false);
    // The deferral predicate is the fairness mechanism, and it lives in the
    // discovery this runner actually uses.
    expect(code(runner).includes("findResolutionCandidates")).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe("the paid provider boundary stays closed", () => {
  it("imports no provider, storage or HTTP capability", () => {
    for (const { name, text } of phaseSources()) {
      for (const banned of [
        "@app/video-providers",
        "@app/storage",
        "@app/ai-providers",
        "fetch(",
        "axios",
        "undici",
        "node:http",
        "node:https",
        "@aws-sdk",
        "ffprobe",
        "ffmpeg",
      ]) {
        expect(`${name}:${banned}: ${text.includes(banned)}`).toBe(`${name}:${banned}: false`);
      }
    }
  });

  it("names no credential and arms no provider boundary", () => {
    for (const { name, text } of phaseSources()) {
      for (const banned of [
        "FAL_KEY",
        "WAVESPEED_API_KEY",
        "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY",
        "STORAGE_SIGNING_SECRET",
        "armProviderBoundary",
        "authorizePaidSubmission",
        "providerPredictionId",
      ]) {
        expect(`${name}:${banned}: ${text.includes(banned)}`).toBe(`${name}:${banned}: false`);
      }
    }
  });
});

// ---------------------------------------------------------------------------

describe("what settlement never does", () => {
  it("never consumes a unit or touches the quota ledger", () => {
    for (const { name, text } of phaseSources()) {
      for (const banned of ["'CONSUMED'", '"CONSUMED"', "quota", "Quota", "ledger"]) {
        // `CONSUMED` appears only as a *read* predicate in the repository —
        // a regeneration rollback requires it and leaves it alone — so the
        // banned form here is the written literal in an UPDATE.
        if (
          name.endsWith("media-failure-resolution-repository.ts") &&
          (banned === "'CONSUMED'" || banned === '"CONSUMED"')
        ) {
          continue;
        }
        expect(`${name}:${banned}: ${text.includes(banned)}`).toBe(`${name}:${banned}: false`);
      }
    }
  });

  it("writes RELEASED only from a reserved or held state", () => {
    const repo = readFileSync(RESOLUTION_REPOSITORY, "utf8");
    // The one UPDATE that releases guards its own `from` state, and the two
    // states it may come from are exactly the pre-consumption ones.
    expect(repo).toContain(`'RELEASED'::"GenerationReservationState"`);
    expect(repo).toContain(`row.reservationState !== "RESERVED" && row.reservationState !== "RECONCILIATION_HOLD"`);
    // A regeneration rollback must never reach that statement.
    expect(repo).toContain("The reservation is deliberately untouched");
  });

  it("creates no provider attempt", () => {
    const repo = code(readFileSync(RESOLUTION_REPOSITORY, "utf8"));
    for (const banned of [
      'INSERT INTO "scene_generations"',
      "admitAttemptWithin",
      "sceneGeneration.create",
    ]) {
      expect(`${banned}: ${repo.includes(banned)}`).toBe(`${banned}: false`);
    }
  });
});

// ---------------------------------------------------------------------------

describe("durable shape and the cost lock", () => {
  it("adds exactly one migration, and it is this phase's", () => {
    const migrations = join(REPO_ROOT, "packages", "database", "prisma", "migrations");
    const dirs = readdirSync(migrations, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(dirs.at(-1)).toBe("00000000000013_phase4c3b2h3b6c_media_failure_resolution");
    expect(dirs.filter((dir) => dir.includes("6c"))).toEqual([
      "00000000000013_phase4c3b2h3b6c_media_failure_resolution",
    ]);
  });

  it("backfills nothing", () => {
    const migration = readFileSync(
      join(
        REPO_ROOT,
        "packages",
        "database",
        "prisma",
        "migrations",
        "00000000000013_phase4c3b2h3b6c_media_failure_resolution",
        "migration.sql",
      ),
      "utf8",
    );
    // No historical row is read, rewritten or seeded. A backfill would be
    // inventing a resolution for a failure nobody has looked at.
    // `UPDATE "` rather than `UPDATE `, because `ON UPDATE CASCADE` is a foreign
    // key clause and not a data rewrite.
    for (const banned of ['UPDATE "', "INSERT INTO", "DELETE FROM", "SELECT "]) {
      expect(`${banned}: ${migration.includes(banned)}`).toBe(`${banned}: false`);
    }
    // And nothing touches the tables that hold paid history.
    for (const banned of ["ALTER TABLE \"scene_generations\"", "ALTER TABLE \"generation_jobs\""]) {
      expect(`${banned}: ${migration.includes(banned)}`).toBe(`${banned}: false`);
    }
  });

  it("keeps the shape constraints in the database, not only in TypeScript", () => {
    const migration = readFileSync(
      join(
        REPO_ROOT,
        "packages",
        "database",
        "prisma",
        "migrations",
        "00000000000013_phase4c3b2h3b6c_media_failure_resolution",
        "migration.sql",
      ),
      "utf8",
    );
    expect(migration).toContain("media_failure_resolution_status_shape_check");
    expect(migration).toContain("media_failure_resolution_recovery_binding_check");
    expect(migration).toContain("media_failure_resolution_counters_check");
  });

  it("has exactly one cost-admission lock key formula", () => {
    const dbSources = sourceFiles(join(REPO_ROOT, "packages", "database", "src"));
    const withFormula = dbSources.filter((f) => f.text.includes("pg_advisory_xact_lock"));
    expect(withFormula.map((f) => f.name)).toEqual([
      "packages/database/src/cost-admission-lock.ts",
    ]);
    // And it is not reachable from outside the package: a caller holding it
    // without the transaction that gives it meaning is holding nothing.
    const index = readFileSync(join(REPO_ROOT, "packages", "database", "src", "index.ts"), "utf8");
    expect(code(index).includes("cost-admission-lock")).toBe(false);
    expect(code(index).includes("acquireCostAdmissionLock")).toBe(false);
  });

  it("takes the cost lock before the reservation in settlement", () => {
    // Comments stripped first. An earlier version of this assertion read the raw
    // file, and the doc comment above `lockSettlementChain` quotes the very
    // `FOR UPDATE OF` clause being asserted — so deleting the real SQL left the
    // test passing on prose. Mutation M198 is what found it.
    const repo = code(readFileSync(RESOLUTION_REPOSITORY, "utf8"));
    const lock = repo.indexOf("acquireCostAdmissionLock(tx");
    const chain = repo.indexOf("lockSettlementChain(tx");
    expect(lock).toBeGreaterThan(-1);
    expect(chain).toBeGreaterThan(-1);
    // Same order the paid-submission gate takes, which is what makes the two
    // serialize instead of racing over one entitlement.
    expect(lock).toBeLessThan(chain);
    expect(repo).toContain("FOR UPDATE OF res, j, s, r, a, v, w");
  });

  it("pins the reclaim CAS to the version and status it read", () => {
    // Structural rather than behavioural, and deliberately so.
    //
    // The predicate defends against two workers whose SELECTs both land before
    // either UPDATE: the second's write then blocks on the row lock, re-evaluates
    // its WHERE against the winner's committed row, and matches nothing. A test
    // cannot force that interleaving — Prisma serializes the two transactions on
    // the connection pool, so the second reads a row the first has already
    // reclaimed and is refused a step earlier, by the `claimable` check.
    //
    // Mutation M175 is what established that. Rather than leave the guard
    // unprotected because the harness cannot reach it, the requirement is stated
    // here: the CAS pins both columns it read.
    const repo = code(readFileSync(RESOLUTION_REPOSITORY, "utf8"));
    const cas = repo.slice(repo.indexOf("managedOutputMediaFailureResolution.updateMany"));
    expect(cas).toContain("version: row.workVersion");
    expect(cas).toContain('status: row.workStatus === "PENDING" ? "PENDING" : "RUNNING"');
  });

  it("states the lease and version guard in SQL rather than in prose", () => {
    // Same class of mistake as the clause above, pinned separately: every write
    // after a claim carries all three predicates.
    const repo = code(readFileSync(RESOLUTION_REPOSITORY, "utf8"));
    expect(repo).toContain(`AND "version" = `);
    expect(repo).toContain(`AND "status" = 'RUNNING'::"MediaFailureResolutionStatus"`);
    expect(repo).toContain(`AND "leaseToken" = `);
  });
});
