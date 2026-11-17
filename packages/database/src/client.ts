import { PrismaClient } from "@prisma/client";

/**
 * Where the process's PrismaClients are kept: on the global object, not in
 * this module. `next dev` evaluates server modules again each time it
 * compiles a page, and a client made per evaluation keeps its own pool of
 * connections open, until PostgreSQL refuses any more. A client generated
 * anew (`prisma generate`) is therefore used only after `next dev` restarts.
 */
const holder = globalThis as typeof globalThis & {
  appPrismaClient?: PrismaClient;
  readinessPrismaClient?: PrismaClient;
};

/**
 * Lazily construct a process-wide PrismaClient. Requires DATABASE_URL at
 * runtime; never imported by client-side code.
 */
export function getPrismaClient(): PrismaClient {
  return (holder.appPrismaClient ??= new PrismaClient());
}

/**
 * A database address whose client is limited by its own settings (ADR-0153
 * Decision 1): one connection, `seconds` to open it and `seconds` to have a
 * query answered. The wait for the connection is given one second more, so
 * that a connection that cannot be opened in time is named as that (`P1001`)
 * and not as a pool with none to give (`P2024`). Whatever else the address
 * sets is kept, though it may be spelled otherwise (`/` in a value as `%2F`).
 * Prisma reads a limit of zero as none, so `seconds` is a whole number of one
 * or more.
 */
export function limitedDatabaseUrl(url: string, seconds: number): string {
  if (!Number.isSafeInteger(seconds) || seconds < 1) {
    throw new RangeError("A limit is a whole number of seconds, one or more");
  }
  let limited: URL;
  try {
    limited = new URL(url);
  } catch {
    // Node.js's own error carries the whole address, its password too (`input`).
    throw Object.assign(new TypeError("The database address is not a URL"), { code: "ERR_INVALID_URL" });
  }
  const limits = { connection_limit: 1, connect_timeout: seconds, socket_timeout: seconds, pool_timeout: seconds + 1 };
  for (const [name, value] of Object.entries(limits)) limited.searchParams.set(name, String(value));
  return limited.toString();
}

/**
 * The process's second PrismaClient, for the readiness probe alone
 * (ADR-0153 Decision 1): the database at `url`, limited as
 * `limitedDatabaseUrl` limits it. Made once, from the address and the seconds
 * it is first given. With no address it is a plain client, which looks for
 * `DATABASE_URL` itself as the first does, and is limited no more than it.
 */
export function getReadinessPrismaClient(url: string | undefined, seconds: number): PrismaClient {
  return (holder.readinessPrismaClient ??= new PrismaClient(
    url === undefined ? undefined : { datasources: { db: { url: limitedDatabaseUrl(url, seconds) } } },
  ));
}

export type { PrismaClient };
