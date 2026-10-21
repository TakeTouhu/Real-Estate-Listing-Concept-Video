import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * What Phase 6H may and may not have changed (ADR-0062).
 *
 * 1. **One migration**, this phase's, adding two nullable columns to
 *    `properties`, each with a foreign key that carries the organization and
 *    refuses deletion, and touching nothing else. No existing row is rewritten:
 *    every existing Property starts unassigned.
 * 2. **No assignment surface.** Reassignment is a service no route or page
 *    reaches yet, and the create route passes no assignment.
 */

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const MIGRATIONS = join(REPO_ROOT, "packages", "database", "prisma", "migrations");
const MIGRATION_DIR = "00000000000023_phase6h_property_assignment";

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
    // No longer the newest: the near-duplicate rule removal added migration 24
    // after it, and MFA-1 migration 25. Phase 6H still contributed exactly one
    // migration, in place.
    expect(dirs.indexOf(MIGRATION_DIR)).toBe(23);
    expect(dirs.filter((dir) => dir.includes("phase6h"))).toEqual([MIGRATION_DIR]);
    // MFA-4 added migration 26 after them all, UP-2 migration 27, UP-5 migration 28
    // and DS-3 migration 29.
    expect(dirs).toHaveLength(31);
  });

  const sql = readFileSync(join(MIGRATIONS, MIGRATION_DIR, "migration.sql"), "utf8").replace(/--[^\n]*/g, " ");

  it("adds two nullable columns to properties, and alters nothing else", () => {
    expect(sql).toMatch(/ADD COLUMN\s+"groupId" TEXT,/);
    expect(sql).toMatch(/ADD COLUMN\s+"responsibleUserId" TEXT;/);
    expect(sql).not.toMatch(/NOT NULL|DEFAULT/);
    expect(new Set(sql.match(/ALTER TABLE "([a-z_]+)"/g))).toEqual(new Set([`ALTER TABLE "properties"`]));
    for (const banned of [/^\s*UPDATE\b/m, /^\s*DELETE\b/m, /\bTRUNCATE\b/, /\bDROP\b/, /\bINSERT INTO\b/, /CREATE (TABLE|TYPE)/]) {
      expect(sql).not.toMatch(banned);
    }
  });

  it("keeps each assignment inside the organization, and never clears one silently", () => {
    expect(sql).toContain(
      `FOREIGN KEY ("organizationId", "responsibleUserId") REFERENCES "memberships"("organizationId", "userId") ON DELETE NO ACTION`,
    );
    expect(sql).toContain(
      `FOREIGN KEY ("groupId", "organizationId") REFERENCES "groups"("id", "organizationId") ON DELETE NO ACTION`,
    );
    expect(sql.match(/FOREIGN KEY/g)).toHaveLength(2);
    expect(sql.match(/CREATE INDEX/g)).toHaveLength(2);
  });

  it("maps the schema model onto those columns", () => {
    const schema = readFileSync(join(REPO_ROOT, "packages", "database", "prisma", "schema.prisma"), "utf8");
    const body = /model Property \{([^}]*)\}/.exec(schema)?.[1] ?? "";
    expect(body).toMatch(/responsibleUserId\s+String\?/);
    expect(body).toMatch(/groupId\s+String\?/);
    expect(body.match(/onDelete: NoAction/g)).toHaveLength(2);
  });
});

describe("dormancy", () => {
  it("adds no reassignment caller to either application", () => {
    const callers = ["apps/web", "apps/worker"]
      .flatMap((app) => sourceFiles(join(REPO_ROOT, app)))
      .filter((file) => /properties\.assign\(|AssignPropertyInput|listGroupIdsForMember/.test(code(readFileSync(file, "utf8"))));
    expect(callers).toEqual([]);
  });

  it("passes no assignment when a Property is created over HTTP", () => {
    const route = code(readFileSync(join(REPO_ROOT, "apps", "web", "src", "app", "api", "properties", "route.ts"), "utf8"));
    expect(route).toContain("properties.create(");
    expect(route).not.toMatch(/responsibleUserId|groupId/);
  });
});
