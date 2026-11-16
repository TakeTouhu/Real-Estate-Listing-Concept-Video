import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { serverEnvSchema, type ServerEnv } from "@app/shared";
import { chooseWebAdapters } from "./adapter-choice";
import {
  checkWebStart,
  PRODUCTION_ADAPTERS,
  productionStartProblems,
  type ProductionAdapters,
  type WebStart,
} from "./startup";

const base = {
  SESSION_SECRET: "session-secret-abcdef123456",
  HEALTHCHECK_API_TOKEN: "healthcheck-token-abcdef123456",
  STORAGE_SIGNING_SECRET: "storage-signing-secret-abc",
};

const development = serverEnvSchema.parse(base);

const production = serverEnvSchema.parse({
  ...base,
  NODE_ENV: "production",
  DATABASE_URL: "postgresql://user:password@db.internal:5432/app",
  MFA_SECRET_KEY: "11".repeat(32),
  APP_BASE_URL: "https://app.example.com",
});

/**
 * No environment passes until RD-3, RD-5 and RD-6 add production adapters.
 * This list and environment stand for one that does: every chosen adapter
 * allowed, every setting set.
 */
const allowingTodays: ProductionAdapters = {
  ...PRODUCTION_ADAPTERS,
  storage: ["memory"],
  malwareScanner: ["passthrough"],
  email: ["outbox"],
};
const served: ServerEnv = { ...production, EMAIL_OUTBOX_DIR: "/tmp/outbox" };

/** A start that records what it reported and how it ended. */
function recorded(loadEnv: () => ServerEnv, allowed: ProductionAdapters = PRODUCTION_ADAPTERS) {
  const reports: string[] = [];
  const exits: number[] = [];
  const start: WebStart = {
    loadEnv,
    allowed,
    report: (message) => reports.push(message),
    exit: (code) => exits.push(code),
  };
  return { start, reports, exits };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("productionStartProblems", () => {
  it("names every port whose adapter is not a production one, and email when there is none", () => {
    expect(productionStartProblems(production)).toEqual([
      'object storage: "memory" is not a production adapter',
      'malware scanning: "passthrough" is not a production adapter',
      "email: none is configured, so sign-up cannot send its verification link",
    ]);
  });

  it("refuses every adapter storage, scanning and email can choose today", () => {
    const dirs = { SHARED_STORAGE_DIR: "/tmp/shared", EMAIL_OUTBOX_DIR: "/tmp/outbox" };
    const folders = serverEnvSchema.parse({ ...base, ...dirs });
    expect(productionStartProblems(folders)).toEqual(
      expect.arrayContaining([
        'object storage: "shared-folder" is not a production adapter',
        'email: "outbox" is not a production adapter',
      ]),
    );
    for (const choice of [chooseWebAdapters(development), chooseWebAdapters(folders)]) {
      for (const port of ["storage", "malwareScanner", "email"] as const) {
        expect(PRODUCTION_ADAPTERS[port]).not.toContain(choice[port]);
      }
    }
  });

  it("names each production setting that is not set, and no setting's value", () => {
    const unset = { DATABASE_URL: undefined, MFA_SECRET_KEY: undefined, APP_BASE_URL: undefined };
    expect(productionStartProblems({ ...production, ...unset }).slice(-3)).toEqual([
      "DATABASE_URL is not set",
      "MFA_SECRET_KEY is not set",
      "APP_BASE_URL is not set",
    ]);
    // Lines about adapters a folder chose and a setting that is missing, beside settings that are set.
    const folders = { SHARED_STORAGE_DIR: "/srv/marker-shared", EMAIL_OUTBOX_DIR: "/srv/marker-outbox" };
    const lines = productionStartProblems({ ...production, ...folders, MFA_SECRET_KEY: undefined });
    expect(lines).toHaveLength(4);
    const values = ["marker", "password", "db.internal", "app.example.com", ...Object.values(base)];
    for (const value of values) expect(lines.join("\n")).not.toContain(value);
  });

  it("allows the offline analysis and prompt moderation (ADR-0150 Decision 3)", () => {
    expect(productionStartProblems(production).join("\n")).not.toMatch(/analysis|moderation/);
  });

  it("refuses an adapter of any port that is not allowed", () => {
    const none: ProductionAdapters = { ...PRODUCTION_ADAPTERS, imageAnalysis: [], promptModeration: [] };
    expect(productionStartProblems(production, none).slice(-2)).toEqual([
      'image analysis: "deterministic" is not a production adapter',
      'prompt moderation: "offline" is not a production adapter',
    ]);
  });

  it("finds nothing wrong once every chosen adapter is allowed and every setting is set", () => {
    expect(productionStartProblems(served, allowingTodays)).toEqual([]);
  });
});

describe("what the start check loads", () => {
  it("imports the choice of adapters and the environment, and no adapter (ADR-0151 Decision 5)", () => {
    const packages = new Set<string>();
    const files = new Set<string>();
    const read = (file: string): void => {
      if (files.has(file)) return;
      files.add(file);
      for (const [, name = ""] of readFileSync(file, "utf8").matchAll(/ from "([^"]+)"/g)) {
        if (name.startsWith(".")) read(join(dirname(file), `${name}.ts`));
        else packages.add(name);
      }
    };
    read(join(__dirname, "startup.ts"));
    expect([...files].map((file) => file.slice(__dirname.length + 1)).sort()).toEqual([
      "adapter-choice.ts",
      "env.ts",
      "startup.ts",
    ]);
    // The environment's schema: no storage, image, database or provider code.
    expect([...packages]).toEqual(["@app/shared"]);
  });
});

