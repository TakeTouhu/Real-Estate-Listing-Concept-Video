import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * What Phase 5C may and may not have changed.
 *
 * This phase spends a customer's entitlement and decides which file they can
 * download, so the scope claim *is* the safety argument. Six claims:
 *
 * 1. **Dormancy.** Nothing constructs the validation repository or the runner,
 *    and nothing schedules a sweep. The capability exists; no production caller
 *    reaches it.
 * 2. **No transaction spans external work.** The database boundary is its own
 *    module and can reach no object store, subprocess, filesystem or HTTP client.
 * 3. **Only Transaction G moves money or the pointer.** Every claim, finalize and
 *    defer writes neither `consumedAt`, nor a reservation state, nor the job's
 *    current deliverable version.
 * 4. **No invented customer-visible failure state.** A terminal non-`VALID`
 *    verdict appends no transition event, and neither state vocabulary grew a
 *    `DELIVERABLE_INVALID` member.
 * 5. **One migration, this phase's, adding one table and rewriting nothing.**
 * 6. **No paid provider, credential, scheduler or billing integration.**
 *
 * Checks are architectural where that is stronger than a filename: what a module
 * *imports* and what symbols it *names* survive a rename and a copy-paste.
 */

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const MODULE_DIR = __dirname;
const VALIDATION_REPOSITORY = join(
  REPO_ROOT,
  "packages",
  "database",
  "src",
  "deliverable-validation-repository.ts",
);
const MIGRATION_DIR = "00000000000016_phase5c_deliverable_validation";
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

function repositorySource(): string {
  return code(readFileSync(VALIDATION_REPOSITORY, "utf8"));
}

function migrationSql(): string {
  return readFileSync(MIGRATION, "utf8");
}

function imports(text: string): string[] {
  return [...text.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1] ?? "");
}

/**
 * Every `data: { ... }` object literal in a source, brace-matched.
 *
 * A Prisma write is exactly one of these, so scanning them is how a test can say
 * "this column is written in one place and nowhere else" without mistaking a
 * SELECT alias, a `select:` projection or an interface field for an assignment.
 */
