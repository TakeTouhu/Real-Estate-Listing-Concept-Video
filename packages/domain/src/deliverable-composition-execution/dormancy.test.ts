import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * What Phase 5B may and may not have changed.
 *
 * This phase runs an encoder over paid generated media and publishes the file a
 * customer will be shown, so the scope claim is the safety argument. Six claims:
 *
 * 1. **Dormancy.** Nothing constructs the execution repository, the runner or
 *    either adapter, and nothing schedules a sweep. The capability exists; no
 *    production caller reaches it.
 * 2. **No transaction spans external work.** The database boundary and the
 *    object-store, subprocess and filesystem boundaries are separate modules,
 *    and the repository can reach none of the others.
 * 3. **No billing, no publication.** Execution consumes no unit, touches no
 *    reservation, and never moves the job's current deliverable pointer.
 * 4. **No invented lifecycle state.** Blocking appends no transition event, and
 *    neither state vocabulary grew a `COMPOSITION_BLOCKED` member.
 * 5. **Retry and block vocabularies stay disjoint.**
 * 6. **One migration, this phase's, and nothing rewritten.**
 *
 * Checks are architectural where that is stronger than a filename: what a module
 * *imports* and what symbols it *names* survive a rename and a copy-paste.
 */

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const MODULE_DIR = __dirname;
const EXECUTION_REPOSITORY = join(
  REPO_ROOT,
  "packages",
  "database",
  "src",
  "deliverable-composition-execution-repository.ts",
);
const MIGRATION_DIR = "00000000000015_phase5b_deliverable_composition_execution";
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
  return code(readFileSync(EXECUTION_REPOSITORY, "utf8"));
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
 * A Prisma write is exactly one of these, so scanning them is how a test can
 * say "this column is read but never written" without mistaking a SELECT alias,
 * a `select:` projection or an interface field for an assignment.
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
    "createDeliverableCompositionExecutionRepository(",
    "new DeliverableCompositionRunner(",
    "createDeliverableCompositionSourceMaterializer(",
    "createDeliverableOutputPublisher(",
    "createFfmpegDeliverableComposer(",
  ];

  it("constructs nothing this phase built, anywhere in production", () => {
    for (const { name, text } of productionSources()) {
      // The factory's own module and the two package barrels are where each
      // name legitimately appears.
      if (name.endsWith("deliverable-composition-execution-repository.ts")) continue;
      if (name.endsWith("deliverable-composition-io.ts")) continue;
      if (name.endsWith("ffmpeg-composer.ts")) continue;
      if (name.endsWith("packages/database/src/index.ts")) continue;
      if (name.endsWith("packages/storage/src/index.ts")) continue;
      if (name.endsWith("managed-output/index.ts")) continue;
      for (const banned of CONSTRUCTORS) {
        expect(`${name}:${banned}: ${text.includes(banned)}`).toBe(`${name}:${banned}: false`);
      }
    }
  });

  it("calls no execution entry point in production", () => {
    for (const { name, text } of productionSources()) {
      if (name.startsWith("packages/domain/src/deliverable-composition-execution/")) continue;
      if (name.endsWith("deliverable-composition-execution-repository.ts")) continue;
      for (const banned of [
        ".runOnce(",
        "claimCompositionWork(",
        "finalizeComposition(",
        "blockComposition(",
        "deferComposition(",
        "findCompositionCandidates(",
      ]) {
        expect(`${name}:${banned}: ${text.includes(banned)}`).toBe(`${name}:${banned}: false`);
      }
    }
  });

  it("adds no scheduler, timer, queue or loop of its own", () => {
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

  it("adds no environment variable and no credential", () => {
    for (const { name, text } of sourceFiles(MODULE_DIR)) {
      for (const banned of ["process.env", "API_KEY", "SECRET", "AWS_", "FAL_", "WAVESPEED"]) {
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
      "@aws-sdk",
      "fetch(",
      "ffmpeg",
      "ffprobe",
      "execFile",
      "@app/storage",
    ]) {
      expect(`${banned}: ${text.includes(banned)}`).toBe(`${banned}: false`);
    }
  });

  it("keeps the domain module free of storage, database and Prisma", () => {
    for (const { name, text } of sourceFiles(MODULE_DIR)) {
      for (const specifier of imports(text)) {
        expect(`${name} imports ${specifier}`).not.toMatch(
          /@app\/(storage|database)|@prisma|@aws-sdk|node:(fs|child_process|http)/,
        );
      }
    }
  });

  it("splits the four boundaries across four ports, so none can span another", () => {
    const ports = code(readFileSync(join(MODULE_DIR, "ports.ts"), "utf8"));
    for (const port of [
      "DeliverableCompositionRepository",
      "DeliverableCompositionSourceMaterializer",
      "DeliverableMediaComposer",
      "DeliverableOutputPublisher",
    ]) {
      expect(ports.includes(`interface ${port}`)).toBe(true);
    }
  });
});

