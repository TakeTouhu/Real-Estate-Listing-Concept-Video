import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GRANTABLE_PERMISSIONS } from "./roles";

/**
 * What Phase 6D may and may not have changed (ADR-0058).
 *
 * 1. **One migration**, this phase's, adding one table and touching nothing
 *    else, with a CHECK that admits exactly the grantable vocabulary.
 * 2. **No grant surface.** Grants are a service no route or page reaches yet.
 */

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const MIGRATIONS = join(REPO_ROOT, "packages", "database", "prisma", "migrations");
const MIGRATION_DIR = "00000000000020_phase6d_permission_grants";

function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === "node_modules" || name === ".next" || name === "dist") return [];
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

describe("durable shape", () => {
  it("adds exactly one migration, and it is this phase's", () => {
    const dirs = readdirSync(MIGRATIONS, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    // No longer the newest: Phase 6F added migration 21 after it, Phase 6G
    // migration 22, Phase 6H migration 23, the near-duplicate rule removal
    // migration 24 and MFA-1 migration 25. Phase 6D still contributed exactly
    // one migration, in place.
    expect(dirs.indexOf(MIGRATION_DIR)).toBe(20);
    expect(dirs.filter((dir) => dir.includes("phase6d"))).toEqual([MIGRATION_DIR]);
    // MFA-4 added migration 26 after them all, UP-2 migration 27 and UP-5 migration 28.
    expect(dirs).toHaveLength(29);
  });

  const sql = readFileSync(join(MIGRATIONS, MIGRATION_DIR, "migration.sql"), "utf8").replace(/--[^\n]*/g, " ");

  it("creates one table, cascading from the membership, and alters nothing else", () => {
    expect(sql.match(/CREATE TABLE "([a-z_]+)"/g)).toEqual([`CREATE TABLE "member_permission_grants"`]);
    expect(sql).toContain(`PRIMARY KEY ("organizationId","userId","permission")`);
    expect(sql).toContain(
      `FOREIGN KEY ("organizationId", "userId") REFERENCES "memberships"("organizationId", "userId") ON DELETE CASCADE`,
    );
    expect(new Set(sql.match(/ALTER TABLE "([a-z_]+)"/g))).toEqual(new Set([`ALTER TABLE "member_permission_grants"`]));
    for (const banned of [/^\s*UPDATE\b/m, /^\s*DELETE\b/m, /\bTRUNCATE\b/, /\bDROP\b/, /\bINSERT INTO\b/, /CREATE TYPE/]) {
      expect(sql).not.toMatch(banned);
    }
  });

  it("checks the permission against exactly the grantable vocabulary, never video.share", () => {
    const list = /CHECK \("permission" IN \(([^)]*)\)\)/.exec(sql)?.[1] ?? "";
    const admitted = [...list.matchAll(/'([a-z.]+)'/g)].map((match) => match[1]);
    expect([...admitted].sort()).toEqual([...GRANTABLE_PERMISSIONS].sort());
    expect(admitted).not.toContain("video.share");
  });

  it("maps the schema model onto that table", () => {
    const schema = readFileSync(join(REPO_ROOT, "packages", "database", "prisma", "schema.prisma"), "utf8");
    const body = /model PermissionGrant \{([^}]*)\}/.exec(schema)?.[1] ?? "";
    expect(body).toContain(`@@map("member_permission_grants")`);
    expect(body).toContain("onDelete: Cascade");
  });
});

describe("dormancy", () => {
  it("adds no grant caller to either application", () => {
    const callers = ["apps/web", "apps/worker"]
      .flatMap((app) => sourceFiles(join(REPO_ROOT, app)))
      .filter((file) => /PermissionGrantService|permissionGrants\.(insertIfAbsent|remove)\(/.test(code(readFileSync(file, "utf8"))));
    expect(callers).toEqual([]);
  });
});
