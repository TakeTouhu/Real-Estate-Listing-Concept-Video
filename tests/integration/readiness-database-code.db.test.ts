import { PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { probeFailureCode } from "@/lib/readiness";

/**
 * What Prisma says of a database it cannot reach (RD-2b, ADR-0152 Decision 3).
 * The readiness probe logs a failure by this code, so a Prisma that names it
 * otherwise is seen here and not in a log. Nothing listens on port 1, and the
 * suite's own database is not asked.
 */

/** What a call throws on a client of its own, which is closed afterwards. */
async function thrownBy(call: (client: PrismaClient) => Promise<unknown>): Promise<unknown> {
  const client = new PrismaClient({ datasources: { db: { url: "postgresql://probe:probe@127.0.0.1:1/probe" } } });
  try {
    return await call(client).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
  } finally {
    await client.$disconnect();
  }
}

describe("Prisma, asked for a database nothing listens for", () => {
  it("names the reason by a code the readiness probe reads, when it is asked to connect", async () => {
    const error = await thrownBy((client) => client.$connect());
    expect(error).toBeInstanceOf(Error);
    expect(probeFailureCode(error)).toBe("P1001");
  });

  it("names none when a query is what opens the connection, which is why the probe connects first", async () => {
    const error = await thrownBy((client) => client.$queryRaw`SELECT 1`);
    expect(error).toBeInstanceOf(Error);
    expect(probeFailureCode(error)).toBe("UNEXPECTED");
  });
});
