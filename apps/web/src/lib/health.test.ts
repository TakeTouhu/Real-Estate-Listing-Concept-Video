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

/** Both services answer, and the start check refuses nothing. */
const answering: ReadinessInputs = {
  database: () => Promise.resolve(),
  storage: () => Promise.resolve(),
  storageAdapter: "memory",
  startProblems: [],
};

const check = (readiness: Awaited<ReturnType<typeof computeReadiness>>, name: string) =>
  readiness.checks.find((one) => one.name === name);

/** An import statement that starts its line, up to the module it names. */
const IMPORT_STATEMENT = /^import\b[\w\s{},*$]*["'][^"'\n]*["'];?/gm;
/** An import of types alone, which the compiler erases. */
const TYPES_ALONE = /^import type\s*[{*]/;
/** White space and comments, which may stand between "from" and the module a re-export names. */
const GAP = String.raw`(?:\s|/\*[\s\S]*?\*/|//.*)*`;
/**
 * Anything else that can load a module: the words for it, or a re-export. Whole
 * words, so a comment may say "imports only types" and a type may be `Required`.
 */
const LOADS = new RegExp(String.raw`\bimport\b|require(?![a-z])|getBuiltinModule|\bfrom${GAP}["']`, "i");

afterEach(() => {
  vi.restoreAllMocks();
});

describe("buildLiveness", () => {
  it("returns ok with service metadata", () => {
    const live = buildLiveness(() => new Date("2026-01-01T00:00:00.000Z"));
    expect(live.status).toBe("ok");
    expect(live.time).toBe("2026-01-01T00:00:00.000Z");
  });

  it("answers exactly status, service, version, revision and time, in that order", () => {
    const live = buildLiveness(undefined, () => "vtavision-web-00042-abc");
    expect(Object.keys(live)).toEqual(["status", "service", "version", "revision", "time"]);
  });

  it("names Cloud Run's revision when it is well formed (ADR-0183)", () => {
    const at = () => new Date("2026-01-01T00:00:00.000Z");
    for (const name of ["vtavision-web-00042-abc", "a", "a1", `a${"b".repeat(62)}`]) {
      expect(buildLiveness(at, () => name).revision).toBe(name);
    }
  });

  it("answers a null revision when it is unset or not a revision's shape", () => {
    const at = () => new Date("2026-01-01T00:00:00.000Z");
    const malformed = [
      undefined,
      "",
      "Vtavision-web-00042-abc",
      `a${"b".repeat(63)}`,
      "vtavision web",
      "vtavision<web",
      "0vtavision-web",
      "vtavision-web-",
      "-vtavision-web",
      "vtavision.web",
      "vtavision-web\n",
    ];
    for (const value of malformed) expect(buildLiveness(at, () => value).revision).toBeNull();
  });

  describe("by default", () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it("reads K_REVISION at each call", () => {
      vi.stubEnv("K_REVISION", "vtavision-web-00042-abc");
      expect(buildLiveness().revision).toBe("vtavision-web-00042-abc");
      vi.stubEnv("K_REVISION", "Not A Revision");
      expect(buildLiveness().revision).toBeNull();
      vi.stubEnv("K_REVISION", undefined);
      expect(buildLiveness().revision).toBeNull();
    });
  });

  it("is in a module that imports only types, and is all the liveness route loads (ADR-0152 Decision 4)", () => {
    /** A file's import statements, once nothing else in it is seen to load a module. */
    const imports = (file: string) => {
      const source = readFileSync(join(__dirname, file), "utf8");
      // The hits themselves, so a failure names what was found.
      expect(source.replace(IMPORT_STATEMENT, "").match(new RegExp(LOADS.source, "gi")) ?? []).toEqual([]);
      return source.match(IMPORT_STATEMENT) ?? [];
    };
    // The compiler erases an import of types alone, so this module loads no other.
    const own = imports("health.ts");
    expect(own.length).toBeGreaterThan(0);
    for (const statement of own) expect(statement).toMatch(TYPES_ALONE);
    expect(imports("../app/api/health/route.ts")).toEqual([
      'import { NextResponse } from "next/server";',
      'import { buildLiveness } from "@/lib/health";',
    ]);
    // What a scan line by line, or of calls alone, would miss is seen.
    const hidden = [
      'export {\n  a,\n} from "x";',
      'export { a } from // why\n"x";',
      '  import "x";',
      'import { a } from // why\n"x";',
      'import /* c */ ("x");',
      'require.context("x");',
    ];
    for (const source of hidden) expect(source.replace(IMPORT_STATEMENT, "")).toMatch(LOADS);
    // Ordinary words that only contain those letters are not taken for loading.
    for (const plain of ["This module imports only types.", "No authentication required.", "Required<Inputs>"]) {
      expect(plain).not.toMatch(LOADS);
    }
    // A default import named "type" loads its module.
    for (const loading of ['import type  from "x";', 'import type , { a } from "x";']) {
      expect(loading).not.toMatch(TYPES_ALONE);
    }
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
    const answer: (() => void)[] = [];
    const asked = () => vi.fn(() => new Promise<void>((resolve) => void answer.push(resolve)));
    const [database, storage] = [asked(), asked()];
    const pending = computeReadiness(env, new FakeVideoProvider(), { ...answering, database, storage });
    await new Promise((resolve) => setImmediate(resolve));
    // Each is asked while the other has not answered.
    expect(database).toHaveBeenCalledTimes(1);
    expect(storage).toHaveBeenCalledTimes(1);
    for (const one of answer) one();
    expect((await pending).status).toBe("ready");
  });

  it("reports what the start check refuses this start for, last and line by line (ADR-0154)", async () => {
    const ready = await computeReadiness(env, new FakeVideoProvider(), answering);
    expect(ready.checks.at(-1)).toEqual({ name: "start", ok: true, detail: "nothing refused" });

    const startProblems = ['email: "outbox" is not a production adapter', "APP_BASE_URL is not set"];
    const refused = await computeReadiness(env, new FakeVideoProvider(), { ...answering, startProblems });
    // Everything else answers, and the start alone keeps it from ready.
    expect(refused.status).toBe("degraded");
    expect(refused.checks.filter((one) => !one.ok)).toEqual([
      { name: "start", ok: false, detail: 'email: "outbox" is not a production adapter; APP_BASE_URL is not set' },
    ]);
    expect(refused.checks.at(-1)?.name).toBe("start");

    // One reason alone refuses a start.
    const reason = "APP_BASE_URL is not set";
    const single = await computeReadiness(env, new FakeVideoProvider(), { ...answering, startProblems: [reason] });
    expect(single.status).toBe("degraded");
    expect(single.checks.at(-1)).toEqual({ name: "start", ok: false, detail: reason });
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
