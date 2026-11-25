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
  rateLimitPrismaClient?: PrismaClient;
};

/**
 * Lazily construct a process-wide PrismaClient. Requires DATABASE_URL at
 * runtime; never imported by client-side code. It reads the address as it is
 * written, and the web app's readiness probe asks it to connect (ADR-0155).
 */
export function getPrismaClient(): PrismaClient {
  return (holder.appPrismaClient ??= new PrismaClient());
}

/** The address as a URL, or an error that does not repeat it. */
function databaseUrl(url: string): URL {
  try {
    return new URL(url);
  } catch {
    // Node.js's own error carries the whole address, its password too (`input`).
    throw Object.assign(new TypeError("The database address is not a URL"), { code: "ERR_INVALID_URL" });
  }
}

/**
 * A database address whose client is limited by its own settings (ADR-0153
 * Decision 1): one connection, `seconds` to open it and `seconds` to have a
 * query answered. The wait for the connection is given one second more, so
 * that a connection that cannot be opened in time is named as that (`P1001`)
 * and not as a pool with none to give (`P2024`). Whatever else the address
 * sets is kept, though it may be spelled otherwise (`/` in a value as `%2F`).
 * Prisma reads a limit of zero as none for three of the four, and with
 * `socket_timeout=0` its queries were measured to fail now and then
 * (ADR-0155), so `seconds` is a whole number of one or more.
 */
export function limitedDatabaseUrl(url: string, seconds: number): string {
  if (!Number.isSafeInteger(seconds) || seconds < 1) {
    throw new RangeError("A limit is a whole number of seconds, one or more");
  }
  const limited = databaseUrl(url);
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

/**
 * A database address for the abuse limiter's own client (ADR-0171 Decision
 * 6): at most `connections` connections, and each statement ended by the
 * database itself after `statementMilliseconds`, a limit PostgreSQL keeps for
 * one query (`options=-c statement_timeout=...`, as ADR-0153 allows). Options
 * the address already sends are kept, with this one after them; whatever else
 * it sets is kept too, though it may be spelled otherwise.
 */
export function statementLimitedDatabaseUrl(url: string, connections: number, statementMilliseconds: number): string {
  if (![connections, statementMilliseconds].every((value) => Number.isSafeInteger(value) && value >= 1)) {
    throw new RangeError("A connection count and a statement limit are whole numbers, one or more");
  }
  const limited = databaseUrl(url);
  const options = [limited.searchParams.get("options"), `-c statement_timeout=${statementMilliseconds}`];
  limited.searchParams.set("connection_limit", String(connections));
  limited.searchParams.set("options", options.filter((option) => option !== null && option !== "").join(" "));
  return limited.toString();
}

/**
 * The process's PrismaClient for the abuse limiter alone (ADR-0171 Decision
 * 6), so a flood on one key waits for the limiter's few connections and
 * never for the web app's. Made once, from the first address it is given;
 * with no address it is a plain client, which looks for `DATABASE_URL`
 * itself as the first does.
 */
export function getRateLimitPrismaClient(url: string | undefined): PrismaClient {
  return (holder.rateLimitPrismaClient ??= new PrismaClient(
    url === undefined ? undefined : { datasources: { db: { url } } },
  ));
}

export type { PrismaClient };
