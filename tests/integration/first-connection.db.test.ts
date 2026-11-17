import { PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";

/**
 * What `vitest.integration.config.ts` sets for every file of this suite, and
 * why it is enough.
 *
 * Each file runs in a process of its own. At that process's first connection
 * Prisma's engine sets `SSL_CERT_FILE` and `SSL_CERT_DIR` from a thread of its
 * own. A name that is not in the environment yet can make the C library move
 * the environment and free the old one while a client being built is copying
 * it. Processes without the names were seen to leave a second client without
 * `DATABASE_URL` (P1012), or to die. P1012 was seen in CI three times, twice
 * in a file's second client (the first record does not say in which).
 *
 * A name that is already there is replaced in place, and nothing moves. So
 * the suite's configuration sets both before a file loads, and this file
 * holds the two things that makes true: both names are there before any
 * client is, and the first connection adds no name. Should a later engine set
 * another name, the second fails and names it.
 */

const HAS_DB = Boolean(process.env.DATABASE_URL);

/** Names alone: a value may be an address or a secret, and a failed comparison prints what it compared. */
const names = (): string[] => Object.keys(process.env).sort();

describe.skipIf(!HAS_DB)("the first connection of a database suite's process", () => {
  it("finds both names set, and adds none", async () => {
    const before = names();
    expect(["SSL_CERT_DIR", "SSL_CERT_FILE"].filter((name) => !before.includes(name))).toEqual([]);

    // This file makes no other client, so this is the process's first connection.
    const first = new PrismaClient();
    try {
      expect(await first.$queryRaw`SELECT 1 AS one`).toEqual([{ one: 1 }]);
    } finally {
      await first.$disconnect();
    }

    expect(names().filter((name) => !before.includes(name))).toEqual([]);
  });
});
