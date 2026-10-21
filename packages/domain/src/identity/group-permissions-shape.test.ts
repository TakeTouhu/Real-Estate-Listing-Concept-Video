import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GROUP_GRANTABLE_PERMISSIONS } from "./roles";

/**
 * What Phase 6G may and may not have changed (ADR-0061).
 *
 * 1. **One migration**, this phase's, adding one table and touching nothing
 *    else, with a CHECK that admits exactly what a group may carry: never
 *    `disclosure.none`, never `video.share`.
 * 2. **No group permission surface.** Group permissions are a service no route
 *    or page reaches yet.
 */

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const MIGRATIONS = join(REPO_ROOT, "packages", "database", "prisma", "migrations");
const MIGRATION_DIR = "00000000000022_phase6g_group_permissions";

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
    // No longer the newest: Phase 6H added migration 23 after it, the
    // near-duplicate rule removal migration 24 and MFA-1 migration 25. Phase 6G
    // still contributed exactly one migration, in place.
    expect(dirs.indexOf(MIGRATION_DIR)).toBe(22);
    expect(dirs.filter((dir) => dir.includes("phase6g"))).toEqual([MIGRATION_DIR]);
    // MFA-4 added migration 26 after them all, UP-2 migration 27, UP-5 migration 28
    // and DS-3 migration 29.
    expect(dirs).toHaveLength(31);
  });

  const sql = readFileSync(join(MIGRATIONS, MIGRATION_DIR, "migration.sql"), "utf8").replace(/--[^\n]*/g, " ");

  it("creates one table, cascading from its group within the organization, and alters nothing else", () => {
    expect(sql.match(/CREATE TABLE "([a-z_]+)"/g)).toEqual([`CREATE TABLE "group_permissions"`]);
    expect(sql).toContain(`PRIMARY KEY ("groupId","permission")`);
    expect(sql).toContain(
      `FOREIGN KEY ("groupId", "organizationId") REFERENCES "groups"("id", "organizationId") ON DELETE CASCADE`,
    );
    expect(new Set(sql.match(/ALTER TABLE "([a-z_]+)"/g))).toEqual(new Set([`ALTER TABLE "group_permissions"`]));
    for (const banned of [/^\s*UPDATE\b/m, /^\s*DELETE\b/m, /\bTRUNCATE\b/, /\bDROP\b/, /\bINSERT INTO\b/, /CREATE TYPE/]) {
      expect(sql).not.toMatch(banned);
    }
  });

  it("checks the permission against exactly what a group may carry, never disclosure.none or video.share", () => {
    const list = /CHECK \("permission" IN \(([^)]*)\)\)/.exec(sql)?.[1] ?? "";
    const admitted = [...list.matchAll(/'([a-z.]+)'/g)].map((match) => match[1]);
    expect([...admitted].sort()).toEqual([...GROUP_GRANTABLE_PERMISSIONS].sort());
    expect(admitted).not.toContain("disclosure.none");
    expect(admitted).not.toContain("video.share");
  });

  it("maps the schema model onto that table", () => {
    const schema = readFileSync(join(REPO_ROOT, "packages", "database", "prisma", "schema.prisma"), "utf8");
    const body = /model GroupPermission \{([^}]*)\}/.exec(schema)?.[1] ?? "";
    expect(body).toContain(`@@map("group_permissions")`);
    expect(body).toContain("onDelete: Cascade");
  });
});

describe("dormancy", () => {
  it("adds no group permission caller to either application", () => {
    const callers = ["apps/web", "apps/worker"]
      .flatMap((app) => sourceFiles(join(REPO_ROOT, app)))
      .filter((file) =>
        /grantPermission|revokePermission|listPermissions\(|groupPermission/.test(code(readFileSync(file, "utf8"))),
      );
    expect(callers).toEqual([]);
  });
});
