import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The Phase 4C-3B-2B migration, read as text.
 *
 * The properties that matter here are the ones the Prisma schema cannot show
 * and a green `migrate deploy` cannot prove, because they are about what the
 * migration **does not** do to data that already exists.
 *
 * The stakes are higher than the Phase 4B-1c snapshot's. That migration added
 * columns nobody had written yet. This one touches a column every project row
 * already holds, and it does so while `scene_generations` rows are hashed
 * against those values — so a single well-meaning `UPDATE` would change what a
 * customer asked for underneath an identity computed from it (ADR-0034).
 *
 * The absence of those statements is the decision, so it is asserted rather
 * than assumed.
 */
const MIGRATION = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../packages/database/prisma/migrations/00000000000009_phase4c3b2b_resolution_identity_v2/migration.sql",
);

const sql = readFileSync(MIGRATION, "utf8");

/**
 * Statements only, with `--` comment lines stripped.
 *
 * This file's comments deliberately discuss `UPDATE`, backfilling and rewriting
 * — explaining why none of it happens — so a test reading the raw text would
 * fail on the explanation rather than on the SQL.
 */
const statements = sql
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("--"))
  .join("\n");

const V2_COLUMNS = [
  ["requestModelKey", "TEXT"],
  ["requestTargetOutputResolution", "TEXT"],
  ["requestNativeGenerationResolution", "TEXT"],
  ["requestResolutionNormalization", "TEXT"],
  ["requestNativeMeetsTarget", "BOOLEAN"],
] as const;

describe("phase 4C-3B-2B migration shape", () => {
  it.each(V2_COLUMNS)("adds %s as %s", (column, type) => {
    expect(statements).toMatch(new RegExp(`ADD COLUMN "${column}"\\s+${type}`));
  });

  it("adds every column nullable and without a default", () => {
    // A NOT NULL column would need a default, and a default here is a
    // fabricated delivery plan on an attempt that may already have been paid
    // for. Legacy rows must read as absent, not as "720p, natively, probably".
    //
    // Scoped to the ADD COLUMN lines rather than the whole file: the
    // all-or-none constraint legitimately says `IS NOT NULL` about the columns
    // once a row is V2, which is a different statement from the column itself
    // being non-nullable.
    const addColumnLines = statements
      .split("\n")
      .filter((line) => /ADD COLUMN/i.test(line));
    expect(addColumnLines).toHaveLength(V2_COLUMNS.length);
    for (const line of addColumnLines) {
      expect(line).not.toMatch(/NOT NULL/i);
      expect(line).not.toMatch(/\bDEFAULT\b/i);
    }
  });

  it("touches only the two tables it declares", () => {
    const tables = [...statements.matchAll(/ALTER TABLE\s+"([^"]+)"/gi)].map((m) => m[1]);
    expect(new Set(tables)).toEqual(new Set(["video_projects", "scene_generations"]));
  });
});

describe("phase 4C-3B-2B migration restraint", () => {
  it("rewrites no existing data", () => {
    // The whole point. `video_projects.resolution` holds customer-stated
    // requests and `scene_generations` rows are hashed against them, so a
    // migration that "cleaned up" a value would change what somebody asked for
    // under an identity computed from it.
    expect(statements).not.toMatch(/\bUPDATE\b/i);
    expect(statements).not.toMatch(/\bINSERT\b/i);
    expect(statements).not.toMatch(/\bDELETE\b/i);
    expect(statements).not.toMatch(/\bTRUNCATE\b/i);
  });

  it("drops nothing", () => {
    // `requestResolution` in particular survives: V1 rows were hashed over it,
    // so it is the only surviving record of what they were admitted for.
    expect(statements).not.toMatch(/\bDROP\b/i);
  });

  it("does not rename the physical resolution column", () => {
    // The Prisma model renames it; the column is mapped, not moved. A physical
    // rename would be a larger migration that buys nothing.
    expect(statements).not.toMatch(/RENAME/i);
  });

  it("adds no index", () => {
    // Reconstruction payload, never a lookup key. Identity lookups keep using
    // the existing (videoProjectId, requestHash) partial unique index.
    expect(statements).not.toMatch(/CREATE\s+(UNIQUE\s+)?INDEX/i);
  });
});

describe("phase 4C-3B-2B migration fails closed", () => {
  it("refuses to proceed on an off-vocabulary project resolution", () => {
    // An explicit pre-check that RAISEs, ahead of the constraint. Postgres
    // would abort on the constraint alone, but with generic text; an operator
    // needs to know it is being asked to review customer data rather than to
    // retry.
    expect(statements).toMatch(/RAISE EXCEPTION/i);
    expect(statements).toMatch(/NOT IN \('720p', '1080p'\)/);
  });

  it("constrains the project target to the product vocabulary", () => {
    expect(statements).toMatch(/ADD CONSTRAINT "video_projects_resolution_target_check"/);
  });

  it("makes the two request-identity vocabularies mutually exclusive", () => {
    // Keyed off the hash prefix, so the row states its own version rather than
    // having one inferred from which columns happen to be populated.
    expect(statements).toMatch(
      /ADD CONSTRAINT "scene_generations_request_identity_version_check"/,
    );
    expect(statements).toMatch(/'sha256:v2:%'/);
  });

  it("constrains both closed vocabularies only when a value is present", () => {
    // `IS NULL OR ...` in each, so a legacy row is unaffected rather than
    // retroactively invalid.
    expect(statements).toMatch(/"requestTargetOutputResolution" IS NULL\s*\n\s*OR /);
    expect(statements).toMatch(/"requestResolutionNormalization" IS NULL\s*\n\s*OR /);
    expect(statements).toMatch(/'NONE', 'DOWNSCALE', 'UPSCALE'/);
  });
});
