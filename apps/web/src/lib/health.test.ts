import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { serverEnvSchema } from "@app/shared";
import { FakeVideoProvider } from "@app/video-providers";
import { buildLiveness, computeReadiness, type ReadinessInputs } from "./health";

const env = serverEnvSchema.parse({
  SESSION_SECRET: "session-secret-abcdef123456",
  HEALTHCHECK_API_TOKEN: "healthcheck-token-abcdef123456",
  STORAGE_SIGNING_SECRET: "storage-signing-secret-abc",
  MFA_SECRET_KEY: "11".repeat(32),
});

/** Both services answer. */
const answering: ReadinessInputs = {
  database: () => Promise.resolve(),
  storage: () => Promise.resolve(),
  storageAdapter: "memory",
};

const check = (readiness: Awaited<ReturnType<typeof computeReadiness>>, name: string) =>
  readiness.checks.find((one) => one.name === name);

/** White space and block comments, which may stand between the parts of an import. */
const GAP = String.raw`\s*(?:/\*[\s\S]*?\*/\s*)*`;
/** An import statement that starts its line, up to the module it names. */
const IMPORT_STATEMENT = /^import\b[\w\s{},*$]*["'][^"'\n]*["'];?/gm;
/** Anything else that loads a module: a re-export, an import further in, `import()` or `require()`. */
const LOADS = new RegExp(String.raw`\b(?:from|import)${GAP}["']|\b(?:import|require)${GAP}\(`);

afterEach(() => {
  vi.restoreAllMocks();
});

describe("buildLiveness", () => {
  it("returns ok with service metadata", () => {
    const live = buildLiveness(() => new Date("2026-01-01T00:00:00.000Z"));
    expect(live.status).toBe("ok");
    expect(live.time).toBe("2026-01-01T00:00:00.000Z");
  });

  it("is in a module that imports only types, and is all the liveness route loads (ADR-0152 Decision 4)", () => {
    /** A file's import statements, once nothing else in it is seen to load a module. */
    const imports = (file: string) => {
      const source = readFileSync(join(__dirname, file), "utf8");
      expect(source.replace(IMPORT_STATEMENT, "")).not.toMatch(LOADS);
      return source.match(IMPORT_STATEMENT) ?? [];
    };
    // The compiler erases an import of types alone, so this module loads no other.
    const own = imports("health.ts");
    expect(own.length).toBeGreaterThan(0);
    for (const statement of own) expect(statement).toMatch(/^import type\s+(?!from\b)/);
    expect(imports("../app/api/health/route.ts")).toEqual([
      'import { NextResponse } from "next/server";',
      'import { buildLiveness } from "@/lib/health";',
    ]);
    // What a scan line by line would miss is seen.
    const hidden = ['export {\n  a,\n} from "x";', '  import "x";', 'import /* c */ ("x");', 'const x = require("x");'];
    for (const source of hidden) expect(source.replace(IMPORT_STATEMENT, "")).toMatch(LOADS);
  });
});

describe("computeReadiness", () => {
  it("reports ready when the provider adapter self-check passes", async () => {
    const readiness = await computeReadiness(env, new FakeVideoProvider(), answering);
    expect(readiness.status).toBe("ready");
    expect(readiness.provider).toBe("fake");
    expect(readiness.checks[0]).toMatchObject({ name: "video-provider-adapter", ok: true });
  });

  it("reports degraded when the provider self-check throws", async () => {
    const failing = new FakeVideoProvider();
    failing.estimateCost = () => Promise.reject(new Error("nope"));
    const readiness = await computeReadiness(env, failing, answering);
    expect(readiness.status).toBe("degraded");
    expect(readiness.checks[0]?.ok).toBe(false);
  });

  it("reports whether the MFA key is set, and degraded without it (ADR-0065 Decision 17)", async () => {
    const ready = await computeReadiness(env, new FakeVideoProvider(), answering);
    expect(check(ready, "mfa")).toEqual({ name: "mfa", ok: true, detail: "key set" });
    expect(JSON.stringify(ready)).not.toContain("11".repeat(32));

    const keyless = { ...env, MFA_SECRET_KEY: undefined };
    const withoutKey = await computeReadiness(keyless, new FakeVideoProvider(), answering);
    expect(withoutKey.status).toBe("degraded");
    expect(check(withoutKey, "mfa")).toEqual({ name: "mfa", ok: false, detail: "MFA_SECRET_KEY not set" });
  });

  it("asks the database and the storage to answer, and names the storage adapter (ADR-0152 Decision 1)", async () => {
    const inputs: ReadinessInputs = { ...answering, storageAdapter: "shared-folder" };
    const ready = await computeReadiness(env, new FakeVideoProvider(), inputs);
    expect(check(ready, "database")).toEqual({ name: "database", ok: true, detail: "answers" });
    expect(check(ready, "storage")).toEqual({ name: "storage", ok: true, detail: "adapter=shared-folder, answers" });
  });

  it("reports degraded when either does not answer, and never what it threw", async () => {
    const thrown = new Error("connect ECONNREFUSED postgresql://user:password@db.internal:5432/app");
    for (const probe of ["database", "storage"] as const) {
      const failed = vi.fn();
      const inputs = { ...answering, [probe]: () => Promise.reject(thrown), failed };
      const readiness = await computeReadiness(env, new FakeVideoProvider(), inputs);
      expect(readiness.status).toBe("degraded");
      expect(readiness.checks.filter((one) => !one.ok).map((one) => one.name)).toEqual([probe]);
      expect(check(readiness, probe)?.detail).toMatch(/does not answer$/);
      for (const part of ["ECONNREFUSED", "password", "db.internal"]) {
        expect(JSON.stringify(readiness)).not.toContain(part);
      }
      // What it threw goes only to whoever is told of the failure.
      expect(failed.mock.calls).toEqual([[probe, thrown]]);
    }
  });

  it("counts a probe that throws before it returns as not answering", async () => {
    const storage = () => {
      throw new Error("refused to build");
    };
    const readiness = await computeReadiness(env, new FakeVideoProvider(), { ...answering, storage });
    expect(check(readiness, "storage")?.detail).toBe("adapter=memory, does not answer");
    expect(check(readiness, "storage")?.ok).toBe(false);
    expect(check(readiness, "database")?.ok).toBe(true);
  });

  it("asks both at the same time", async () => {
    let answer = (): void => undefined;
    const database = vi.fn(() => new Promise<void>((resolve) => (answer = resolve)));
    const storage = vi.fn(() => Promise.resolve());
    const pending = computeReadiness(env, new FakeVideoProvider(), { ...answering, database, storage });
    await new Promise((resolve) => setImmediate(resolve));
    // The storage is asked while the database has not answered yet.
    expect(database).toHaveBeenCalledTimes(1);
    expect(storage).toHaveBeenCalledTimes(1);
    answer();
    expect((await pending).status).toBe("ready");
  });

  it("answers degraded all the same when no one can be told of the failure", async () => {
    const failed = vi.fn(() => {
      throw new Error("the log is closed");
    });
    const database = () => Promise.reject(new Error("unreachable"));
    const readiness = await computeReadiness(env, new FakeVideoProvider(), { ...answering, database, failed });
    expect(readiness.status).toBe("degraded");
    expect(check(readiness, "database")).toEqual({ name: "database", ok: false, detail: "does not answer" });
    expect(failed).toHaveBeenCalledTimes(1);
  });
});
