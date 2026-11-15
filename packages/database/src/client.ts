import { PrismaClient } from "@prisma/client";

/**
 * Where the process's one PrismaClient is kept: on the global object, not in
 * this module. `next dev` evaluates server modules again each time it
 * compiles a page, and a client made per evaluation keeps its own pool of
 * connections open, until PostgreSQL refuses any more. A client generated
 * anew (`prisma generate`) is therefore used only after `next dev` restarts.
 */
const holder = globalThis as typeof globalThis & { appPrismaClient?: PrismaClient };

/**
 * Lazily construct a process-wide PrismaClient. Requires DATABASE_URL at
 * runtime; never imported by client-side code.
 */
export function getPrismaClient(): PrismaClient {
  return (holder.appPrismaClient ??= new PrismaClient());
}

export type { PrismaClient };