describe("execution moves no money and publishes nothing", () => {
  it("names no reservation, unit, credit or pointer write in the repository", () => {
    const text = repositorySource();
    for (const banned of [
      "generationReservation",
      "generation_reservations",
      "consumedAt",
      "releasedAt",
      "requiredVideoUnits",
      "CONSUMED",
      "RELEASED",
    ]) {
      expect(`${banned}: ${text.includes(banned)}`).toBe(`${banned}: false`);
    }
  });

  it("never assigns the job's current deliverable pointer", () => {
    const text = repositorySource();
    // It is read to prove it did not move, and never written. Checked against
    // the actual write payloads rather than against the whole file, so a SELECT
    // alias and a `select:` projection are not mistaken for an assignment.
    expect(text.includes("currentDeliverableVersionId")).toBe(true);
    const payloads = prismaWritePayloads(text);
    expect(payloads.length).toBeGreaterThan(0);
    for (const payload of payloads) {
      expect(`writes the pointer: ${payload.includes("currentDeliverableVersionId")}`).toBe(
        "writes the pointer: false",
      );
    }
  });

  it("writes no reservation or unit column in any payload", () => {
    for (const payload of prismaWritePayloads(repositorySource())) {
      for (const banned of ["reserved", "consumed", "released", "Units"]) {
        expect(`${banned}: ${payload.includes(banned)}`).toBe(`${banned}: false`);
      }
    }
  });

  it("names no terminal job state", () => {
    const text = repositorySource();
    for (const banned of ["FAILED_TERMINAL", "FAILED", "DELIVERABLE_READY", "APPROVED"]) {
      expect(`${banned}: ${text.includes(banned)}`).toBe(`${banned}: false`);
    }
  });
});

describe("blocking invents no lifecycle state", () => {
  it("defines no COMPOSITION_BLOCKED state anywhere this phase touches", () => {
    for (const { name, text } of [
      ...sourceFiles(MODULE_DIR),
      { name: "execution repository", text: repositorySource() },
    ]) {
      expect(`${name}: ${text.includes("COMPOSITION_BLOCKED")}`).toBe(`${name}: false`);
    }
  });

  it("appends no event from the block transaction", () => {
    const text = repositorySource();
    const block = text.slice(text.indexOf("async blockComposition"));
    const end = block.indexOf("async findCompositionByVersionId");
    const body = end === -1 ? block : block.slice(0, end);
    expect(body.length).toBeGreaterThan(0);
    expect(body.includes("appendGenerationEvent")).toBe(false);
  });

  it("adds no job state to the schema", () => {
    const schema = readFileSync(
      join(REPO_ROOT, "packages", "database", "prisma", "schema.prisma"),
      "utf8",
    );
    expect(schema.includes("COMPOSITION_BLOCKED")).toBe(false);
  });
});

