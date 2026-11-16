import { afterEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@app/shared";
import { buildReadiness, probeFailureCode, READINESS_STORAGE_KEY } from "./readiness";

const connect = vi.hoisted(() => vi.fn());
const queryRaw = vi.hoisted(() => vi.fn());
const exists = vi.hoisted(() => vi.fn());

vi.mock("@app/database", () => ({ getPrismaClient: () => ({ $connect: connect, $queryRaw: queryRaw }) }));
vi.mock("./adapters", () => ({
  getWebAdapters: () => ({ choice: { storage: "shared-folder" }, storage: () => ({ exists }) }),
}));
vi.mock("./env", async () => {
  const { serverEnvSchema } = await import("@app/shared");
  const env = serverEnvSchema.parse({
    SESSION_SECRET: "session-secret-abcdef123456",
    HEALTHCHECK_API_TOKEN: "healthcheck-token-abcdef123456",
    STORAGE_SIGNING_SECRET: "storage-signing-secret-abc",
    MFA_SECRET_KEY: "11".repeat(32),
  });
  return { getServerEnv: () => env };
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const mock of [connect, queryRaw, exists]) mock.mockReset();
});

describe("probeFailureCode", () => {
  it("gives an error's own code when it is one plain word", () => {
    expect(probeFailureCode(Object.assign(new Error("connect failed"), { code: "ECONNREFUSED" }))).toBe("ECONNREFUSED");
    // Prisma names a first connection that failed by `errorCode`, and a failed query by `code`.
    expect(probeFailureCode({ errorCode: "P1001" })).toBe("P1001");
    expect(probeFailureCode({ code: "P2024", errorCode: "P1001" })).toBe("P2024");
    expect(probeFailureCode({ code: "57P01" })).toBe("57P01");
    // A storage adapter's own error has a code too, and a message that can name the folder's state.
    const unopened = new AppError("CONFIGURATION_ERROR", "The shared storage folder could not be opened (EACCES)");
    expect(probeFailureCode(unopened)).toBe("CONFIGURATION_ERROR");
  });

  it("gives nothing of an error that has no such code, and never its message", () => {
    const sentences = ["postgresql://user:password@db.internal/app", "connect to db.internal"];
    for (const code of [...sentences, "A".repeat(41), "", "eperm"]) {
      expect(probeFailureCode({ code })).toBe("UNEXPECTED");
    }
    for (const error of [new Error("password=hunter2"), "ECONNREFUSED", null, undefined, 7, { code: 7 }]) {
      expect(probeFailureCode(error)).toBe("UNEXPECTED");
    }
  });
});

describe("buildReadiness", () => {
  it("asks the database to connect and for one query, and the chosen storage about one key", async () => {
    queryRaw.mockResolvedValue([{ "?column?": 1 }]);
    exists.mockResolvedValue(false);
    const readiness = await buildReadiness();

    expect(readiness.status).toBe("ready");
    expect(readiness.checks.map((check) => [check.name, check.ok, check.detail])).toEqual([
      ["video-provider-adapter", true, "adapter=fake"],
      ["mfa", true, "key set"],
      ["database", true, "answers"],
      ["storage", true, "adapter=shared-folder, answers"],
    ]);
    // Connected first: only then does Prisma say why it could not (ADR-0152 Decision 3).
    expect(connect).toHaveBeenCalledTimes(1);
    expect(queryRaw).toHaveBeenCalledTimes(1);
    expect(connect.mock.invocationCallOrder[0]).toBeLessThan(queryRaw.mock.invocationCallOrder[0] ?? 0);
    expect(queryRaw.mock.calls[0]?.[0]).toEqual(["SELECT 1"]);
    expect(exists.mock.calls).toEqual([[READINESS_STORAGE_KEY]]);
    expect(READINESS_STORAGE_KEY).toBe("readiness/probe");
  });

  it("logs a probe that did not answer by its code alone", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: string) => void lines.push(line));
    const unreachable = "Can't reach database server at db.internal:5432 for user app-user";
    connect.mockRejectedValue(Object.assign(new Error(unreachable), { errorCode: "P1001" }));
    exists.mockRejectedValue(new Error("EACCES: permission denied, stat '/srv/shared/readiness/probe'"));
    const readiness = await buildReadiness();

    expect(readiness.status).toBe("degraded");
    expect(queryRaw).not.toHaveBeenCalled();
    expect(readiness.checks.filter((check) => !check.ok).map((check) => check.name)).toEqual(["database", "storage"]);
    expect(lines.map((line) => JSON.parse(line) as Record<string, unknown>)).toEqual([
      expect.objectContaining({ level: "warn", component: "readiness", probe: "database", code: "P1001" }),
      expect.objectContaining({ level: "warn", component: "readiness", probe: "storage", code: "UNEXPECTED" }),
    ]);
    for (const part of ["db.internal", "app-user", "/srv/shared", "EACCES"]) {
      expect(lines.join("\n") + JSON.stringify(readiness)).not.toContain(part);
    }
  });
});
