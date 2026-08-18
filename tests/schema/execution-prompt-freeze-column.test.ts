import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The Phase 4C-0a migration, read as text.
 *
 * Same two properties the Phase 4B-1c schema test asserts, for the same reasons,
 * and neither is visible from the Prisma schema alone.
 *
 * **Shape**: one nullable column. `NOT NULL` would need a default, and any
 * default would be a fabricated provider prompt — a row claiming it will submit
 * text nobody rendered for it.
 *
 * **Restraint**: no backfill. Backfilling would mean rendering historical rows
 * with *today's* renderer, fabricating for an older request exactly the bytes
 * this column exists to pin down — the drift it prevents, performed deliberately
 * by the migration that prevents it. The absence of those statements is the
 * decision (ADR-0023), so it is asserted rather than assumed.
 */
const MIGRATION = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../packages/database/prisma/migrations/00000000000008_phase4c0a_execution_prompt_freeze/migration.sql",
);

const sql = readFileSync(MIGRATION, "utf8");
/** Statements only, with `--` comment lines stripped. */
const statements = sql
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("--"))
  .join("\n");

describe("the execution-prompt-freeze migration adds one nullable column", () => {
  it("adds requestRenderedPrompt as TEXT", () => {
    expect(statements).toMatch(/ADD COLUMN "requestRenderedPrompt"\s+TEXT/);
  });

  it("declares it nullable, so no row claims a prompt nobody rendered", () => {
    expect(statements).not.toMatch(/requestRenderedPrompt[^;]*NOT NULL/i);
    expect(statements).not.toMatch(/requestRenderedPrompt[^;]*DEFAULT/i);
  });

  it("touches only scene_generations, and only by adding", () => {
    expect(statements).toMatch(/ALTER TABLE "scene_generations"/);
    expect(statements.match(/ALTER TABLE/g)).toHaveLength(1);
    expect(statements).not.toMatch(/DROP\s+(COLUMN|TABLE|INDEX|CONSTRAINT)/i);
    expect(statements).not.toMatch(/RENAME/i);
  });

  it("adds exactly one column and nothing else", () => {
    expect(statements.match(/ADD COLUMN/g)).toHaveLength(1);
  });
});

describe("the migration performs no backfill and rewrites no history", () => {
  it.each(["UPDATE", "INSERT", "DELETE", "TRUNCATE", "MERGE"])(
    "contains no %s statement",
    (verb) => {
      expect(statements).not.toMatch(new RegExp(`\\b${verb}\\b`, "i"));
    },
  );

  it("adds no index, because this is execution payload and not a lookup key", () => {
    expect(statements).not.toMatch(/CREATE\s+(UNIQUE\s+)?INDEX/i);
  });

  it("does not touch requestHash", () => {
    expect(statements).not.toMatch(/requestHash/);
  });
});
