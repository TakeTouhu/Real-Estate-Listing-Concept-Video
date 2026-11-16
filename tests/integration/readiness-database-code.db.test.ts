import { PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { probeFailureCode } from "@/lib/readiness";

/**
 * What Prisma says of a database it cannot reach (RD-2b, ADR-0152 Decision 3).
 * The readiness probe logs a failure by this code, so a Prisma that names it
 * otherwise is seen here and not in a log. Nothing listens on port 1, and the
 * suite's own database is not asked.
 */
describe("Prisma, asked to connect to a database nothing listens for", () => {
  it("names the reason by a code the readiness probe reads", async () => {
    const client = new PrismaClient({ datasources: { db: { url: "postgresql://probe:probe@127.0.0.1:1/probe" } } });
    try {
      const error: unknown = await client.$connect().then(
        () => undefined,
        (thrown: unknown) => thrown,
      );
      expect(error).toBeInstanceOf(Error);
      expect(probeFailureCode(error)).toBe("P1001");
    } finally {
      await client.$disconnect();
    }
  });
});
