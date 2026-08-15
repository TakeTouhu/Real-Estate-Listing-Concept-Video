import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The Phase 4B-1c migration, read as text.
 *
 * Two properties matter and neither is visible from the Prisma schema alone.
 *
 * First, **shape**: the five snapshot columns must be added nullable. A
 * `NOT NULL` column would need a default, and any default would be a fabricated
 * request — a row claiming to have been admitted with settings nobody chose.
 *
 * Second, and more important, **restraint**: the migration must not backfill,
 * must not rewrite a `requestHash`, and must not delete history. A row admitted
 * before this contract has no recoverable snapshot; copying today's storyboard
 * or project values into it would forge a request that was never admitted and
 * whose facts would not even reproduce the stored hash. The absence of those
 * statements is the decision (ADR-0018), so it is asserted rather than assumed.
 */
const MIGRATION = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../packages/database/prisma/migrations/00000000000007_phase4b1c_request_snapshot/migration.sql",
);

const sql = readFileSync(MIGRATION, "utf8");
/** Statements only, with `--` comment lines stripped. */
const statements = sql
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("--"))
  .join("\n");

const SNAPSHOT_COLUMNS = [
  ["requestCompiledPrompt", "TEXT"],
  ["requestDurationSeconds", "INTEGER"],
  ["requestCameraMotion", "TEXT"],
  ["requestAspectRatio", "TEXT"],
  ["requestResolution", "TEXT"],
] as const;

describe("phase 4B-1c migration shape", () => {
  it.each(SNAPSHOT_COLUMNS)("adds %s as %s", (column, type) => {
    expect(statements).toMatch(new RegExp(`ADD COLUMN "${column}"\\s+${type}`));
  });

  it("adds every column nullable", () => {
    // No NOT NULL anywhere in the executable statements — a non-null column
    // would require a default, and a default here is a fabricated request.
    expect(statements).not.toMatch(/NOT NULL/i);
    expect(statements).not.toMatch(/\bDEFAULT\b/i);
  });

  it("touches only the scene_generations table", () => {
    const tables = [...statements.matchAll(/ALTER TABLE\s+"([^"]+)"/gi)].map((m) => m[1]);
    expect(tables).toEqual(["scene_generations"]);
  });
});

describe("phase 4B-1c migration restraint", () => {
  it("performs no backfill", () => {
    expect(statements).not.toMatch(/\bUPDATE\b/i);
    expect(statements).not.toMatch(/\bINSERT\b/i);
  });

  it("rewrites no request hash", () => {
    expect(statements).not.toMatch(/requestHash/);
  });

  it("deletes no history", () => {
    expect(statements).not.toMatch(/\bDELETE\b/i);
    expect(statements).not.toMatch(/\bDROP\b/i);
    expect(statements).not.toMatch(/\bTRUNCATE\b/i);
  });

  it("adds no index or constraint", () => {
    // These columns are reconstruction payload, never a lookup key. Identity
    // lookups keep using the existing partial unique index.
    expect(statements).not.toMatch(/CREATE\s+(UNIQUE\s+)?INDEX/i);
    expect(statements).not.toMatch(/ADD CONSTRAINT/i);
  });
});
