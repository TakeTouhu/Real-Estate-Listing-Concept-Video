import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ROLES } from "./roles";

/**
 * What Phase 6C may and may not have changed (ADR-0057).
 *
 * 1. **One migration**, this phase's, recreating the `Role` type with the six
 *    templates and mapping `REVIEWER` to `VIEWER` in the two tables that carry a
 *    role — and touching nothing else.
 * 2. **`REVIEWER` is gone** from every production source file, and the old
 *    permission names from every source file, so nothing can still gate on them.
 * 3. **No member-management surface.** The ceiling closes paths no HTTP route
 *    reaches yet; this phase adds none.
 */

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const MIGRATIONS = join(REPO_ROOT, "packages", "database", "prisma", "migrations");
const MIGRATION_DIR = "00000000000019_phase6c_role_templates";

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

const ALL_SOURCES = ["apps", "packages", "tests"].flatMap((root) => sourceFiles(join(REPO_ROOT, root)));

describe("durable shape", () => {
  it("adds exactly one migration, and it is this phase's", () => {
    const dirs = readdirSync(MIGRATIONS, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    // No longer the newest: Phase 6D added migration 20 after it, Phase 6F
    // migration 21, Phase 6G migration 22, Phase 6H migration 23 and the
    // near-duplicate rule removal migration 24 and MFA-1 migration 25. Phase 6C
    // still contributed exactly one migration, in place.
    expect(dirs.indexOf(MIGRATION_DIR)).toBe(19);
    expect(dirs.filter((dir) => dir.includes("phase6c"))).toEqual([MIGRATION_DIR]);
    // MFA-4 added migration 26 after them all, UP-2 migration 27, UP-5 migration 28
    // and DS-3 migration 29.
    expect(dirs).toHaveLength(32);
  });

  it("recreates the Role type and maps REVIEWER to VIEWER in both tables, touching nothing else", () => {
    const sql = readFileSync(join(MIGRATIONS, MIGRATION_DIR, "migration.sql"), "utf8").replace(/--[^\n]*/g, " ");
    expect(sql).toContain(
      `CREATE TYPE "Role_new" AS ENUM ('OWNER', 'ADMIN', 'MANAGER', 'CREATOR', 'VIEWER', 'BILLING');`,
    );
    const mapping = `USING (CASE "role"::text WHEN 'REVIEWER' THEN 'VIEWER' ELSE "role"::text END)::"Role_new";`;
    expect(sql.match(/ALTER TABLE "([a-z_]+)"/g)).toEqual([`ALTER TABLE "memberships"`, `ALTER TABLE "invitations"`]);
    expect(sql.split(mapping)).toHaveLength(3);
    expect(sql).toContain(`DROP TYPE "Role_old";`);
    for (const banned of [/^\s*UPDATE\b/m, /^\s*DELETE\b/m, /\bTRUNCATE\b/, /\bDROP TABLE\b/, /\bINSERT INTO\b/, /CREATE TABLE/]) {
      expect(sql).not.toMatch(banned);
    }
  });

  it("declares the schema's Role enum as exactly the six templates, in order", () => {
    const schema = readFileSync(join(REPO_ROOT, "packages", "database", "prisma", "schema.prisma"), "utf8");
    const body = /enum Role \{([^}]*)\}/.exec(schema)?.[1] ?? "";
    expect(body.split(/\s+/).filter(Boolean)).toEqual([...ROLES]);
  });
});

describe("the old model is gone", () => {
  it("leaves REVIEWER in no production source file", () => {
    // Tests may name it, to assert it is refused; nothing else may.
    const production = ALL_SOURCES.filter((file) => !/\.test\.tsx?$/.test(file) && !file.includes("/tests/"));
    expect(production.filter((file) => /\bREVIEWER\b/.test(code(readFileSync(file, "utf8"))))).toEqual([]);
  });

  it("leaves no pre-ADR-0052 permission name in any source file", () => {
    const old = /"(org:manage|member:read|member:manage|property:write|video:review)"/;
    expect(ALL_SOURCES.filter((file) => old.test(readFileSync(file, "utf8")))).toEqual([]);
  });
});

describe("dormancy", () => {
  it("adds no member-management caller to either application", () => {
    const callers = ["apps/web", "apps/worker"]
      .flatMap((app) => sourceFiles(join(REPO_ROOT, app)))
      // The service is wired into the web container, but none of its writes is called.
      .filter((file) => /\.(invite|acceptInvitation|changeRole|removeMember)\(/.test(code(readFileSync(file, "utf8"))));
    expect(callers).toEqual([]);
  });
});
