import { PrismaClient } from "@prisma/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getPrismaClient, limitedDatabaseUrl } from "@app/database";
import { probeFailureCode } from "@/lib/readiness";

/** The suite's database, read once. No test here prints it: each compares codes, or a yes or no. */
const DATABASE_URL = process.env.DATABASE_URL ?? "";

/** The code the readiness probe would log for a question, or nothing when it was answered. */
const failure = (asked: PromiseLike<unknown>): Promise<string | undefined> =>
  Promise.resolve(asked).then(
    () => undefined,
    (thrown: unknown) => probeFailureCode(thrown),
  );

const setting = (written: string) => `${DATABASE_URL}${DATABASE_URL.includes("?") ? "&" : "?"}${written}`;
const inCapitals = () => DATABASE_URL.replace(/^postgres(ql)?:/, (protocol) => protocol.toUpperCase());

/** Addresses the environment check passes and Prisma refuses as written, each from the suite's own. */
const REFUSED: readonly (readonly [string, () => string, string])[] = [
  ["a space before it", () => ` ${DATABASE_URL}`, "P1012"],
  ["a tab before it", () => `\t${DATABASE_URL}`, "P1012"],
  ["a newline before it", () => `\n${DATABASE_URL}`, "P1012"],
  ["its protocol in capitals", inCapitals, "P1012"],
  ["pool_timeout=10s", () => setting("pool_timeout=10s"), "P1013"],
  ["connection_limit=abc", () => setting("connection_limit=abc"), "P1013"],
  ["connect_timeout=x", () => setting("connect_timeout=x"), "P1013"],
  ["socket_timeout=1.5s", () => setting("socket_timeout=1.5s"), "P1013"],
];

/**
 * What the web app's own client says of an address when it is asked to connect, as readiness asks it, twice:
 * the client `getPrismaClient` makes, which is given no address and reads `DATABASE_URL`.
 *
 * Prisma's engine takes the environment a moment after the client is made, not as it is made, so the address
 * stays in the environment until the client has answered. The name is already there, so no name is added
 * (`first-connection.db.test.ts`), and the client is closed and forgotten before the next is made.
 */
async function ownClientSays(address: string): Promise<(string | undefined)[]> {
  vi.stubEnv("DATABASE_URL", address);
  const client = getPrismaClient();
  try {
    return [await failure(client.$connect()), await failure(client.$connect())];
  } finally {
    await client.$disconnect();
    delete (globalThis as { appPrismaClient?: unknown }).appPrismaClient;
    vi.unstubAllEnvs();
  }
}

/** What the probe's kind of client says of the same address: connected and asked, as the probe does. */
async function limitedClientSays(address: string): Promise<(string | undefined)[]> {
  const client = new PrismaClient({ datasources: { db: { url: limitedDatabaseUrl(address, 1) } } });
  try {
    return [await failure(client.$connect()), await failure(client.$queryRaw`SELECT 1`)];
  } finally {
    await client.$disconnect();
  }
}

/**
 * Why readiness asks the web app's own client to connect (RD-2e, ADR-0155): Prisma refuses some addresses as
 * written that the probe's client, given the address put together again, is answered with. Held against the
 * installed Prisma, so one that reads such an address, names the refusal otherwise or says it only at a query
 * is seen here and not in a log.
 */
describe.skipIf(!DATABASE_URL)("the web app's own database client, asked to connect", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("connects with the suite's address as it is written", async () => {
    expect(await ownClientSays(DATABASE_URL)).toEqual([undefined, undefined]);
    expect(process.env.DATABASE_URL === DATABASE_URL).toBe(true);
  });

  it.each(REFUSED)("refuses an address with %s each time, where the limited is answered", async (_, written, code) => {
    const address = written();
    expect(address === DATABASE_URL).toBe(false);
    expect(await ownClientSays(address)).toEqual([code, code]);
    expect(await limitedClientSays(address)).toEqual([undefined, undefined]);
    expect(process.env.DATABASE_URL === DATABASE_URL).toBe(true);
  });
});
