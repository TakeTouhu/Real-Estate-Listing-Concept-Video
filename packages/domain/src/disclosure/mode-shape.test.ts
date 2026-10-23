import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DISCLOSURE_MODES } from "./mode";

/**
 * What DS-3 may and may not have changed (ADR-0073).
 *
 * 1. **One migration, migration 29**: one enum and two columns, NOT NULL, whose
 *    default exists only for the ADD COLUMN and is dropped at once. Nothing
 *    else is created, and no row is rewritten.
 * 2. **The database's modes are exactly the domain's**, so a mode read from a
 *    row is one the domain knows.
 * 3. **Written only where a job is admitted and a version planned, and never
 *    updated.** Admission refuses a mode not built before its transaction;
 *    Transaction I copies the job's mode onto the version and recomputes a
 *    replay with the version's own.
 */

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const MIGRATIONS = join(REPO_ROOT, "packages", "database", "prisma", "migrations");
const MIGRATION_DIR = "00000000000029_disclosure_mode_frozen";
const JOBS = "packages/database/src/orchestration-repositories.ts";
const PLANS = "packages/database/src/deliverable-composition-repository.ts";
const EXECUTION = "packages/database/src/deliverable-composition-execution-repository.ts";
const VALIDATION = "packages/database/src/deliverable-validation-repository.ts";

function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === "node_modules" || name === ".next" || name === "dist") return [];
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

const read = (path: string) => code(readFileSync(join(REPO_ROOT, path), "utf8"));

function matching(root: string, pattern: RegExp): string[] {
  return sourceFiles(join(REPO_ROOT, root))
    .filter((file) => pattern.test(code(readFileSync(file, "utf8"))))
    .map((file) => file.slice(REPO_ROOT.length + 1))
    .sort();
}

/** The migration's statements, comments dropped and whitespace collapsed. */
function statements(): string[] {
  return readFileSync(join(MIGRATIONS, MIGRATION_DIR, "migration.sql"), "utf8")
    .replace(/--[^\n]*/g, " ")
    .split(";")
    .map((statement) => statement.replace(/\s+/g, " ").trim())
    .filter((statement) => statement.length > 0);
}

/** The values of a Prisma enum, in declaration order. */
function schemaEnum(name: string): string[] {
  const schema = readFileSync(join(REPO_ROOT, "packages", "database", "prisma", "schema.prisma"), "utf8");
  const body = new RegExp(`\\nenum ${name} \\{([^}]*)\\}`).exec(schema)?.[1] ?? "";
  return body
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, "").trim())
    .filter((line) => line.length > 0);
}

/** The body of a model in the schema. */
function schemaModel(name: string): string {
  const schema = readFileSync(join(REPO_ROOT, "packages", "database", "prisma", "schema.prisma"), "utf8");
  return new RegExp(`\\nmodel ${name} \\{([^}]*)\\}`).exec(schema)?.[1] ?? "";
}

