import { afterEach, describe, expect, it, vi } from "vitest";
import { serverEnvSchema, type ServerEnv } from "@app/shared";
import { checkWebStart, productionStartProblems, type WebStart } from "./startup";

const base = {
  SESSION_SECRET: "session-secret-abcdef123456",
  HEALTHCHECK_API_TOKEN: "healthcheck-token-abcdef123456",
  STORAGE_SIGNING_SECRET: "storage-signing-secret-abc",
};

const production = serverEnvSchema.parse({
  ...base,
  NODE_ENV: "production",
  DATABASE_URL: "postgresql://user:password@db.internal:5432/app",
  MFA_SECRET_KEY: "11".repeat(32),
  APP_BASE_URL: "https://app.example.com",
});

/** What a start reported and how it ended. */
function recorder(): WebStart & { readonly reports: string[]; readonly exits: number[] } {
  const reports: string[] = [];
  const exits: number[] = [];
  return { reports, exits, report: (message) => reports.push(message), exit: (code) => exits.push(code) };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("productionStartProblems", () => {
  it("names every port whose adapter refuses production, and email when there is none", () => {
    expect(productionStartProblems(production)).toEqual([
      'object storage: the development adapter "memory" refuses production',
      'malware scanning: the development adapter "passthrough" refuses production',
      "email: none is configured, so sign-up cannot send its verification link",
    ]);
  });

  it("names the development folders as development adapters", () => {
    const env = serverEnvSchema.parse({ ...base, SHARED_STORAGE_DIR: "/tmp/shared", EMAIL_OUTBOX_DIR: "/tmp/outbox" });
    expect(productionStartProblems(env)).toEqual(
      expect.arrayContaining([
        'object storage: the development adapter "shared-folder" refuses production',
        'email: the development adapter "outbox" refuses production',
      ]),
    );
  });

  it("names each production setting that is not set, and never a value", () => {
    const unset = { DATABASE_URL: undefined, MFA_SECRET_KEY: undefined, APP_BASE_URL: undefined };
    const env: ServerEnv = { ...production, ...unset };
    expect(productionStartProblems(env).slice(-3)).toEqual([
      "DATABASE_URL is not set",
      "MFA_SECRET_KEY is not set",
      "APP_BASE_URL is not set",
    ]);
    expect(productionStartProblems(production).join("\n")).not.toContain("password");
  });

  it("leaves the offline analysis and prompt moderation allowed (ADR-0150 Decision 3)", () => {
    expect(productionStartProblems(production).join("\n")).not.toMatch(/analysis|moderation/);
  });
});

describe("checkWebStart", () => {
  it("checks nothing outside production", () => {
    vi.stubEnv("NODE_ENV", "development");
    const start = recorder();
    const loadEnv = vi.fn(() => production);
    checkWebStart(loadEnv, start);
    expect(loadEnv).not.toHaveBeenCalled();
    expect(start.exits).toEqual([]);
  });

  it("reports every problem and ends a production start", () => {
    vi.stubEnv("NODE_ENV", "production");
    const start = recorder();
    checkWebStart(() => production, start);
    expect(start.exits).toEqual([1]);
    expect(start.reports).toHaveLength(1);
    expect(start.reports[0]).toMatch(/^The web app cannot start in production:\n {2}- object storage: /);
    expect(start.reports[0]).not.toContain("password");
  });

  it("ends a production start whose environment is invalid, naming what is wrong", () => {
    vi.stubEnv("NODE_ENV", "production");
    const start = recorder();
    checkWebStart(() => {
      throw new Error("Invalid server environment configuration:\n  - SESSION_SECRET: Required");
    }, start);
    expect(start.exits).toEqual([1]);
    expect(start.reports).toEqual([
      "The web app cannot start in production. Invalid server environment configuration:\n  - SESSION_SECRET: Required",
    ]);
  });
});
