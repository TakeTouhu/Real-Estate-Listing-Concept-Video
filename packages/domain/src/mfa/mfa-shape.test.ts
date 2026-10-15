import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * What MFA-1 may and may not have changed (ADR-0065).
 *
 * 1. **One migration**, the newest: two MFA tables and three session columns,
 *    rewriting no existing row.
 * 2. **Dormant.** No route, page or worker calls the MFA service or reads
 *    `MFA_SECRET_KEY`, and signing in does not consult MFA yet (MFA-2 and MFA-3).
 */

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const MIGRATIONS = join(REPO_ROOT, "packages", "database", "prisma", "migrations");
const MIGRATION_DIR = "00000000000025_mfa_foundation";

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
  it("adds exactly one migration, the newest, and it is MFA-1's", () => {
    const dirs = readdirSync(MIGRATIONS, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(dirs.at(-1)).toBe(MIGRATION_DIR);
    expect(dirs.filter((dir) => dir.includes("mfa"))).toEqual([MIGRATION_DIR]);
    expect(dirs).toHaveLength(26);
  });

  const sql = readFileSync(join(MIGRATIONS, MIGRATION_DIR, "migration.sql"), "utf8").replace(/--[^\n]*/g, " ");

  it("creates the two MFA tables, adds three session columns and rewrites no row", () => {
    expect(sql.match(/CREATE TABLE "([a-z_]+)"/g)).toEqual([
      `CREATE TABLE "user_mfa_factors"`,
      `CREATE TABLE "user_mfa_recovery_codes"`,
    ]);
    expect(new Set(sql.match(/ALTER TABLE "([a-z_]+)"/g))).toEqual(
      new Set([`ALTER TABLE "sessions"`, `ALTER TABLE "user_mfa_factors"`, `ALTER TABLE "user_mfa_recovery_codes"`]),
    );
    expect(sql.match(/ADD COLUMN\s+"(\w+)"/g)?.map((m) => m.replace(/ADD COLUMN\s+/, ""))).toEqual([
      `"mfaFailedAttempts"`,
      `"mfaPendingSecret"`,
      `"mfaVerifiedAt"`,
    ]);
    expect(sql).toContain(`"mfaFailedAttempts" INTEGER NOT NULL DEFAULT 0`);
    for (const banned of [/^\s*UPDATE\b/m, /^\s*DELETE\b/m, /\bTRUNCATE\b/, /\bDROP\b/, /\bINSERT INTO\b/, /CREATE TYPE/]) {
      expect(sql).not.toMatch(banned);
    }
  });

  it("stores recovery codes only as hashes, and removes them with the factor and the factor with the user", () => {
    expect(sql).toContain(`CHECK ("codeHash" ~ '^[0-9a-f]{64}$')`);
    expect(sql).toContain(`PRIMARY KEY ("userId","codeHash")`);
    expect(sql).toContain(
      `FOREIGN KEY ("userId") REFERENCES "user_mfa_factors"("userId") ON DELETE CASCADE`,
    );
    expect(sql).toContain(`FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE`);
  });
});

describe("dormancy", () => {
  const appFiles = ["apps/web", "apps/worker"].flatMap((app) => sourceFiles(join(REPO_ROOT, app)));

  it("adds no MFA caller to either application", () => {
    const callers = appFiles.filter((file) =>
      /MfaService|createMfaSecretCipher|\.mfa\.\w+\(|MFA_SECRET_KEY/.test(code(readFileSync(file, "utf8"))),
    );
    expect(callers).toEqual([]);
  });

  it("leaves signing in and resolving a session as they were", () => {
    const auth = code(readFileSync(join(REPO_ROOT, "packages/domain/src/identity/auth-service.ts"), "utf8"));
    expect(auth).not.toMatch(/mfa/i);
  });
});
