import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * A process makes each of its PrismaClients once, however many times its
 * module is evaluated: `next dev` evaluates server modules again on each
 * compile, and a client per evaluation would keep its own connections open.
 * Making a client opens no connection.
 */
afterEach(() => {
  const holder = globalThis as { appPrismaClient?: unknown; readinessPrismaClient?: unknown };
  delete holder.appPrismaClient;
  delete holder.readinessPrismaClient;
});

describe("the process's PrismaClient", () => {
  it("is made once, and kept when the module is evaluated again", async () => {
    const first = (await import("./client")).getPrismaClient();
    expect((await import("./client")).getPrismaClient()).toBe(first);
    vi.resetModules();
    expect((await import("./client")).getPrismaClient()).toBe(first);
  });
});

describe("the readiness probe's PrismaClient (ADR-0153)", () => {
  const ADDRESS = "postgresql://app:s%40cret@db.internal:5432/app?schema=public&sslmode=require";

  it("is a second client, made once and kept when the module is evaluated again", async () => {
    const { getPrismaClient, getReadinessPrismaClient } = await import("./client");
    const first = getReadinessPrismaClient(ADDRESS, 3);
    expect(first === getPrismaClient()).toBe(false);
    // The first address and seconds stand: a later call makes no other client.
    expect(getReadinessPrismaClient("postgresql://other@db.internal/other", 9)).toBe(first);
    vi.resetModules();
    expect((await import("./client")).getReadinessPrismaClient(undefined, 3)).toBe(first);
  });

  it("limits an address to one connection and its seconds, and keeps what else it sets", async () => {
    const { limitedDatabaseUrl } = await import("./client");
    // A second more to wait for the connection than to open it: `P1001` then names one that cannot be opened.
    expect(limitedDatabaseUrl(ADDRESS, 3)).toBe(
      `${ADDRESS}&connection_limit=1&connect_timeout=3&socket_timeout=3&pool_timeout=4`,
    );
    expect(limitedDatabaseUrl("postgresql://app@db.internal/app", 2)).toBe(
      "postgresql://app@db.internal/app?connection_limit=1&connect_timeout=2&socket_timeout=2&pool_timeout=3",
    );
  });

  it("replaces a limit the address already sets, also one that set none or is set twice", async () => {
    const { limitedDatabaseUrl } = await import("./client");
    const wide = "postgresql://app@db.internal/app?connection_limit=20&pool_timeout=0&socket_timeout=60";
    expect(limitedDatabaseUrl(wide, 2)).toBe(
      "postgresql://app@db.internal/app?connection_limit=1&pool_timeout=3&socket_timeout=2&connect_timeout=2",
    );
    const twice = "postgresql://app@db.internal/app?connect_timeout=9&schema=public&connect_timeout=8";
    expect(limitedDatabaseUrl(twice, 2)).toBe(
      "postgresql://app@db.internal/app?connect_timeout=2&schema=public" +
        "&connection_limit=1&socket_timeout=2&pool_timeout=3",
    );
  });

  it("keeps what else an address sets when it spells it otherwise", async () => {
    const { limitedDatabaseUrl } = await import("./client");
    const limits = "connection_limit=1&connect_timeout=2&socket_timeout=2&pool_timeout=3";
    // A socket's folder and a space come out spelled as a form spells them, and a `postgres:` address stays one.
    expect(limitedDatabaseUrl("postgresql://app@localhost/app?host=/var/run/postgresql", 2)).toBe(
      `postgresql://app@localhost/app?host=%2Fvar%2Frun%2Fpostgresql&${limits}`,
    );
    expect(limitedDatabaseUrl("postgres://app@db.internal/app?application_name=web%20app", 2)).toBe(
      `postgres://app@db.internal/app?application_name=web+app&${limits}`,
    );
  });

  it("refuses seconds that Prisma would read as no limit, or not read", async () => {
    const { limitedDatabaseUrl } = await import("./client");
    for (const seconds of [0, -1, 2.5, 1e21, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => limitedDatabaseUrl(ADDRESS, seconds)).toThrow(RangeError);
    }
  });

  it("says nothing of an address that is not a URL", async () => {
    const { limitedDatabaseUrl } = await import("./client");
    let thrown: unknown;
    try {
      limitedDatabaseUrl("postgresql://app:hunter2@db.internal:port/app", 3);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(TypeError);
    // Node.js's own error for it carries the whole address as `input`.
    expect(Object.entries(thrown as object)).toEqual([["code", "ERR_INVALID_URL"]]);
    expect(String((thrown as Error).stack)).not.toContain("hunter2");
  });
});
