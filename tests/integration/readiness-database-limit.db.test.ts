import { createServer, type AddressInfo, type Socket } from "node:net";
import { PrismaClient } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";
import { getReadinessPrismaClient, limitedDatabaseUrl } from "@app/database";
import { probeFailureCode } from "@/lib/readiness";

/** The suite's database, read once: the probe's client is given its address and looks for none. */
const DATABASE_URL = process.env.DATABASE_URL;

/** The probe's client, limited by one second where the web app gives it three. */
const probe = () => getReadinessPrismaClient(DATABASE_URL, 1);

/** The code the readiness probe would log for a question, or nothing when it was answered. */
const failure = (asked: PromiseLike<unknown>): Promise<string | undefined> =>
  Promise.resolve(asked).then(
    () => undefined,
    (thrown: unknown) => probeFailureCode(thrown),
  );

/**
 * What ends a question the database does not answer (RD-2c, ADR-0153
 * Decision 1): the settings of the probe's own client, with no timer in the
 * app's code. Each gives the code the probe logs, so a Prisma that keeps no
 * such limit, or names it otherwise, is seen here and not in a log.
 */
describe.skipIf(!DATABASE_URL)("the readiness probe's database client, limited by one second", () => {
  afterAll(async () => {
    await probe().$disconnect();
    delete (globalThis as { readinessPrismaClient?: unknown }).readinessPrismaClient;
  });

  it("answers what the database answers in time", async () => {
    await probe().$connect();
    expect(await probe().$queryRaw`SELECT 1 AS answered`).toEqual([{ answered: 1 }]);
  });

  it("gives up on waiting for its one connection, with P2024", async () => {
    await probe().$transaction(async (transaction) => {
      // The transaction keeps the client's one connection until it ends.
      await transaction.$queryRaw`SELECT 1`;
      expect(await failure(probe().$queryRaw`SELECT 1`)).toBe("P2024");
    });
  });

  it("gives up on a connection that is taken and never answered, with P1001", async () => {
    // As a database whose processes are stopped: the system takes the connection, and no one speaks on it.
    const taken = new Set<Socket>();
    const silent = createServer((socket) => void taken.add(socket.on("error", () => undefined)));
    await new Promise<void>((listening) => silent.listen(0, "127.0.0.1", listening));
    const { port } = silent.address() as AddressInfo;
    const url = limitedDatabaseUrl(`postgresql://probe:probe@127.0.0.1:${port}/probe`, 1);
    const client = new PrismaClient({ datasources: { db: { url } } });
    try {
      expect(await failure(client.$connect())).toBe("P1001");
      expect(taken.size).toBeGreaterThan(0);
    } finally {
      await client.$disconnect();
      for (const socket of taken) socket.destroy();
      await new Promise((closed) => silent.close(closed));
    }
  });

  it("gives up on a query the database has not answered, with P2010", async () => {
    // Prisma's code for any raw query that failed, so the time is held too: this one is answered after three seconds.
    // Last of the probe's own: the database goes on sleeping on the connection the client gave up on.
    const asked = Date.now();
    expect(await failure(probe().$queryRaw`SELECT 1 FROM pg_sleep(3)`)).toBe("P2010");
    expect(Date.now() - asked).toBeLessThan(2500);
  });
});
