import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ACTIVE_SCENE_GENERATION_STATES,
  SCENE_GENERATION_STATES,
  TERMINAL_SCENE_GENERATION_STATES,
} from "@app/domain";

/**
 * The regression guard between the domain's active-state set and the SQL that
 * enforces it.
 *
 * Phase 4A-2a's partial unique index is hand-written, because Prisma cannot
 * express `WHERE` on an index. Hand-written SQL cannot import TypeScript, so
 * the two definitions of "active" live in different files and different
 * languages, and nothing but this test stops them drifting apart.
 *
 * Drift here is not cosmetic. If the domain later gains an active state and the
 * predicate is not updated, that state stops holding the generation identity —
 * and a second job, and so a second billed provider POST, becomes possible for
 * a request that is still in flight.
 *
 * The test reads the real migration file and parses the predicate out of it, so
 * it fails on a domain change until the SQL is updated deliberately. It is not
 * tautological: neither side is derived from the other.
 */
const MIGRATION = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../packages/database/prisma/migrations/00000000000006_phase4a2a_scene_generations/migration.sql",
);

const sql = readFileSync(MIGRATION, "utf8");

/**
 * Pull the state literals out of the partial index's `WHERE … IN (…)` clause.
 *
 * Anchored on the index name so an unrelated future `IN` list elsewhere in the
 * file cannot satisfy this by accident.
 */
function activeStatesInSql(): string[] {
  const index = sql.indexOf('CREATE UNIQUE INDEX "scene_generations_active_request_key"');
  expect(index, "the active-request partial unique index must exist").toBeGreaterThan(-1);
  const clause = /WHERE\s+"state"\s+IN\s*\(([^)]*)\)/i.exec(sql.slice(index));
  expect(clause, "the index must be partial, guarded by a state predicate").not.toBeNull();
  return [...clause![1]!.matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]!);
}

describe("the migration's active-state predicate", () => {
  it("parses a non-empty set of state literals out of the real migration file", () => {
    // Guards the parser itself: a silently empty match would make every
    // comparison below pass vacuously.
    const parsed = activeStatesInSql();
    expect(parsed.length).toBeGreaterThan(0);
  });

  it("matches ACTIVE_SCENE_GENERATION_STATES exactly", () => {
    expect([...activeStatesInSql()].sort()).toEqual([...ACTIVE_SCENE_GENERATION_STATES].sort());
  });

  it("lists no state the domain does not know", () => {
    for (const state of activeStatesInSql()) {
      expect(SCENE_GENERATION_STATES).toContain(state);
    }
  });

  it("excludes every terminal state, so a finished attempt releases the identity", () => {
    const active = activeStatesInSql();
    for (const state of TERMINAL_SCENE_GENERATION_STATES) {
      expect(active).not.toContain(state);
    }
  });

  it("holds the identity for FAILED_RETRYABLE and SUBMISSION_UNKNOWN", () => {
    // The two memberships that are easy to get wrong, and expensive to get
    // wrong: one can return to QUEUED, and the other may already have been
    // billed. Named explicitly so removing either from the SQL fails loudly.
    const active = activeStatesInSql();
    expect(active).toContain("FAILED_RETRYABLE");
    expect(active).toContain("SUBMISSION_UNKNOWN");
  });

  it("indexes the identity the domain defines — (videoProjectId, requestHash)", () => {
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX "scene_generations_active_request_key"\s*\n?\s*ON "scene_generations" \("videoProjectId", "requestHash"\)/,
    );
  });

  it("creates the index in the same migration as the table it guards", () => {
    // Shipping the table first and the invariant later would leave a window
    // where duplicate active attempts — and so duplicate charges — are possible.
    expect(sql).toContain('CREATE TABLE "scene_generations"');
    expect(sql.indexOf('CREATE TABLE "scene_generations"')).toBeLessThan(
      sql.indexOf('CREATE UNIQUE INDEX "scene_generations_active_request_key"'),
    );
  });

  it("keeps the video-project foreign key fail-closed", () => {
    // RESTRICT, not CASCADE: a generation may record a paid provider attempt,
    // so a future physical deletion has to resolve retention deliberately.
    expect(sql).toMatch(
      /ADD CONSTRAINT "scene_generations_videoProjectId_fkey".*ON DELETE RESTRICT/s,
    );
    expect(sql).not.toMatch(
      /ADD CONSTRAINT "scene_generations_videoProjectId_fkey".*ON DELETE CASCADE/s,
    );
  });

  it("adds no foreign key for either provenance column", () => {
    // Both point at rows the system deletes on purpose — storyboard scenes on
    // every recompose, media assets under retention policy.
    expect(sql).not.toMatch(/FOREIGN KEY \("sourceStoryboardSceneId"\)/);
    expect(sql).not.toMatch(/FOREIGN KEY \("assetId"\)/);
  });
});