describe("DS-3 shape", () => {
  it("adds exactly one migration, in place", () => {
    const dirs = readdirSync(MIGRATIONS, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    // No longer the newest: DS-4 added migration 30 after it, and DS-5b-2a
    // migration 31.
    expect(dirs.indexOf(MIGRATION_DIR)).toBe(29);
    expect(dirs).toHaveLength(32);
  });

  it("creates the enum and two required columns, keeps no default, and rewrites no row", () => {
    expect(statements()).toEqual([
      `CREATE TYPE "DisclosureMode" AS ENUM ('THROUGHOUT')`,
      `ALTER TABLE "generation_jobs" ADD COLUMN "disclosureMode" "DisclosureMode" NOT NULL DEFAULT 'THROUGHOUT'`,
      `ALTER TABLE "generation_jobs" ALTER COLUMN "disclosureMode" DROP DEFAULT`,
      `ALTER TABLE "generation_deliverable_versions" ADD COLUMN "disclosureMode" "DisclosureMode" NOT NULL DEFAULT 'THROUGHOUT'`,
      `ALTER TABLE "generation_deliverable_versions" ALTER COLUMN "disclosureMode" DROP DEFAULT`,
    ]);
  });

  it("stores exactly the domain's modes, on the job and on each version, with no default", () => {
    expect(schemaEnum("DisclosureMode")).toEqual([...DISCLOSURE_MODES]);
    const createType = statements()[0] ?? "";
    expect(createType).toBe(
      `CREATE TYPE "DisclosureMode" AS ENUM (${DISCLOSURE_MODES.map((mode) => `'${mode}'`).join(", ")})`,
    );
    for (const model of ["GenerationJob", "GenerationDeliverableVersion"]) {
      const fields = schemaModel(model)
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.startsWith("disclosureMode "));
      expect(`${model}: ${fields.map((line) => line.replace(/\s+/g, " ")).join(" | ")}`).toBe(
        `${model}: disclosureMode DisclosureMode`,
      );
    }
  });

  it("is written only where a job is admitted and a version planned", () => {
    // DS-5b-2a's composition claim reads the version's mode (ADR-0077), and
    // DS-6a's Transaction G reads it to judge the publication (ADR-0080);
    // neither writes it.
    expect(matching("packages/database/src", /disclosureMode/)).toEqual([EXECUTION, PLANS, VALIDATION, JOBS]);
    // No route admits a whole-video generation yet, and nothing shows the mode.
    expect(matching("apps", /disclosureMode|DisclosureMode/)).toEqual([]);
    // No SQL ever writes it: the raw mentions are the plan's, the claim's and
    // Transaction G's locked reads, and composition discovery's filter.
    for (const file of [PLANS, EXECUTION, VALIDATION, JOBS]) {
      expect(
        read(file).match(
          /(?<!AS )"disclosureMode"(?!::text\s+(?:AS "(?:version)?[dD]isclosureMode"|IN \(\$\{RENDERABLE_DISCLOSURE_MODES\}\)))/g,
        ),
      ).toBeNull();
    }
  });

  it("is read by the composition claim from the version, under its lock, and written nowhere", () => {
    const source = read(EXECUTION);
    expect(source.match(/disclosureMode[^\n]*/g)).toEqual([
      // The locked row's field, discovery's filter, the narrowing, the claim,
      // the version's column.
      "disclosureMode: string;",
      'disclosureMode"::text IN (${RENDERABLE_DISCLOSURE_MODES})',
      "disclosureMode = assertRenderableDisclosureMode(ctx.disclosureMode);",
      "disclosureMode,",
      'disclosureMode"::text        AS "disclosureMode",',
    ]);
    expect(source).toContain('v."disclosureMode"::text        AS "disclosureMode"');
  });

  it("is read by Transaction G from the version, under its lock, and written nowhere", () => {
    // DS-6a (ADR-0080): the chain query reads the version's own mode, never
    // the job's, after the version's row is locked; the gate compares it with
    // what the frozen profile drew.
    const source = read(VALIDATION);
    expect(source.match(/[^\n]*[dD]isclosureMode[^\n]*/g)?.map((line) => line.trim())).toEqual([
      "readonly versionDisclosureMode: string;",
      'v."disclosureMode"::text        AS "versionDisclosureMode",',
      "if (ctx.profileKey === null || !profileDrewDisclosure(ctx.profileKey, ctx.versionDisclosureMode)) {",
    ]);
    expect(source).not.toMatch(/j\."disclosureMode"/);
  });

  it("admits a job's mode once, refusing one not built before the transaction opens", () => {
    const source = read(JOBS);
    expect(source.match(/disclosureMode: [^,\n}]+/g)).toEqual([
      "disclosureMode: r.disclosureMode",
      "disclosureMode: job.disclosureMode",
    ]);
    const create = source.slice(source.indexOf("async create("), source.indexOf("async findById("));
    const refusal = create.indexOf(`if (!isDisclosureMode(job.disclosureMode)) return { kind: "DISCLOSURE_MODE_NOT_SUPPORTED" };`);
    expect(refusal).toBeGreaterThan(-1);
    expect(refusal).toBeLessThan(create.indexOf("prisma.$transaction("));
    expect(create.indexOf("disclosureMode: job.disclosureMode,")).toBeGreaterThan(
      create.indexOf("tx.generationJob.create({"),
    );
  });

  it("copies the job's mode onto the version it plans, and replays with the version's own", () => {
    const source = read(PLANS);
    expect(source.match(/disclosureMode: [^,\n}]+/g)).toEqual([
      // The locked job row's type, then the replay's read and recomputation.
      "disclosureMode: DisclosureMode;",
      "disclosureMode: true",
      "disclosureMode: version.disclosureMode",
    ]);
    const frozen = source.indexOf("const disclosureMode = job.disclosureMode;");
    expect(frozen).toBeGreaterThan(-1);
    // The one value goes into the fingerprint and onto the version, in that order.
    const uses = [...source.matchAll(/^\s+disclosureMode,$/gm)].map((match) => match.index ?? -1);
    expect(uses).toHaveLength(2);
    expect(uses[0]).toBeGreaterThan(frozen);
    expect(uses[0]).toBeLessThan(source.indexOf("tx.generationDeliverableVersion.create("));
    expect(uses[1]).toBeGreaterThan(source.indexOf("tx.generationDeliverableVersion.create("));
  });
});
