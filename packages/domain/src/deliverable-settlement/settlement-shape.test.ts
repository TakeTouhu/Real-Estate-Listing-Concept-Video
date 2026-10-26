import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * What the database settlement of a failed deliverable may write (ADR-0082).
 *
 * The composition block and the terminal verdicts move a customer's Unit only
 * through `deliverable-failure-settlement.ts`, and their own guards
 * (`deliverable-composition-execution/dormancy.test.ts`,
 * `deliverable-validation/dormancy.test.ts`) hold that they write none of it
 * themselves. These hold what the settlement module does write: a release and
 * nothing else on the reservation, never a consume or the deliverable pointer,
 * and only the job state the domain's decision chose.
 */

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const DATABASE_SRC = join(REPO_ROOT, "packages", "database", "src");
const SETTLEMENT_MODULE = join(DATABASE_SRC, "deliverable-failure-settlement.ts");

/** Comments stripped, so prose naming a symbol is not mistaken for using it. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

function source(path: string): string {
  return code(readFileSync(path, "utf8"));
}

/** Every SQL `UPDATE "table" SET ... WHERE` in a source, by table. */
function updates(text: string): { table: string; set: string }[] {
  return [...text.matchAll(/UPDATE\s+"([a-z_]+)"\s+SET([\s\S]*?)\bWHERE\b/g)].map((m) => ({
    table: m[1] ?? "",
    set: m[2] ?? "",
  }));
}

describe("the failure settlement writes a release and nothing else that moves money", () => {
  const text = source(SETTLEMENT_MODULE);

  it("updates exactly the job and the reservation, once each, and inserts or deletes nothing", () => {
    expect(updates(text).map((u) => u.table)).toEqual(["generation_reservations", "generation_jobs"]);
    for (const banned of ["INSERT", "DELETE", "tx.generationReservation.", "tx.generationJob."]) {
      expect(`${banned}: ${text.includes(banned)}`).toBe(`${banned}: false`);
    }
  });

  it("moves the reservation only to RELEASED, with its instant", () => {
    const reservation = updates(text).find((u) => u.table === "generation_reservations");
    const columns = [...(reservation?.set ?? "").matchAll(/"([A-Za-z]+)"\s*=/g)].map((m) => m[1]);
    expect(columns).toEqual(["state", "stateVersion", "releasedAt", "updatedAt"]);
    expect(reservation?.set).toContain(`"state" = 'RELEASED'::"GenerationReservationState"`);
  });

  it("never consumes a Unit or writes the deliverable pointer", () => {
    for (const banned of ["CONSUMED", "consumedAt", `"currentDeliverableVersionId"`]) {
      expect(`${banned}: ${text.includes(banned)}`).toBe(`${banned}: false`);
    }
  });

  it("writes only the job state the domain's decision chose", () => {
    // No job state is named here: the target is `settleFailedDeliverable`'s
    // answer, FAILED_TERMINAL for an initial generation and DELIVERABLE_READY
    // for a replacement (`settlement.test.ts` holds the whole table).
    const job = updates(text).find((u) => u.table === "generation_jobs");
    const columns = [...(job?.set ?? "").matchAll(/"([A-Za-z]+)"\s*=/g)].map((m) => m[1]);
    expect(columns).toEqual(["state", "stateVersion", "updatedAt"]);
    for (const banned of ["FAILED_TERMINAL", "DELIVERABLE_READY", "CANCELLED"]) {
      expect(`${banned}: ${text.includes(banned)}`).toBe(`${banned}: false`);
    }
    expect(text.match(/settleFailedDeliverable\(/g)).toHaveLength(1);
    expect(text).toContain("await moveJob(tx, cycle.jobId, cycle.failedIn, settlement.jobState);");
  });

  it("takes the cost-admission lock before it locks the reservation", () => {
    const lock = text.indexOf("acquireCostAdmissionLock(");
    const reservation = text.indexOf("FOR UPDATE OF res");
    expect(lock).toBeGreaterThan(-1);
    expect(reservation).toBeGreaterThan(lock);
    expect(text.match(/FOR UPDATE/g)).toHaveLength(1);
  });
});

describe("the failure settlement is the only release in either deliverable writer", () => {
  it.each([
    ["deliverable-composition-execution-repository.ts"],
    ["deliverable-validation-repository.ts"],
  ])("%s releases nothing itself and settles in one place", (file) => {
    const text = source(join(DATABASE_SRC, file));
    for (const banned of ["RELEASED", "releasedAt", "FAILED_TERMINAL"]) {
      expect(`${banned}: ${text.includes(banned)}`).toBe(`${banned}: false`);
    }
    expect(text.match(/settleDeliverableFailure\(/g)).toHaveLength(1);
    expect(text.match(/lockReservationForDeliverable\(/g)).toHaveLength(1);
  });
});
