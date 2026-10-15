import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * What Phase 6F may and may not have changed (ADR-0060).
 *
 * 1. **One migration**, this phase's, adding two tables and touching nothing
 *    else. Both foreign keys of a group member carry the organization.
 * 2. **No group surface.** Groups are a service no route or page reaches yet,
 *    and a group confers nothing: no permission vocabulary on any group table.
 */

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const MIGRATIONS = join(REPO_ROOT, "packages", "database", "prisma", "migrations");
const MIGRATION_DIR = "00000000000021_phase6f_groups";

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
    // No longer the newest: Phase 6G added migration 22 after it, Phase 6H
    // migration 23 and the near-duplicate rule removal migration 24. Phase 6F
    // still contributed exactly one migration, in place.
    expect(dirs.indexOf(MIGRATION_DIR)).toBe(21);
    expect(dirs.filter((dir) => dir.includes("phase6f"))).toEqual([MIGRATION_DIR]);
    expect(dirs).toHaveLength(25);
  });

  const sql = readFileSync(join(MIGRATIONS, MIGRATION_DIR, "migration.sql"), "utf8").replace(/--[^\n]*/g, " ");

  it("creates the two group tables and alters nothing else", () => {
    expect(sql.match(/CREATE TABLE "([a-z_]+)"/g)).toEqual([`CREATE TABLE "groups"`, `CREATE TABLE "group_members"`]);
    expect(new Set(sql.match(/ALTER TABLE "([a-z_]+)"/g))).toEqual(
      new Set([`ALTER TABLE "groups"`, `ALTER TABLE "group_members"`]),
    );
    for (const banned of [/^\s*UPDATE\b/m, /^\s*DELETE\b/m, /\bTRUNCATE\b/, /\bDROP\b/, /\bINSERT INTO\b/, /CREATE TYPE/]) {
      expect(sql).not.toMatch(banned);
    }
  });

  it("keeps a group member inside its group's organization", () => {
    expect(sql).toContain(`PRIMARY KEY ("groupId","userId")`);
    expect(sql).toContain(
      `FOREIGN KEY ("groupId", "organizationId") REFERENCES "groups"("id", "organizationId") ON DELETE CASCADE`,
    );
    expect(sql).toContain(
      `FOREIGN KEY ("organizationId", "userId") REFERENCES "memberships"("organizationId", "userId") ON DELETE CASCADE`,
    );
    expect(sql).toContain(`CREATE UNIQUE INDEX "groups_organizationId_name_key" ON "groups"("organizationId", "name")`);
  });

  it("checks a stored name is trimmed and 1 to 100 characters", () => {
    expect(sql).toContain(`CHECK (char_length("name") BETWEEN 1 AND 100 AND "name" = btrim("name"))`);
  });

  it("leaves group permissions to Phase 6G's migration", () => {
    expect(sql).not.toMatch(/permission/i);
  });
});

describe("dormancy", () => {
  it("adds no group caller to either application", () => {
    const callers = ["apps/web", "apps/worker"]
      .flatMap((app) => sourceFiles(join(REPO_ROOT, app)))
      .filter((file) => /GroupService|\.groups\.\w+\(/.test(code(readFileSync(file, "utf8"))));
    expect(callers).toEqual([]);
  });
});