describe("the two code vocabularies stay apart in the database too", () => {
  it("declares the retry enum with exactly the three transient codes", () => {
    expect(migrationSql()).toContain(
      `CREATE TYPE "DeliverableCompositionRetryCode" AS ENUM ('SOURCE_READ_RETRYABLE', 'COMPOSER_RETRYABLE', 'OUTPUT_PUBLISH_RETRYABLE');`,
    );
  });

  it("declares the block enum with exactly the four deterministic codes", () => {
    expect(migrationSql()).toContain(
      `CREATE TYPE "DeliverableCompositionBlockCode" AS ENUM ('SOURCE_BYTES_LIMIT_EXCEEDED', 'DURATION_INVARIANT_MISMATCH', 'SOURCE_INTEGRITY_MISMATCH', 'OUTPUT_SIZE_LIMIT_EXCEEDED');`,
    );
  });

  it("declares the four durable statuses and no terminal failure", () => {
    const sql = migrationSql();
    expect(sql).toContain(
      `CREATE TYPE "DeliverableCompositionStatus" AS ENUM ('PENDING', 'RUNNING', 'BLOCKED', 'OUTPUT_VERIFIED');`,
    );
    expect(sql.includes("'FAILED'")).toBe(false);
  });

  it("constrains every status arm's lease, retry, block and receipt columns", () => {
    const sql = migrationSql();
    expect(sql).toContain("deliverable_composition_status_shape_check");
    // Four arms, each naming both block columns.
    expect(sql.match(/"status" = 'PENDING'/g)).toHaveLength(1);
    expect(sql.match(/"status" = 'RUNNING'/g)).toHaveLength(1);
    expect(sql.match(/"status" = 'BLOCKED'/g)).toHaveLength(1);
    expect(sql.match(/"status" = 'OUTPUT_VERIFIED'/g)).toHaveLength(1);
    expect(sql.match(/"blockCode" IS NULL/g)).toHaveLength(3);
    expect(sql.match(/"blockCode" IS NOT NULL/g)).toHaveLength(1);
    expect(sql.match(/"blockedAt" IS NULL/g)).toHaveLength(3);
    expect(sql.match(/"blockedAt" IS NOT NULL/g)).toHaveLength(1);
    // `lastRetryCode` is NULL in every arm but PENDING, which is what makes the
    // column mean one thing.
    expect(sql.match(/"lastRetryCode" IS NULL/g)).toHaveLength(3);
    expect(sql.includes(`"lastRetryCode" IS NOT NULL`)).toBe(false);
  });
});

describe("durable shape", () => {
  it("adds exactly one migration, and it is this phase's", () => {
    const migrations = join(REPO_ROOT, "packages", "database", "prisma", "migrations");
    const dirs = readdirSync(migrations, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(dirs.at(-1)).toBe(MIGRATION_DIR);
    expect(dirs.filter((dir) => dir.includes("phase5b"))).toEqual([MIGRATION_DIR]);
  });

  it("creates one table and rewrites no existing row", () => {
    const sql = migrationSql();
    expect(sql.match(/CREATE TABLE/g)).toHaveLength(1);
    expect(sql).toContain(`CREATE TABLE "generation_deliverable_compositions"`);
    // Anchored to the start of a statement: `ON UPDATE CASCADE` and
    // `ON DELETE RESTRICT` are foreign-key clauses on this phase's own new
    // table, not rewrites of anything that already exists.
    for (const banned of ["UPDATE", "DELETE", "TRUNCATE", "DROP", "ALTER COLUMN"]) {
      const statement = new RegExp(`^\\s*${banned}\\b`, "mi");
      expect(`${banned}: ${statement.test(sql)}`).toBe(`${banned}: false`);
    }
  });

  it("restricts the deliverable it names, so paid history cannot cascade away", () => {
    expect(migrationSql()).toContain("ON DELETE RESTRICT");
    expect(migrationSql().includes("ON DELETE CASCADE")).toBe(false);
  });
});
