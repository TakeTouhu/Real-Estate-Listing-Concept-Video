import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { COMPOSITION_BLOCK_CODES } from "./durable";

/**
 * What DS-5b-2a may and may not have changed (ADR-0077).
 *
 * 1. **One migration, the newest**: two values added to the block-code enum,
 *    nothing else, and no row touched.
 * 2. **The database's block codes are exactly the domain's**, in order.
 * 3. **The master's record is written in Transaction J2 and nowhere else**,
 *    after the video's receipt and before the job moves, so the two commit
 *    together; the receipt and the key it is written at are the ones J2 holds.
 * 4. **Discovery offers only work the claim will take**: frozen under this
 *    build's profile, and planned under a mode it renders.
 *
 * A fifth claim, that the runner recorded no master and blocked with neither
 * new code, held until DS-5b-2b-1 switched the runner to profile v2
 * (ADR-0078); `master-first-shape.test.ts` pins what the runner does now.
 */

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const MIGRATIONS = join(REPO_ROOT, "packages", "database", "prisma", "migrations");
const MIGRATION_DIR = "00000000000031_clean_master_block_codes";
const REPOSITORY = join(
  REPO_ROOT,
  "packages",
  "database",
  "src",
  "deliverable-composition-execution-repository.ts",
);

function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

const repository = () => code(readFileSync(REPOSITORY, "utf8"));

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

/** Where `needle` first occurs in `text`, which it must. */
function at(text: string, needle: string): number {
  const index = text.indexOf(needle);
  expect(`${needle}: ${index > -1}`).toBe(`${needle}: true`);
  return index;
}

/** The body of one repository method, up to the next one. */
function method(name: string, next: string): string {
  const source = repository();
  const start = source.indexOf(`async ${name}(`);
  const end = source.indexOf(`async ${next}(`);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("DS-5b-2a shape", () => {
  it("adds exactly one migration, the newest", () => {
    const dirs = readdirSync(MIGRATIONS, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(dirs.at(-1)).toBe(MIGRATION_DIR);
    expect(dirs).toHaveLength(32);
  });

  it("adds two block codes and nothing else", () => {
    expect(statements()).toEqual([
      `ALTER TYPE "DeliverableCompositionBlockCode" ADD VALUE 'CLEAN_MASTER_SIZE_LIMIT_EXCEEDED'`,
      `ALTER TYPE "DeliverableCompositionBlockCode" ADD VALUE 'CLEAN_MASTER_UNUSABLE'`,
    ]);
  });

  it("stores exactly the domain's block codes, in its order", () => {
    expect(schemaEnum("DeliverableCompositionBlockCode")).toEqual([...COMPOSITION_BLOCK_CODES]);
  });

  it("writes the master's record in J2 only, between the video's receipt and the job's move", () => {
    const source = repository();
    expect(source.match(/generationDeliverableCleanMaster\.\w+/g)).toEqual([
      "generationDeliverableCleanMaster.findUnique",
      "generationDeliverableCleanMaster.create",
    ]);
    expect(source.includes("generation_deliverable_clean_masters")).toBe(false);

    const finalize = method("finalizeComposition", "deferComposition");
    const create = at(finalize, "tx.generationDeliverableCleanMaster.create(");
    expect(create).toBeGreaterThan(at(finalize, "if (verified.count !== 1)"));
    expect(create).toBeLessThan(at(finalize, "tx.generationJob.updateMany("));
    expect(create).toBeGreaterThan(at(finalize, "if (input.cleanMaster !== null) {"));
    // At the key J2 rebuilds, as the video's is, never one taken from the claim.
    expect(finalize).toContain("storageKey: expectedMasterKey,");
    expect(finalize.includes("cleanMasterStorageKey")).toBe(false);
    // The replay reads it after the video's comparison, and writes nothing.
    const replay = finalize.slice(
      at(finalize, `if (ctx.workStatus === "OUTPUT_VERIFIED")`),
      at(finalize, `return { kind: "ALREADY_FINALIZED" };`),
    );
    expect(at(replay, "tx.generationDeliverableCleanMaster.findUnique(")).toBeGreaterThan(
      at(replay, `"OUTPUT_RECEIPT_CONFLICT"`),
    );
    expect(replay).toContain(`"CLEAN_MASTER_RECEIPT_CONFLICT"`);
    expect(replay.includes(".create(")).toBe(false);
    expect(replay.includes(".update")).toBe(false);
  });

  it("offers only work frozen under this build's profile, planned under a mode it renders", () => {
    const find = method("findCompositionCandidates", "claimCompositionWork");
    expect(find).toContain(`AND (w."id" IS NULL OR w."profileKey" = \${COMPOSITION_PROFILE_KEY})`);
    expect(find).toContain(`AND v."disclosureMode"::text IN (\${RENDERABLE_DISCLOSURE_MODES})`);
    // From the list the claim's own refusal reads, as bound parameters.
    expect(repository()).toContain("const RENDERABLE_DISCLOSURE_MODES = Prisma.join([...DISCLOSURE_MODES]);");
  });
});
