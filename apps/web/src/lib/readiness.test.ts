import { afterEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@app/shared";
import { NonProductionAdapterError } from "@app/storage";
import {
  buildReadiness,
  probeFailureCode,
  READINESS_DATABASE_LIMIT_SECONDS,
  READINESS_STORAGE_KEY,
} from "./readiness";

/** The settings readiness asks its database client by, each time it asks. */
const clientSettings = vi.hoisted(() => vi.fn());
const connect = vi.hoisted(() => vi.fn());
const queryRaw = vi.hoisted(() => vi.fn());
const exists = vi.hoisted(() => vi.fn());
/** What building the storage adapter throws, when it refuses to be built. */
const refusal = vi.hoisted(() => ({ value: undefined as Error | undefined }));
const DATABASE_URL = vi.hoisted(() => "postgresql://probe:probe@database.test:5432/app?schema=public");

vi.mock("@app/database", () => ({
  getReadinessPrismaClient: (...settings: unknown[]) => {
    clientSettings(...settings);
    return { $connect: connect, $queryRaw: queryRaw };
  },
}));
vi.mock("./adapters", () => ({
  getWebAdapters: () => ({
    choice: { storage: "shared-folder" },
    storage: () => {
      if (refusal.value) throw refusal.value;
      return { exists };
    },
  }),
}));
vi.mock("./env", async () => {
  const { serverEnvSchema } = await import("@app/shared");
  const env = serverEnvSchema.parse({
    SESSION_SECRET: "session-secret-abcdef123456",
    HEALTHCHECK_API_TOKEN: "healthcheck-token-abcdef123456",
    STORAGE_SIGNING_SECRET: "storage-signing-secret-abc",
    MFA_SECRET_KEY: "11".repeat(32),
    DATABASE_URL,
  });
  return { getServerEnv: () => env };
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const mock of [clientSettings, connect, queryRaw, exists]) mock.mockReset();
  refusal.value = undefined;
});

/** The lines the web app logged, as it writes them: one JSON object a line. */
function logged(): Record<string, unknown>[] {
  const lines: Record<string, unknown>[] = [];
  vi.spyOn(console, "log").mockImplementation((line: string) => void lines.push(JSON.parse(line)));
  return lines;
}

/** An answer that comes when the test gives it. */
function held(): { readonly answer: Promise<unknown>; give(value: unknown): void; refuse(error: unknown): void } {
  let give!: (value: unknown) => void;
  let refuse!: (error: unknown) => void;
  const answer = new Promise<unknown>((resolve, reject) => {
    give = resolve;
    refuse = reject;
  });
  return { answer, give, refuse };
}

/** Everything that can run before any I/O has run: each caller has asked, or waits. */
const settled = () => new Promise<void>((resolve) => setImmediate(resolve));

const asksOf = () => [connect, queryRaw, exists].map((mock) => mock.mock.calls.length);

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
    // The probe's own client, limited by its own settings (ADR-0153 Decision 1).
    expect(clientSettings.mock.calls).toEqual([[DATABASE_URL, READINESS_DATABASE_LIMIT_SECONDS]]);
    expect(READINESS_DATABASE_LIMIT_SECONDS).toBe(3);
    // Connected first: only then does Prisma say why it could not (ADR-0152 Decision 3).
    expect(connect).toHaveBeenCalledTimes(1);
    expect(queryRaw).toHaveBeenCalledTimes(1);
    expect(connect.mock.invocationCallOrder[0]).toBeLessThan(queryRaw.mock.invocationCallOrder[0] ?? 0);
    expect(queryRaw.mock.calls[0]?.[0]).toEqual(["SELECT 1"]);
    expect(exists.mock.calls).toEqual([[READINESS_STORAGE_KEY]]);
    expect(READINESS_STORAGE_KEY).toBe("readiness/probe");
  });

  it("logs a probe that did not answer by its code alone", async () => {
    const lines = logged();
    const unreachable = "Can't reach database server at db.internal:5432 for user app-user";
    connect.mockRejectedValue(Object.assign(new Error(unreachable), { errorCode: "P1001" }));
    exists.mockRejectedValue(new Error("EACCES: permission denied, stat '/srv/shared/readiness/probe'"));
    const readiness = await buildReadiness();

    expect(readiness.status).toBe("degraded");
    expect(queryRaw).not.toHaveBeenCalled();
    expect(readiness.checks.filter((check) => !check.ok).map((check) => check.name)).toEqual(["database", "storage"]);
    // One line a probe, in whichever order the two failed.
    expect(lines).toHaveLength(2);
    expect(lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ level: "warn", component: "readiness", probe: "database", code: "P1001" }),
        expect.objectContaining({ level: "warn", component: "readiness", probe: "storage", code: "UNEXPECTED" }),
      ]),
    );
    for (const part of ["db.internal", "app-user", "/srv/shared", "EACCES"]) {
      expect(JSON.stringify([lines, readiness])).not.toContain(part);
    }
  });

  it("counts a storage adapter that refuses to be built as not answering", async () => {
    const lines = logged();
    queryRaw.mockResolvedValue([{ "?column?": 1 }]);
    // What a development adapter throws when it is built in production. It has no code.
    refusal.value = new NonProductionAdapterError("SharedFolderObjectStorage", "a folder", "a production adapter");
    const readiness = await buildReadiness();

    expect(readiness.status).toBe("degraded");
    expect(readiness.checks.filter((check) => !check.ok)).toEqual([
      { name: "storage", ok: false, detail: "adapter=shared-folder, does not answer" },
    ]);
    expect(exists).not.toHaveBeenCalled();
    expect(lines).toEqual([expect.objectContaining({ probe: "storage", code: "UNEXPECTED" })]);
  });

  it("keeps one question to each service in flight, and gives its answer to all who asked", async () => {
    const [database, storage] = [held(), held()];
    queryRaw.mockReturnValueOnce(database.answer);
    exists.mockReturnValueOnce(storage.answer);
    const asked = [buildReadiness(), buildReadiness(), buildReadiness()];
    await settled();
    expect(asksOf()).toEqual([1, 1, 1]);

    database.give([{ "?column?": 1 }]);
    storage.give(false);
    expect((await Promise.all(asked)).map((readiness) => readiness.status)).toEqual(["ready", "ready", "ready"]);
    expect(asksOf()).toEqual([1, 1, 1]);

    // An answered question is not kept: whoever asks next asks the services again.
    await buildReadiness();
    expect(asksOf()).toEqual([2, 2, 2]);
  });

  it("gives a shared question's failure to all who asked, and asks again afterwards", async () => {
    const lines = logged();
    const database = held();
    queryRaw.mockReturnValueOnce(database.answer);
    exists.mockResolvedValue(false);
    const asked = [buildReadiness(), buildReadiness()];
    await settled();
    database.refuse({ code: "P2010" });

    for (const readiness of await Promise.all(asked)) {
      expect(readiness.checks.filter((check) => !check.ok).map((check) => check.name)).toEqual(["database"]);
    }
    expect(queryRaw).toHaveBeenCalledTimes(1);
    // Each request that was not answered logs its own line.
    expect(lines.map((line) => [line.probe, line.code])).toEqual([
      ["database", "P2010"],
      ["database", "P2010"],
    ]);

    queryRaw.mockResolvedValue([{ "?column?": 1 }]);
    expect((await buildReadiness()).status).toBe("ready");
    expect(queryRaw).toHaveBeenCalledTimes(2);
  });
});
