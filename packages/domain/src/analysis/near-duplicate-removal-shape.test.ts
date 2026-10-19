import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * What the near-duplicate rule removal may and may not have changed (ADR-0063,
 * implementing ADR-0052 Decision 14).
 *
 * 1. **One migration**, the newest, that drops the duplicate-approval index and
 *    does nothing else. The perceptual hash, `duplicateGroup` and its
 *    non-unique index stay, for internal use.
 * 2. **No customer-facing look-alike data.** The web app neither returns nor
 *    reads a duplicate group, a "looks similar" list or a primary choice.
 */

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const MIGRATIONS = join(REPO_ROOT, "packages", "database", "prisma", "migrations");
const MIGRATION_DIR = "00000000000024_near_duplicate_rule_removal";
const INDEX = "asset_analyses_org_dupgroup_approved_key";

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

describe("durable shape", () => {
  it("adds exactly one migration, and it is this change's", () => {
    const dirs = readdirSync(MIGRATIONS, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    // No longer the newest: MFA-1 added migration 25 after it. This change still
    // contributed exactly one migration, in place.
    expect(dirs.indexOf(MIGRATION_DIR)).toBe(24);
    expect(dirs.filter((dir) => dir.includes("near_duplicate"))).toEqual([MIGRATION_DIR]);
    // MFA-4 added migration 26 after them all, UP-2 migration 27 and UP-5 migration 28.
    expect(dirs).toHaveLength(29);
  });

  it("drops the duplicate-approval index and does nothing else", () => {
    const sql = readFileSync(join(MIGRATIONS, MIGRATION_DIR, "migration.sql"), "utf8")
      .replace(/--[^\n]*/g, " ")
      .trim();
    expect(sql).toBe(`DROP INDEX "${INDEX}";`);
  });

  it("keeps the duplicate group and its non-unique index in the schema", () => {
    const schema = readFileSync(
      join(REPO_ROOT, "packages", "database", "prisma", "schema.prisma"),
      "utf8",
    );
    expect(schema).toMatch(/duplicateGroup\s+String\?/);
    expect(schema).toContain("@@index([organizationId, duplicateGroup])");
  });

  it("leaves no code that recognizes the dropped index", () => {
    const offenders = ["packages", "apps"]
      .flatMap((root) => sourceFiles(join(REPO_ROOT, root)))
      .filter((file) => /dupgroup_approved|DuplicateApprovalConflict/.test(code(readFileSync(file, "utf8"))));
    expect(offenders).toEqual([]);
  });
});

describe("no customer-facing look-alike data", () => {
  it("the web app neither returns nor reads a duplicate group, similar list or primary", () => {
    const offenders = sourceFiles(join(REPO_ROOT, "apps", "web", "src")).filter((file) =>
      /duplicateGroup|duplicateOf|primaryAssetId/.test(code(readFileSync(file, "utf8"))),
    );
    expect(offenders).toEqual([]);
  });
});
