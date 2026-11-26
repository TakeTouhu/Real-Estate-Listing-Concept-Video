import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadServerEnv, resetServerEnvCache, serverEnvSchema, type ServerEnv } from "@app/shared";
import { chooseWebAdapters } from "./adapter-choice";
import {
  checkWebStart,
  PRODUCTION_ADAPTERS,
  productionStartProblems,
  webStartProblems,
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
  FORWARDED_FOR_TRUSTED_ENTRIES: "2",
});

/** The seven SMTP settings, valid. Throwaway values: the password is not a secret. */
const SMTP = {
  SMTP_HOST: "smtp.example.com",
  SMTP_PORT: "587",
  SMTP_TLS: "starttls",
  SMTP_USER: "smtp-user",
  SMTP_PASSWORD: "smtp-password-not-a-secret",
  SMTP_EHLO_NAME: "app.example.com",
  EMAIL_FROM: "noreply@example.com",
};

/** A production environment with nothing wrong: each port's production adapter chosen, every setting set. */
const ready: ServerEnv = serverEnvSchema.parse({
  ...base,
  NODE_ENV: "production",
  DATABASE_URL: "postgresql://user:password@db.internal:5432/app",
  MFA_SECRET_KEY: "11".repeat(32),
  APP_BASE_URL: "https://app.example.com",
  FORWARDED_FOR_TRUSTED_ENTRIES: "2",
  GOOGLE_CLOUD_STORAGE_BUCKET: "vtavision-objects",
  CLAMAV_HOST: "clamav.internal",
  ...SMTP,
});

