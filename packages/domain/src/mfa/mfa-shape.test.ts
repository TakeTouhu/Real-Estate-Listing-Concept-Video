import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * What MFA may and may not change (ADR-0065).
 *
 * 1. **One migration**, the newest: two MFA tables and three session columns,
 *    rewriting no existing row.
 * 2. **One way in** (MFA-2). Only the web app's `lib/mfa.ts` builds the MFA
 *    service or reads `MFA_SECRET_KEY`, the worker has no MFA at all, and only
 *    `lib/auth.ts` resolves a session, so no route or page can skip the code
 *    step. `AuthService` still knows nothing of MFA.
 * 3. **Set-up first** (MFA-3). A sign-in that must set MFA up reaches only the
 *    security page and the two set-up routes; the readiness probe says only
 *    whether the key is set.
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

describe("boundary", () => {
  const files = (app: string) => sourceFiles(join(REPO_ROOT, app)).filter((file) => !/\.test\.tsx?$/.test(file));
  const matching = (app: string, pattern: RegExp) =>
    files(app)
      .filter((file) => pattern.test(code(readFileSync(file, "utf8"))))
      .map((file) => file.slice(REPO_ROOT.length + 1));

  it("builds the MFA service and reads its key in one web module, and nowhere in the worker", () => {
    expect(matching("apps/web", /new MfaService|createMfaSecretCipher/)).toEqual(["apps/web/src/lib/mfa.ts"]);
    expect(matching("apps/web", /MFA_SECRET_KEY/).sort()).toEqual(["apps/web/src/lib/health.ts", "apps/web/src/lib/mfa.ts"]);
    expect(matching("apps/worker", /Mfa|mfa|MFA_SECRET_KEY/)).toEqual([]);
  });

  it("lets the readiness probe report only whether the key is set", () => {
    const health = code(readFileSync(join(REPO_ROOT, "apps/web/src/lib/health.ts"), "utf8"));
    expect(health.match(/env\.MFA_SECRET_KEY !== undefined/g)).toHaveLength(1);
    const rest = health.replace("env.MFA_SECRET_KEY !== undefined", "").replace('"MFA_SECRET_KEY not set"', "");
    expect(rest).not.toMatch(/MFA_SECRET_KEY/);
  });

  it("resolves a session only in lib/auth.ts, where the code step is applied", () => {
    expect(matching("apps/web", /resolveSession/)).toEqual(["apps/web/src/lib/auth.ts"]);
    expect(code(readFileSync(join(REPO_ROOT, "apps/web/src/lib/auth.ts"), "utf8"))).toMatch(
      /signIn\?\.step === "SIGNED_IN"/,
    );
  });

  it("lets only the sign-in pages, the code step and MFA set-up read a sign-in that has not passed MFA", () => {
    expect(matching("apps/web", /getSignIn\(/).sort()).toEqual([
      "apps/web/src/app/api/auth/mfa/route.ts",
      "apps/web/src/app/login/mfa/page.tsx",
      "apps/web/src/app/login/page.tsx",
      "apps/web/src/app/security/page.tsx",
      "apps/web/src/lib/auth.ts",
      "apps/web/src/lib/mfa.ts",
    ]);
  });

  it("opens only MFA set-up to a sign-in that must set MFA up first (ADR-0065 Decision 16)", () => {
    expect(matching("apps/web", /duringSetup: true/).sort()).toEqual([
      "apps/web/src/app/api/mfa/setup/confirm/route.ts",
      "apps/web/src/app/api/mfa/setup/route.ts",
    ]);
  });

  it("leaves signing in and resolving a session in AuthService as they were", () => {
    const auth = code(readFileSync(join(REPO_ROOT, "packages/domain/src/identity/auth-service.ts"), "utf8"));
    expect(auth).not.toMatch(/mfa/i);
  });
});
