/**
 * Transaction J2's refusal of a finalize that names no Clean Master, with no
 * database at all (ADR-0079 Decision 1).
 *
 * The client is a stand-in that records every property read from it, so a
 * refusal that opened a transaction, took a lock or ran a query would show here
 * as a touch. The database suite proves the same refusal leaves every row as it
 * was; this proves it never reaches the database to begin with.
 */

import { describe, expect, it } from "vitest";
import type { FinalizeCompositionInput } from "@app/domain";
import type { PrismaClient } from "@prisma/client";
import { createDeliverableCompositionExecutionRepository } from "./deliverable-composition-execution-repository";

function untouchableClient(touched: string[]): PrismaClient {
  return new Proxy(
    {},
    {
      get(_target, property) {
        touched.push(String(property));
        throw new Error("the database was reached");
      },
    },
  ) as PrismaClient;
}

describe("J2 refuses a finalize that names no master", () => {
  // Only an untyped caller can omit it: the type requires one.
  for (const [label, input] of [
    ["null", { cleanMaster: null }],
    ["undefined", { cleanMaster: undefined }],
    ["absent", {}],
  ] as const) {
    it(`refuses a master that is ${label} before reaching the database`, async () => {
      const touched: string[] = [];
      const repository = createDeliverableCompositionExecutionRepository(untouchableClient(touched));

      await expect(
        repository.finalizeComposition(input as unknown as FinalizeCompositionInput),
      ).rejects.toThrow(expect.objectContaining({ code: "CLEAN_MASTER_RECEIPT_MISSING" }));
      expect(touched).toEqual([]);
    });
  }
});
