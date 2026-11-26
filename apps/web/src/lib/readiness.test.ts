import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
/** How the web app's own client is asked for, and its being asked to connect. It has nothing else to be asked. */
const ownClient = vi.hoisted(() => vi.fn());
const ownConnect = vi.hoisted(() => vi.fn());
const exists = vi.hoisted(() => vi.fn());
/** What building the storage adapter throws, when it refuses to be built. */
const refusal = vi.hoisted(() => ({ value: undefined as Error | undefined }));
const DATABASE_URL = vi.hoisted(() => "postgresql://probe:probe@database.test:5432/app?schema=public");

vi.mock("@app/database", () => ({
  getReadinessPrismaClient: (...settings: unknown[]) => {
    clientSettings(...settings);
    return { $connect: connect, $queryRaw: queryRaw };
  },
  getPrismaClient: (...given: unknown[]) => {
    ownClient(...given);
    return { $connect: ownConnect };
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
  vi.unstubAllEnvs();
  for (const mock of [clientSettings, connect, queryRaw, ownClient, ownConnect, exists]) mock.mockReset();
  refusal.value = undefined;
});

/** The lines the web app logged, as it writes them: one JSON object a line. */
function logged(): Record<string, unknown>[] {
  const lines: Record<string, unknown>[] = [];
  vi.spyOn(console, "log").mockImplementation((line: string) => void lines.push(JSON.parse(line)));
  return lines;
}

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
  // The start check reads the ambient NODE_ENV: each case is given one, whatever the run was started with.
  beforeEach(() => vi.stubEnv("NODE_ENV", "test"));

  it("asks the database to connect and for one query, then the web app's own client to connect", async () => {
    const lines = logged();
    queryRaw.mockResolvedValue([{ "?column?": 1 }]);
    exists.mockResolvedValue(false);
    const readiness = await buildReadiness();

    expect(readiness.status).toBe("ready");
    expect(lines).toEqual([]);
    expect(readiness.checks.map((check) => [check.name, check.ok, check.detail])).toEqual([
      ["video-provider-adapter", true, "adapter=fake"],
      ["mfa", true, "key set"],
      ["database", true, "answers"],
      ["storage", true, "adapter=shared-folder, answers"],
      ["start", true, "nothing refused"],
    ]);
    // The probe's own client, limited by its own settings (ADR-0153 Decision 1).
    expect(clientSettings.mock.calls).toEqual([[DATABASE_URL, READINESS_DATABASE_LIMIT_SECONDS]]);
    expect(READINESS_DATABASE_LIMIT_SECONDS).toBe(3);
    // Connected first: only then does Prisma say why it could not (ADR-0152 Decision 3).
    expect(connect).toHaveBeenCalledTimes(1);
    expect(queryRaw).toHaveBeenCalledTimes(1);
    expect(connect.mock.invocationCallOrder[0]).toBeLessThan(queryRaw.mock.invocationCallOrder[0] ?? 0);
    expect(queryRaw.mock.calls[0]?.[0]).toEqual(["SELECT 1"]);
    // Then the web app's own client, which is given no address and reads the one written (ADR-0155).
    expect(ownClient.mock.calls).toEqual([[]]);
    expect(ownConnect.mock.calls).toEqual([[]]);
    const order = [connect, queryRaw, ownClient, ownConnect].map((mock) => mock.mock.invocationCallOrder[0] ?? 0);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(new Set(order).size).toBe(4);
    expect(exists.mock.calls).toEqual([[READINESS_STORAGE_KEY]]);
    expect(READINESS_STORAGE_KEY).toBe("readiness/probe");
  });

  it("reports and logs what the start check refuses of the start it runs in (ADR-0154)", async () => {
    const lines = logged();
    queryRaw.mockResolvedValue([{ "?column?": 1 }]);
    exists.mockResolvedValue(false);
    // A production build, as the start check reads it, with this environment: one of development.
    vi.stubEnv("NODE_ENV", "production");
    const readiness = await buildReadiness();

    const problems = [
      'NODE_ENV is not "production", but this is a production build',
      'object storage: "memory" is not a production adapter',
      'malware scanning: "passthrough" is not a production adapter',
      "email: none is configured, so sign-up cannot send its verification link",
      "APP_BASE_URL is not set",
      "FORWARDED_FOR_TRUSTED_ENTRIES is not set",
    ];
    expect(readiness.status).toBe("degraded");
    expect(readiness.checks.filter((check) => !check.ok)).toEqual([
      { name: "start", ok: false, detail: problems.join("; ") },
    ]);
    // Where an operator who has the log alone reads them: the check wrote none, as it ended nothing.
    const message = "The start check refuses this start";
    const line = { severity: "WARNING", component: "readiness", message, problems };
    expect(lines).toEqual([expect.objectContaining(line)]);
    // The line carries the check's lines beside the logger's own fields, and no other field that has a value here.
    expect(Object.keys(lines[0] ?? {}).sort()).toEqual(["component", "message", "problems", "severity", "time"]);
    // Each time readiness is asked, and not the first time alone (Decision 2).
    await buildReadiness();
    expect(lines).toEqual([expect.objectContaining(line), expect.objectContaining(line)]);

    // Answered all the same when the log cannot be written.
    vi.spyOn(console, "log").mockImplementation(() => {
      throw new Error("the log is closed");
    });
    expect((await buildReadiness()).checks.at(-1)).toEqual({ name: "start", ok: false, detail: problems.join("; ") });
  });

  it("logs a probe that did not answer by its code alone", async () => {
    const lines = logged();
    const unreachable = "Can't reach database server at db.internal:5432 for user app-user";
    connect.mockRejectedValue(Object.assign(new Error(unreachable), { errorCode: "P1001" }));
    exists.mockRejectedValue(new Error("EACCES: permission denied, stat '/srv/shared/readiness/probe'"));
    const readiness = await buildReadiness();

    expect(readiness.status).toBe("degraded");
    expect(queryRaw).not.toHaveBeenCalled();
    // A database that does not answer is not asked through the web app's own client, which keeps Prisma's
    // defaults and would wait by them (ADR-0155).
    expect(ownClient).not.toHaveBeenCalled();
    expect(ownConnect).not.toHaveBeenCalled();
    expect(readiness.checks.filter((check) => !check.ok).map((check) => check.name)).toEqual(["database", "storage"]);
    // One line a probe, in whichever order the two failed.
    expect(lines).toHaveLength(2);
    expect(lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ severity: "WARNING", component: "readiness", probe: "database", code: "P1001" }),
        expect.objectContaining({ severity: "WARNING", component: "readiness", probe: "storage", code: "UNEXPECTED" }),
      ]),
    );
    for (const part of ["db.internal", "app-user", "/srv/shared", "EACCES"]) {
      expect(JSON.stringify([lines, readiness])).not.toContain(part);
    }
  });

  it("counts a database client that cannot be made as not answering", async () => {
    const lines = logged();
    exists.mockResolvedValue(false);
    // What Node.js throws for an address that is not a URL: it carries the whole address.
    clientSettings.mockImplementation(() => {
      throw Object.assign(new TypeError("Invalid URL"), { code: "ERR_INVALID_URL", input: DATABASE_URL });
    });
    const readiness = await buildReadiness();

    expect(readiness.status).toBe("degraded");
    expect(readiness.checks.filter((check) => !check.ok)).toEqual([
      { name: "database", ok: false, detail: "does not answer" },
    ]);
    expect(connect).not.toHaveBeenCalled();
    expect(ownClient).not.toHaveBeenCalled();
    expect(lines).toEqual([expect.objectContaining({ probe: "database", code: "ERR_INVALID_URL" })]);
    expect(JSON.stringify([lines, readiness])).not.toContain("database.test");
  });

  it("makes the web app's own client only once the probe's client has been answered", async () => {
    exists.mockResolvedValue(false);
    // Made beside the probe's client, it would be made during the process's first connection (ADR-0155 Decision 2).
    const answered: { now: (rows: unknown) => void }[] = [];
    connect.mockImplementation(() => new Promise((now) => void answered.push({ now })));
    queryRaw.mockImplementation(() => new Promise((now) => void answered.push({ now })));
    const readiness = buildReadiness();
    const turns = async () => {
      for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
    };

    await turns();
    expect([connect.mock.calls.length, queryRaw.mock.calls.length, ownClient.mock.calls.length]).toEqual([1, 0, 0]);
    answered[0]?.now(undefined);
    await turns();
    expect([connect.mock.calls.length, queryRaw.mock.calls.length, ownClient.mock.calls.length]).toEqual([1, 1, 0]);
    answered[1]?.now([{ "?column?": 1 }]);
    expect((await readiness).status).toBe("ready");
    expect([ownClient.mock.calls.length, ownConnect.mock.calls.length]).toEqual([1, 1]);
  });

  it("does not ask the web app's own client when the probe's query is not answered", async () => {
    const lines = logged();
    exists.mockResolvedValue(false);
    queryRaw.mockRejectedValue(Object.assign(new Error("Raw query failed"), { code: "P2010" }));
    const readiness = await buildReadiness();

    expect(readiness.checks.filter((check) => !check.ok)).toEqual([
      { name: "database", ok: false, detail: "does not answer" },
    ]);
    expect(ownClient).not.toHaveBeenCalled();
    expect(ownConnect).not.toHaveBeenCalled();
    expect(lines).toEqual([expect.objectContaining({ probe: "database", code: "P2010" })]);
  });

  it.each(["P1012", "P1013"])(
    "counts an address the web app's own client cannot read as the database not answering (%s)",
    async (errorCode) => {
      const lines = logged();
      queryRaw.mockResolvedValue([{ "?column?": 1 }]);
      exists.mockResolvedValue(false);
      // Not Prisma's words, which carry no part of the address: a host, a user and a password are put in, so
      // that the test shows nothing of a message reaches the log.
      const said =
        "error: Error validating datasource `db`: the URL must start with the protocol `postgresql://`.\n" +
        '  -->  schema.prisma:11\n   |\n11 |   url      = env("DATABASE_URL")\n' +
        "The provided database string is invalid. invalid digit found in string in database URL " +
        "POSTGRESQL://app-user:hunter2@db.internal:5432/app?pool_timeout=10s";
      ownConnect.mockRejectedValue(Object.assign(new Error(said), { errorCode }));
      const readiness = await buildReadiness();

      // The database answered the probe's client, and the storage answered.
      expect(connect).toHaveBeenCalledTimes(1);
      expect(queryRaw).toHaveBeenCalledTimes(1);
      expect(readiness.status).toBe("degraded");
      expect(readiness.checks.filter((check) => !check.ok)).toEqual([
        { name: "database", ok: false, detail: "does not answer" },
      ]);
      // One line, by the code alone, as for any probe that did not answer (ADR-0152 Decision 3).
      const line = { severity: "WARNING", component: "readiness", message: "A readiness probe did not answer" };
      expect(lines).toEqual([expect.objectContaining({ ...line, probe: "database", code: errorCode })]);
      expect(Object.keys(lines[0] ?? {}).sort()).toEqual(["code", "component", "message", "probe", "severity", "time"]);
      for (const part of ["db.internal", "app-user", "hunter2", "schema.prisma", "DATABASE_URL", "pool_timeout"]) {
        expect(JSON.stringify([lines, readiness])).not.toContain(part);
      }
    },
  );

  it("counts a web app's own client that cannot be made as the database not answering", async () => {
    const lines = logged();
    queryRaw.mockResolvedValue([{ "?column?": 1 }]);
    exists.mockResolvedValue(false);
    // What `new PrismaClient()` throws where no client was generated. It has no code.
    ownClient.mockImplementation(() => {
      throw new Error("@prisma/client did not initialize yet. Please run \"prisma generate\"");
    });
    const readiness = await buildReadiness();

    expect(readiness.checks.filter((check) => !check.ok)).toEqual([
      { name: "database", ok: false, detail: "does not answer" },
    ]);
    expect(ownConnect).not.toHaveBeenCalled();
    expect(lines).toEqual([expect.objectContaining({ probe: "database", code: "UNEXPECTED" })]);
    expect(JSON.stringify([lines, readiness])).not.toContain("prisma generate");
  });

  it("asks the web app's own client each time readiness is asked, and keeps no answer of its own", async () => {
    const lines = logged();
    queryRaw.mockResolvedValue([{ "?column?": 1 }]);
    exists.mockResolvedValue(false);
    // A first connection that failed once: Prisma tries again when it is asked again.
    ownConnect.mockRejectedValueOnce(Object.assign(new Error("Can't reach database server"), { errorCode: "P1001" }));

    expect((await buildReadiness()).status).toBe("degraded");
    expect((await buildReadiness()).status).toBe("ready");
    expect((await buildReadiness()).status).toBe("ready");
    expect(ownConnect).toHaveBeenCalledTimes(3);
    expect(lines).toEqual([expect.objectContaining({ probe: "database", code: "P1001" })]);
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
});
