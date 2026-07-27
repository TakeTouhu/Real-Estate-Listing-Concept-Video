import { PrismaClient } from "@prisma/client";

let client: PrismaClient | undefined;

/**
 * Lazily construct a process-wide PrismaClient. Requires DATABASE_URL at
 * runtime; never imported by client-side code.
 */
export function getPrismaClient(): PrismaClient {
  return (client ??= new PrismaClient());
}

export type { PrismaClient };