function prismaWritePayloads(text: string): string[] {
  const payloads: string[] = [];
  for (const match of text.matchAll(/\bdata:\s*\{/g)) {
    let depth = 0;
    let index = match.index! + match[0].length - 1;
    const start = index;
    for (; index < text.length; index += 1) {
      const character = text[index];
      if (character === "{") depth += 1;
      else if (character === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    payloads.push(text.slice(start, index + 1));
  }
  return payloads;
}

// ---------------------------------------------------------------------------

describe("the capability exists but nothing runs it", () => {
  const CONSTRUCTORS = [
    "createDeliverableValidationRepository(",
    "new DeliverableValidationRunner(",
  ];

  it("constructs nothing this phase built, anywhere in production", () => {
    for (const { name, text } of productionSources()) {
      // The factory's own module and the package barrel are where the name
      // legitimately appears.
      if (name.endsWith("deliverable-validation-repository.ts")) continue;
      if (name.endsWith("packages/database/src/index.ts")) continue;
      for (const banned of CONSTRUCTORS) {
        expect(`${name}:${banned}: ${text.includes(banned)}`).toBe(`${name}:${banned}: false`);
      }
    }
  });

  it("calls no validation or publication entry point in production", () => {
    for (const { name, text } of productionSources()) {
      if (name.startsWith("packages/domain/src/deliverable-validation/")) continue;
      if (name.endsWith("deliverable-validation-repository.ts")) continue;
      // The storage adapter *implements* `validateDeliverable`; implementing a
      // port is not calling one, and the dormancy claim is about callers.
      if (name.endsWith("managed-output/media-validation.ts")) continue;
      for (const banned of [
        "claimDeliverableValidation(",
        "publishDeliverable(",
        "deferValidation(",
        "findValidationCandidates(",
        "validateDeliverable(",
      ]) {
        expect(`${name}:${banned}: ${text.includes(banned)}`).toBe(`${name}:${banned}: false`);
      }
    }
  });

  it("adds no scheduler, timer, cron or loop of its own", () => {
    for (const { name, text } of sourceFiles(MODULE_DIR)) {
      for (const banned of [
        "setInterval",
        "setTimeout",
        "cron",
        "while (true",
        "for (;;)",
        "Date.now()",
      ]) {
        expect(`${name}:${banned}: ${text.includes(banned)}`).toBe(`${name}:${banned}: false`);
      }
    }
  });

  it("adds no environment variable, credential or provider name", () => {
    for (const { name, text } of sourceFiles(MODULE_DIR)) {
      for (const banned of [
        "process.env",
        "API_KEY",
        "SECRET",
        "AWS_",
        "FAL_",
        "WAVESPEED",
        "stripe",
        "Stripe",
      ]) {
        expect(`${name}:${banned}: ${text.includes(banned)}`).toBe(`${name}:${banned}: false`);
      }
    }
  });
});

describe("the database boundary can reach nothing external", () => {
  it("imports no object store, subprocess, filesystem or HTTP module", () => {
    const text = repositorySource();
    for (const banned of [
      "node:child_process",
      "node:fs",
      "node:https",
      "node:http",
      "node:net",
      "@aws-sdk",
      "fetch(",
      "ffprobe",
      "ffmpeg",
    ]) {
      expect(`${banned}: ${text.includes(banned)}`).toBe(`${banned}: false`);
    }
    expect(imports(text).sort()).toEqual([
      "./orchestration-repositories",
      "@app/domain",
      "@app/shared",
      "@prisma/client",
    ]);
  });

  it("keeps the domain module free of persistence and infrastructure", () => {
    for (const { name, text } of sourceFiles(MODULE_DIR)) {
      for (const specifier of imports(text)) {
        expect(`${name}:${specifier}`).not.toMatch(
          /@prisma|@app\/database|@app\/storage|@aws-sdk|node:/,
        );
      }
    }
  });
});

describe("only Transaction G moves the pointer or the unit", () => {
  it("writes a reservation state in exactly one place, always with its instant", () => {
    const payloads = prismaWritePayloads(repositorySource());
    const consuming = payloads.filter((p) => p.includes('state: "CONSUMED"'));
    expect(consuming).toHaveLength(1);
    // A hold marked spent with no record of when is a hold nobody can audit.
    expect(consuming[0]).toContain("consumedAt:");
    // And it never releases: refunding an entitlement is not this phase's
    // decision, and a released hold behind a validated deliverable fails closed.
    expect(payloads.some((p) => p.includes("releasedAt"))).toBe(false);
    expect(payloads.some((p) => p.includes('state: "RELEASED"'))).toBe(false);
  });

  it("writes the job's deliverable pointer in exactly one place", () => {
    const payloads = prismaWritePayloads(repositorySource());
    const pointing = payloads.filter((p) => p.includes("currentDeliverableVersionId:"));
    expect(pointing).toHaveLength(1);
    // The same payload that moves the job. A pointer written without the job's
    // own move would publish a video the job does not believe it has.
    expect(pointing[0]).toContain('state: "DELIVERABLE_READY"');
  });

  it("terminalizes no job, ever", () => {
    // A deliverable that cannot be validated is not a failed job. During a
    // recomposition the customer may already hold a perfectly good video.
    const payloads = prismaWritePayloads(repositorySource());
    for (const banned of ['"FAILED_TERMINAL"', '"CANCELLED"']) {
      expect(`${banned}: ${payloads.some((p) => p.includes(banned))}`).toBe(`${banned}: false`);
    }
  });

  it("never writes a scene, request, attempt or provider row", () => {
    const text = repositorySource();
    for (const banned of [
      "tx.generationScene.",
      "tx.sceneGenerationRequest.",
      "tx.sceneGeneration.",
      "tx.managedOutputMediaValidation.",
      "tx.generationDeliverableComposition.update",
      "tx.generationDeliverableVersion.update",
    ]) {
      expect(`${banned}: ${text.includes(banned)}`).toBe(`${banned}: false`);
    }
  });
});

describe("no customer-visible failure state was invented", () => {
  it("names no deliverable failure state anywhere in the module", () => {
    for (const { name, text } of sourceFiles(MODULE_DIR)) {
      for (const banned of [
        "DELIVERABLE_INVALID",
        "DELIVERABLE_FAILED",
        "VALIDATION_BLOCKED",
        "COMPOSITION_BLOCKED",
      ]) {
        expect(`${name}:${banned}: ${text.includes(banned)}`).toBe(`${name}:${banned}: false`);
      }
    }
  });

  it("appends a transition event only on the two paths that change something", () => {
    const text = repositorySource();
    // Four appends in total: the VALID verdict, and Transaction G's three —
    // the deliverable, the job and the hold. Every other path (claim, defer,
    // and both terminal non-VALID verdicts) changes nothing a reader of the
    // event stream should be told about.
    expect(text.match(/appendGenerationEvent\(/g)).toHaveLength(4);
    const finalizeTerminal = text.slice(text.indexOf("async function finalizeTerminalVerdict"));
    expect(
      finalizeTerminal.slice(0, finalizeTerminal.indexOf("async function lockValidationChain")),
    ).not.toContain("appendGenerationEvent");
  });
});

describe("durable shape", () => {
  it("adds exactly one migration, and it is this phase's", () => {
    const migrations = join(REPO_ROOT, "packages", "database", "prisma", "migrations");
    const dirs = readdirSync(migrations, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    // No longer the *last* migration: Phase 6A added migration 17 after it. The
    // claim this tripwire makes is still exact — Phase 5C contributed exactly
    // one migration, it is still present and in place, and nothing renamed or
    // split it or the fifteen before it.
    expect(dirs.filter((dir) => dir.includes("phase5c"))).toEqual([MIGRATION_DIR]);
    expect(dirs.indexOf(MIGRATION_DIR)).toBe(16);
    expect(dirs).toHaveLength(18);
  });

  it("creates one table and rewrites no existing row", () => {
    const sql = migrationSql();
    expect(sql.match(/CREATE TABLE/g)).toHaveLength(1);
    expect(sql).toContain(`CREATE TABLE "generation_deliverable_validations"`);
    // Anchored to the start of a statement: `ON UPDATE CASCADE` and
    // `ON DELETE RESTRICT` are foreign-key clauses on this phase's own new
    // table, not rewrites of anything that already exists.
    for (const banned of ["UPDATE", "DELETE", "TRUNCATE", "DROP", "ALTER COLUMN"]) {
      expect(`${banned}: ${new RegExp(`^${banned}\\b`, "m").test(sql)}`).toBe(`${banned}: false`);
    }
    // Every ALTER TABLE is a constraint on the new table, never on another.
    for (const match of sql.matchAll(/^ALTER TABLE "([^"]+)"/gm)) {
      expect(match[1]).toBe("generation_deliverable_validations");
    }
  });

  it("reuses the existing media enums rather than copying them", () => {
    const sql = migrationSql();
    expect(sql.match(/CREATE TYPE/g)).toHaveLength(1);
    expect(sql).toContain(`CREATE TYPE "DeliverableValidationStatus"`);
    // A second five-member copy would drift from the first the moment either is
    // extended.
    for (const banned of [
      `CREATE TYPE "ManagedOutputMediaInvalidReason"`,
      `CREATE TYPE "ManagedOutputContainerFamily"`,
      `CREATE TYPE "DeliverableValidationInvalidReason"`,
    ]) {
      expect(`${banned}: ${sql.includes(banned)}`).toBe(`${banned}: false`);
    }
    expect(sql).toContain(`"invalidReason" "ManagedOutputMediaInvalidReason"`);
  });

  it("records publication nowhere on the validation row", () => {
    const sql = migrationSql();
    // A deliverable is published when the job says DELIVERABLE_READY, the job's
    // pointer names this version and the hold is CONSUMED. A fourth copy of that
    // fact would be a fourth thing to disagree.
    for (const banned of ['"publishedAt"', '"consumedAt"', '"isCurrent"', '"publishedBy"']) {
      expect(`${banned}: ${sql.includes(banned)}`).toBe(`${banned}: false`);
    }
  });

  it("keeps every status in exactly one arrangement of its columns", () => {
    const sql = migrationSql();
    expect(sql).toContain("deliverable_validation_status_shape_check");
    for (const status of [
      "PENDING",
      "RUNNING",
      "VALID",
      "INVALID_MEDIA",
      "INTEGRITY_MISMATCH",
    ]) {
      expect(sql).toContain(`"status" = '${status}'`);
    }
    // A verdict that is not about media carries no media reason.
    expect(sql).toContain(`"status" = 'INTEGRITY_MISMATCH'\n      AND "leaseToken" IS NULL`);
  });

  it("adds no column to any existing table", () => {
    const schema = readFileSync(
      join(REPO_ROOT, "packages", "database", "prisma", "schema.prisma"),
      "utf8",
    );
    for (const banned of [
      "deliverableValidationId",
      "validationStatus",
      "publishedDeliverableAt",
      "unitsConsumed",
    ]) {
      expect(`${banned}: ${schema.includes(banned)}`).toBe(`${banned}: false`);
    }
  });
});

describe("no billing, provider or operator surface was opened", () => {
  it("adds no payment integration anywhere in the repository boundary", () => {
    const text = repositorySource();
    for (const banned of ["stripe", "Stripe", "invoice", "charge(", "overage", "checkout"]) {
      expect(`${banned}: ${text.includes(banned)}`).toBe(`${banned}: false`);
    }
  });

  it("exposes no unblock, retry or force-publish operator path", () => {
    for (const { name, text } of [
      ...sourceFiles(MODULE_DIR),
      { name: "repository", text: repositorySource() },
    ]) {
      for (const banned of ["unblock", "forcePublish", "manualRetry", "reopen", "override"]) {
        expect(`${name}:${banned}: ${text.includes(banned)}`).toBe(`${name}:${banned}: false`);
      }
    }
  });
});