describe("checkWebStart", () => {
  const invalid = (): ServerEnv => {
    throw new Error("Invalid server environment configuration:\n  - SESSION_SECRET: Required");
  };

  it("leaves a start alone when neither NODE_ENV says production", () => {
    vi.stubEnv("NODE_ENV", "development");
    const { start, reports, exits } = recorded(() => development);
    checkWebStart(start);
    expect([reports, exits]).toEqual([[], []]);
  });

  it("reports every problem in one message and ends a production start", () => {
    vi.stubEnv("NODE_ENV", "production");
    const { start, reports, exits } = recorded(() => production);
    checkWebStart(start);
    expect(exits).toEqual([1]);
    expect(reports).toEqual([
      "The web app cannot start in production:\n" +
        '  - object storage: "memory" is not a production adapter\n' +
        '  - malware scanning: "passthrough" is not a production adapter\n' +
        "  - email: none is configured, so sign-up cannot send its verification link",
    ]);
  });

  it("checks a start only one NODE_ENV calls production, and refuses it for that (ADR-0150 Decision 2)", () => {
    const refused = (ambient: string, env: ServerEnv, allowed?: ProductionAdapters): string[] => {
      vi.stubEnv("NODE_ENV", ambient);
      const { start, reports, exits } = recorded(() => env, allowed);
      checkWebStart(start);
      expect(exits).toEqual([1]);
      return reports.join("\n").split("\n").slice(1);
    };
    // A production build given another NODE_ENV: the schema's production rules never ran.
    expect(refused("production", { ...served, NODE_ENV: "development" }, allowingTodays)).toEqual([
      '  - NODE_ENV is not "production", but this is a production build',
    ]);
    // A development server given NODE_ENV=production.
    expect(refused("development", served, allowingTodays)).toEqual([
      '  - NODE_ENV is "production", but this is not a production build',
    ]);
    // Neither vouches for the other: the adapters and the settings are checked all the same.
    expect(refused("development", production)).toHaveLength(4);
    expect(refused("production", development)).toContain("  - DATABASE_URL is not set");
  });

  it("ends a production start whose environment is invalid, with the schema's message", () => {
    vi.stubEnv("NODE_ENV", "production");
    const { start, reports, exits } = recorded(invalid);
    checkWebStart(start);
    expect(exits).toEqual([1]);
    expect(reports).toEqual([
      "The web app cannot start in production. Invalid server environment configuration:\n  - SESSION_SECRET: Required",
    ]);
  });

  it("leaves an invalid environment elsewhere to be reported where it is first read", () => {
    vi.stubEnv("NODE_ENV", "development");
    const { start, reports, exits } = recorded(invalid);
    checkWebStart(start);
    expect([reports, exits]).toEqual([[], []]);
  });

  it("lets a production start go on when nothing is wrong", () => {
    vi.stubEnv("NODE_ENV", "production");
    const { start, reports, exits } = recorded(() => served, allowingTodays);
    checkWebStart(start);
    expect([reports, exits]).toEqual([[], []]);
  });
});
