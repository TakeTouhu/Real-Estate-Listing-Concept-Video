import { isAbsolute } from "node:path";
import { describe, expect, it } from "vitest";
import {
  E2E_BASE_URL,
  E2E_EMAIL_OUTBOX_DIR,
  E2E_SHARED_STORAGE_DIR,
  REPO_ROOT,
  e2eDatabaseUrl,
  e2eEnvironment,
} from "./environment";

const LOCAL = "postgresql://revt:revt@localhost:5432/revt_e2e?schema=public";

describe("the browser test's environment", () => {
  it("uses a database on this machine, and refuses any other or none, never repeating its address", () => {
    expect(e2eDatabaseUrl({ DATABASE_URL: LOCAL })).toBe(LOCAL);
    expect(e2eDatabaseUrl({ DATABASE_URL: "postgresql://u:p@127.0.0.1:5432/x" })).toContain("127.0.0.1");
    expect(e2eDatabaseUrl({ DATABASE_URL: "postgresql://u:p@[::1]:5432/x" })).toContain("[::1]");
    expect(() => e2eDatabaseUrl({})).toThrow("needs DATABASE_URL");
    expect(() => e2eDatabaseUrl({ DATABASE_URL: " " })).toThrow("needs DATABASE_URL");
    expect(() => e2eDatabaseUrl({ DATABASE_URL: "not an address" })).toThrow("is not an address");
    const socket = "postgresql://u:p@localhost/x?host=/var/run/postgresql";
    expect(e2eDatabaseUrl({ DATABASE_URL: socket })).toBe(socket);
    for (const remote of [
      "postgresql://u:hunter2@db.example.com:5432/prod",
      "postgresql://u:hunter2@localhost:5432/prod?host=db.example.com",
    ]) {
      const refusal = (() => {
        try {
          e2eDatabaseUrl({ DATABASE_URL: remote });
        } catch (error) {
          return String(error);
        }
        return "accepted";
      })();
      expect(refusal).toContain("must name a database on this machine");
      expect(refusal).not.toContain("hunter2");
      expect(refusal).not.toContain("db.example.com");
    }
  });

  it("gives the web app and every command the test provider, one shared folder, an outbox and one secret", () => {
    const env = e2eEnvironment({ DATABASE_URL: LOCAL });
    expect(env).toMatchObject({
      DATABASE_URL: LOCAL,
      VIDEO_PROVIDER: "fake",
      SHARED_STORAGE_DIR: E2E_SHARED_STORAGE_DIR,
    });
    expect(isAbsolute(E2E_SHARED_STORAGE_DIR)).toBe(true);
    expect(E2E_SHARED_STORAGE_DIR.startsWith(REPO_ROOT)).toBe(true);
    // Mail goes to its own folder, never inside the shared one, with links to the web app the test drives.
    expect(env).toMatchObject({ EMAIL_OUTBOX_DIR: E2E_EMAIL_OUTBOX_DIR, APP_BASE_URL: E2E_BASE_URL });
    expect(isAbsolute(E2E_EMAIL_OUTBOX_DIR)).toBe(true);
    expect(E2E_EMAIL_OUTBOX_DIR.startsWith(`${REPO_ROOT}/.e2e/`)).toBe(true);
    expect(E2E_EMAIL_OUTBOX_DIR.startsWith(E2E_SHARED_STORAGE_DIR)).toBe(false);
    expect(env.MFA_SECRET_KEY).toMatch(/^[0-9a-f]{64}$/);
    for (const name of ["SESSION_SECRET", "HEALTHCHECK_API_TOKEN", "STORAGE_SIGNING_SECRET"]) {
      expect(env[name]?.length).toBeGreaterThanOrEqual(16);
    }
    // Next sets the mode itself (`next dev`); a production one is refused.
    expect(env).not.toHaveProperty("NODE_ENV");
    expect(() => e2eEnvironment({ DATABASE_URL: LOCAL, NODE_ENV: "production" })).toThrow("never runs with NODE_ENV");
    expect(() => e2eEnvironment({ DATABASE_URL: "postgresql://u:p@db.example.com/x" })).toThrow("on this machine");
    expect(() => e2eEnvironment({})).toThrow("needs DATABASE_URL");
  });
});