/** A start that records what it reported and how it ended. */
function recorded(loadEnv: () => ServerEnv) {
  const reports: string[] = [];
  const exits: number[] = [];
  const start: WebStart = {
    loadEnv,
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

  it("refuses every development adapter storage, scanning and email can choose", () => {
    const dirs = { SHARED_STORAGE_DIR: "/tmp/shared", EMAIL_OUTBOX_DIR: "/tmp/outbox" };
    const folders = serverEnvSchema.parse({ ...base, ...dirs });
    const emulator = serverEnvSchema.parse({
      ...base,
      GOOGLE_CLOUD_STORAGE_BUCKET: "vtavision-objects",
      GOOGLE_CLOUD_STORAGE_ENDPOINT: "http://127.0.0.1:4443",
    });
    expect(productionStartProblems(folders)).toEqual(
      expect.arrayContaining([
        'object storage: "shared-folder" is not a production adapter',
        'email: "outbox" is not a production adapter',
      ]),
    );
    expect(productionStartProblems(emulator)[0]).toBe('object storage: "gcs-emulator" is not a production adapter');
    for (const choice of [chooseWebAdapters(development), chooseWebAdapters(folders), chooseWebAdapters(emulator)]) {
      for (const port of ["storage", "malwareScanner", "email"] as const) {
        expect(PRODUCTION_ADAPTERS[port]).not.toContain(choice[port]);
      }
    }
  });

  it("allows Google's own Cloud Storage, and only it, for object storage (ADR-0159)", () => {
    expect(PRODUCTION_ADAPTERS.storage).toEqual(["gcs"]);
    const google = serverEnvSchema.parse({
      ...base,
      NODE_ENV: "production",
      DATABASE_URL: "postgresql://user:password@db.internal:5432/app",
      MFA_SECRET_KEY: "11".repeat(32),
      APP_BASE_URL: "https://app.example.com",
      FORWARDED_FOR_TRUSTED_ENTRIES: "2",
      GOOGLE_CLOUD_STORAGE_BUCKET: "vtavision-objects",
    });
    expect(productionStartProblems(google)).toEqual([
      'malware scanning: "passthrough" is not a production adapter',
      "email: none is configured, so sign-up cannot send its verification link",
    ]);
  });

  it("allows a ClamAV daemon, and only it, for malware scanning (ADR-0164)", () => {
    expect(PRODUCTION_ADAPTERS.malwareScanner).toEqual(["clamav"]);
    const scanned = serverEnvSchema.parse({
      ...base,
      NODE_ENV: "production",
      DATABASE_URL: "postgresql://user:password@db.internal:5432/app",
      MFA_SECRET_KEY: "11".repeat(32),
      APP_BASE_URL: "https://app.example.com",
      FORWARDED_FOR_TRUSTED_ENTRIES: "2",
      GOOGLE_CLOUD_STORAGE_BUCKET: "vtavision-objects",
      CLAMAV_HOST: "clamav.internal",
      CLAMAV_PORT: "3311",
    });
    expect(productionStartProblems(scanned)).toEqual([
      "email: none is configured, so sign-up cannot send its verification link",
    ]);
  });

  it("names each production setting that is not set, and no setting's value", () => {
    const unset = {
      DATABASE_URL: undefined,
      MFA_SECRET_KEY: undefined,
      APP_BASE_URL: undefined,
      FORWARDED_FOR_TRUSTED_ENTRIES: undefined,
    };
    expect(productionStartProblems({ ...production, ...unset }).slice(-4)).toEqual([
      "DATABASE_URL is not set",
      "MFA_SECRET_KEY is not set",
      "APP_BASE_URL is not set",
      "FORWARDED_FOR_TRUSTED_ENTRIES is not set",
    ]);
    // Without the entries alone, a start that is otherwise ready is refused (ADR-0170).
    expect(productionStartProblems({ ...ready, FORWARDED_FOR_TRUSTED_ENTRIES: undefined })).toEqual([
      "FORWARDED_FOR_TRUSTED_ENTRIES is not set",
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

  it("allows the SMTP sender, and only it, for email (ADR-0168)", () => {
    expect(PRODUCTION_ADAPTERS.email).toEqual(["smtp"]);
    expect(chooseWebAdapters(ready).email).toBe("smtp");
    expect(productionStartProblems(ready)).toEqual([]);
  });
});

/** A module named by an import, a re-export, a dynamic `import()` or a `require()`, in any kind of quotes. */
const IMPORTED = /(?:\bfrom\s*|\bimport\s*\(?\s*(?:\/\*[\s\S]*?\*\/\s*)*|\brequire\s*\(\s*)["'`]([^"'`]+)["'`]/g;

describe("what the start hook loads", () => {
  it("imports the check, the choice of adapters and the environment, and no adapter (ADR-0151 Decision 5)", () => {
    const src = join(__dirname, "..");
    const packages = new Set<string>();
    const files = new Set<string>();
    const read = (file: string): void => {
      if (files.has(file)) return;
      files.add(file);
      for (const [, name = ""] of readFileSync(file, "utf8").matchAll(IMPORTED)) {
        if (name.startsWith(".")) read(join(dirname(file), `${name}.ts`));
        else packages.add(name);
      }
    };
    // From the hook itself, whose import of the check is a dynamic one.
    read(join(src, "instrumentation.ts"));
    expect([...files].map((file) => file.slice(src.length + 1)).sort()).toEqual([
      "instrumentation.ts",
      "lib/adapter-choice.ts",
      "lib/env.ts",
      "lib/startup.ts",
    ]);
    // The environment's schema: no storage, image, database or provider code.
    expect([...packages]).toEqual(["@app/shared"]);
  });
});

describe("webStartProblems", () => {
  it("finds nothing in a start neither NODE_ENV calls production, whatever it chose", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(webStartProblems(development)).toEqual([]);
    expect(webStartProblems({ ...production, NODE_ENV: "test" })).toEqual([]);
  });

  it("gives the lines the start check reports, and none where it reports nothing (ADR-0154)", () => {
    const starts: [ambient: string, env: ServerEnv, allowed?: ProductionAdapters][] = [
      ["development", development],
      ["production", production],
      ["production", ready],
      ["production", { ...ready, NODE_ENV: "development" }],
      ["development", ready],
      ["development", { ...production, APP_BASE_URL: undefined }],
    ];
    const counts = starts.map(([ambient, env, allowed]) => {
      vi.stubEnv("NODE_ENV", ambient);
      const lines = webStartProblems(env, allowed);
      const { start, reports, exits } = recorded(() => env);
      checkWebStart(start, allowed);
      const message = `The web app cannot start in production:\n${lines.map((line) => `  - ${line}`).join("\n")}`;
      expect([reports, exits]).toEqual(lines.length === 0 ? [[], []] : [[message], [1]]);
      return lines.length;
    });
    // None in a development start and in a production start with nothing wrong; one where only the
    // two values of NODE_ENV differ; the adapters and the settings beside it where they are wrong too.
    expect(counts).toEqual([0, 3, 0, 1, 1, 5]);
  });
});

describe("NODE_DEBUG (ADR-0158 Decision 6, ADR-0159)", () => {
  it("ends a production start that sets it, with the schema's line, naming none of its value", () => {
    const raw = { ...base, NODE_ENV: "production" as const, NODE_DEBUG: "foo,HTTPS" };
    vi.stubEnv("NODE_ENV", "production");
    // `loadServerEnv` keeps what it parsed for the process: start from nothing kept.
    resetServerEnvCache();
    const { start, reports, exits } = recorded(() => loadServerEnv(raw));
    checkWebStart(start);
    expect(exits).toEqual([1]);
    expect(reports).toEqual([
      "The web app cannot start in production. Invalid server environment configuration:\n" +
        "  - NODE_DEBUG: NODE_DEBUG must not be set in production: " +
        "Node.js would write requests, their tokens included, to the error output",
    ]);
    // A production build given another NODE_ENV is refused for the mismatch; the schema refuses NODE_DEBUG only
    // where the configured value is production.
    const { start: other, reports: otherReports } = recorded(() => serverEnvSchema.parse({ ...raw, NODE_ENV: "test" }));
    checkWebStart(other);
    expect(otherReports.join("\n")).toContain('NODE_ENV is not "production", but this is a production build');
  });
});

describe("the ClamAV settings (ADR-0164)", () => {
  it("end a production start they are wrong for, with the schema's lines, naming neither value", () => {
    const raw = { ...base, NODE_ENV: "production" as const, CLAMAV_HOST: "marker-host:3310", CLAMAV_PORT: "99999" };
    vi.stubEnv("NODE_ENV", "production");
    resetServerEnvCache();
    const { start, reports, exits } = recorded(() => loadServerEnv(raw));
    checkWebStart(start);
    expect(exits).toEqual([1]);
    expect(reports).toEqual([
      "The web app cannot start in production. Invalid server environment configuration:\n" +
        "  - CLAMAV_HOST: CLAMAV_HOST must be a DNS name or an IP address, with no port\n" +
        "  - CLAMAV_PORT: CLAMAV_PORT must be a whole number from 1 to 65535",
    ]);
    expect(reports.join("\n")).not.toMatch(/marker|99999/);
    resetServerEnvCache();
  });
});

describe("the SMTP settings (ADR-0167, ADR-0168)", () => {
  it("end a production start that names a server without the rest, naming no value", () => {
    const raw = { ...base, NODE_ENV: "production" as const, SMTP_HOST: "marker.example.com" };
    vi.stubEnv("NODE_ENV", "production");
    resetServerEnvCache();
    const { start, reports, exits } = recorded(() => loadServerEnv(raw));
    checkWebStart(start);
    expect(exits).toEqual([1]);
    const missing = Object.keys(SMTP).slice(1);
    expect(reports).toEqual([
      "The web app cannot start in production. Invalid server environment configuration:\n" +
        missing.map((name) => `  - ${name}: ${name} is required when SMTP_HOST is set`).join("\n"),
    ]);
    expect(reports.join("\n")).not.toContain("marker");
    resetServerEnvCache();
  });

  it("end a production start that turns off Node.js's certificate check", () => {
    const raw = { ...base, NODE_ENV: "production" as const, NODE_TLS_REJECT_UNAUTHORIZED: "0" };
    vi.stubEnv("NODE_ENV", "production");
    resetServerEnvCache();
    const { start, reports, exits } = recorded(() => loadServerEnv(raw));
    checkWebStart(start);
    expect(exits).toEqual([1]);
    expect(reports).toEqual([
      "The web app cannot start in production. Invalid server environment configuration:\n" +
        "  - NODE_TLS_REJECT_UNAUTHORIZED: NODE_TLS_REJECT_UNAUTHORIZED must not be set in production: " +
        "Node.js would let a connection skip checking the server's certificate",
    ]);
    resetServerEnvCache();
  });
});

describe("the settings that widen what Node.js trusts (ADR-0184)", () => {
  it("end a production start that widens what Node.js trusts, naming no value", () => {
    const raw = { ...base, NODE_ENV: "production" as const, NODE_OPTIONS: "--use-openssl-ca --require=/marker.js" };
    vi.stubEnv("NODE_ENV", "production");
    resetServerEnvCache();
    const { start, reports, exits } = recorded(() => loadServerEnv(raw));
    checkWebStart(start);
    expect(exits).toEqual([1]);
    expect(reports).toEqual([
      "The web app cannot start in production. Invalid server environment configuration:\n" +
        "  - NODE_OPTIONS: NODE_OPTIONS must not be set in production: " +
        "Node.js would take command-line options from it, some of which widen what it trusts",
    ]);
    expect(reports.join("\n")).not.toMatch(/marker|openssl-ca/);
    resetServerEnvCache();
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

  it("reports every problem in one message and ends a production start, judged by PRODUCTION_ADAPTERS", () => {
    vi.stubEnv("NODE_ENV", "production");
    const { start, reports, exits } = recorded(() => production);
    // Given no list of its own, as the start hook gives none.
    checkWebStart(start);
    expect(exits).toEqual([1]);
    expect(reports).toEqual([
      "The web app cannot start in production:\n" +
        '  - object storage: "memory" is not a production adapter\n' +
        '  - malware scanning: "passthrough" is not a production adapter\n' +
        "  - email: none is configured, so sign-up cannot send its verification link",
    ]);
  });

  it("checks a start only one NODE_ENV calls production, and refuses it for that (ADR-0151 Decision 1)", () => {
    const refused = (ambient: string, env: ServerEnv, allowed?: ProductionAdapters): string[] => {
      vi.stubEnv("NODE_ENV", ambient);
      const { start, reports, exits } = recorded(() => env);
      checkWebStart(start, allowed);
      expect(exits).toEqual([1]);
      return reports.join("\n").split("\n").slice(1);
    };
    // A production build given another NODE_ENV: the schema's production rules never ran.
    expect(refused("production", { ...ready, NODE_ENV: "development" })).toEqual([
      '  - NODE_ENV is not "production", but this is a production build',
    ]);
    // A development server given NODE_ENV=production.
    expect(refused("development", ready)).toEqual([
      '  - NODE_ENV is "production", but this is not a production build',
    ]);
    // Neither vouches for the other (ADR-0150 Decision 2): the three adapters and the four
    // settings are checked all the same, after the line about NODE_ENV.
    expect(refused("development", production)).toHaveLength(4);
    const [first, ...rest] = refused("production", development);
    expect(first).toBe('  - NODE_ENV is not "production", but this is a production build');
    expect(rest).toHaveLength(7);
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

  it("writes to standard error and ends the process itself when it is given no start", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SESSION_SECRET", "");
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      checkWebStart();
      expect(exit.mock.calls).toEqual([[1]]);
      expect(error.mock.calls).toHaveLength(1);
      expect(error.mock.calls[0]?.[0]).toMatch(/^The web app cannot start in production\. Invalid server environment/);
    } finally {
      exit.mockRestore();
      error.mockRestore();
    }
  });

  it("lets a production start go on when nothing is wrong", () => {
    vi.stubEnv("NODE_ENV", "production");
    const { start, reports, exits } = recorded(() => ready);
    checkWebStart(start);
    expect([reports, exits]).toEqual([[], []]);
  });
});
