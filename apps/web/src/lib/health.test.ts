import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { serverEnvSchema } from "@app/shared";
import { FakeVideoProvider } from "@app/video-providers";
import {
  buildLiveness,
  computeReadiness,
  READINESS_PROBE_LIMIT_MS,
  ReadinessProbeTimeout,
  type ReadinessInputs,
} from "./health";

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
    const imports = (file: string) => {
      const source = readFileSync(join(__dirname, file), "utf8");
      // Nothing is loaded by a call or a re-export, so the import lines are all there is.
      expect(source).not.toMatch(/\b(?:require|import)\s*\(|^export\b.*\bfrom\b/m);
      return source.match(/^import\b.*$/gm) ?? [];
    };
    // The compiler erases an import of types alone, so this module loads no other.
    const own = imports("health.ts");
    expect(own.length).toBeGreaterThan(0);
    for (const line of own) expect(line).toMatch(/^import type\b/);
    expect(imports("../app/api/health/route.ts")).toEqual([
      'import { NextResponse } from "next/server";',
      'import { buildLiveness } from "@/lib/health";',
    ]);
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

  it("gives each probe five seconds (ADR-0152 Decision 2)", async () => {
    const limit = vi.spyOn(AbortSignal, "timeout");
    await computeReadiness(env, new FakeVideoProvider(), answering);
    expect(READINESS_PROBE_LIMIT_MS).toBe(5_000);
    expect(limit.mock.calls).toEqual([[5_000], [5_000]]);
  });

  it("counts a probe that has not answered by then as not answering, and waits for it no longer", async () => {
    // The database's limit and then the storage's, each ended here by hand.
    const limits: AbortController[] = [];
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => {
      limits.push(new AbortController());
      return limits.at(-1)!.signal;
    });
    const failed = vi.fn();
    const never = () => new Promise<void>(() => undefined);
    const pending = computeReadiness(env, new FakeVideoProvider(), { ...answering, database: never, failed });
    let settled = false;
    void pending.then(() => (settled = true));

    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    limits[0]?.abort();
    const readiness = await pending;

    expect(readiness.status).toBe("degraded");
    expect(check(readiness, "database")).toEqual({ name: "database", ok: false, detail: "does not answer" });
    // The storage answered at once, within its own limit.
    expect(check(readiness, "storage")?.ok).toBe(true);
    expect(failed.mock.calls).toEqual([["database", expect.any(ReadinessProbeTimeout)]]);
    expect(new ReadinessProbeTimeout().code).toBe("TIMEOUT");
  });

  it("is not told of a limit that passes after its probe answered", async () => {
    const limits: AbortController[] = [];
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => {
      limits.push(new AbortController());
      return limits.at(-1)!.signal;
    });
    const failed = vi.fn();
    const readiness = await computeReadiness(env, new FakeVideoProvider(), { ...answering, failed });
    for (const limit of limits) limit.abort();
    await new Promise((resolve) => setImmediate(resolve));
    expect(readiness.status).toBe("ready");
    expect(failed).not.toHaveBeenCalled();
  });
});
