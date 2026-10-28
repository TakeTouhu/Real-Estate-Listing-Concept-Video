import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as database from "@app/database";

/**
 * What `@app/database` publishes, and what it deliberately does not.
 *
 * `admitAttemptWithin` and `armProviderBoundaryWithin` are within-transaction
 * helpers: each assumes a lock its caller already took and would be unsafe
 * called on its own. `armProviderBoundaryWithin` predates this rule and is
 * exported at the root; that is not re-litigated here. The new one is not, and
 * this file is what keeps it that way — the package index lists its exports
 * explicitly rather than re-exporting a module wholesale, so a helper added to
 * `orchestration-repositories.ts` tomorrow is private until someone chooses to
 * publish it.
 */

const REPO_ROOT = join(__dirname, "..");
const DATABASE_SRC = join(REPO_ROOT, "packages", "database", "src");

/** Every production source file in the repository, comments stripped. */
function productionSources(): { name: string; text: string }[] {
  const found: { name: string; text: string }[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".next") {
          continue;
        }
        walk(full);
      } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
        if (entry.name.includes(".test.")) continue;
        found.push({
          name: full.slice(REPO_ROOT.length + 1),
          text: readFileSync(full, "utf8")
            .replace(/\/\*[\s\S]*?\*\//g, " ")
            .replace(/\/\/[^\n]*/g, " "),
        });
      }
    }
  };
  for (const dir of [
    join(REPO_ROOT, "apps", "web", "src"),
    join(REPO_ROOT, "apps", "worker", "src"),
    join(REPO_ROOT, "packages"),
  ]) {
    walk(dir);
  }
  return found;
}

describe("the database package's public surface", () => {
  it("does not export the within-transaction admission helper", () => {
    expect(Object.keys(database)).not.toContain("admitAttemptWithin");
    expect("admitAttemptWithin" in database).toBe(false);
  });

  it("still exports everything it exported before", () => {
    for (const name of [
      "appendGenerationEvent",
      "armProviderBoundaryWithin",
      "createGenerationJobRepository",
      "createGenerationPricingSnapshotRepository",
      "createGenerationReservationRepository",
      "createGenerationSceneRepository",
      "createGenerationTransitionEventRepository",
      "createSceneGenerationAttemptRepository",
      "createSceneGenerationRequestRepository",
      "createPaidSubmissionAuthorizationRepository",
      "createSubmissionOutcomeRepository",
      "createReconciliationRepository",
      "createCompletionRepository",
      "createProviderPollingContextReader",
      "createMediaValidationLifecycleRepository",
      "createValidatedSceneDeliveryRepository",
      "createAutomaticMediaRecoveryRepository",
      "getPrismaClient",
      // Added by Phase 4C-3B-2H-3B-6C.
      "createMediaFailureResolutionRepository",
      // Added by GS-4b (ADR-0087).
      "createGenerationStartRepository",
      // Added by GS-7b (ADR-0095).
      "createJobLaunchRepository",
    ]) {
      expect(`${name}: ${name in database}`).toBe(`${name}: true`);
    }
  });

  it("does not export the cost-admission lock", () => {
    // Holding it outside the package means holding it without the transaction
    // that gives it meaning, and one key formula is worth nothing if it can be
    // taken from somewhere this package cannot see.
    expect(Object.keys(database)).not.toContain("acquireCostAdmissionLock");
    expect("acquireCostAdmissionLock" in database).toBe(false);
    expect("costAdmissionLockKeys" in database).toBe(false);
  });

  it("keeps the cost-admission lock key formula in exactly one module", () => {
    const holders = productionSources()
      .filter(({ text }) => text.includes("pg_advisory_xact_lock"))
      .map(({ name }) => name)
      .sort();
    expect(holders).toEqual(["packages/database/src/cost-admission-lock.ts"]);
  });

  it("lists its orchestration exports explicitly rather than re-exporting the module", () => {
    const index = readFileSync(join(DATABASE_SRC, "index.ts"), "utf8");
    expect(index).not.toContain('export * from "./orchestration-repositories"');
  });

  it("bounds the helper's production call sites to the intended users", () => {
    // GS-7b (ADR-0095): the launch commit admits each scene's first attempt
    // under the request locks it took itself.
    const callers = productionSources()
      .filter(({ text }) => text.includes("admitAttemptWithin"))
      .map(({ name }) => name)
      .sort();
    expect(callers).toEqual([
      "packages/database/src/job-launch-repository.ts",
      "packages/database/src/media-recovery-repository.ts",
      "packages/database/src/orchestration-repositories.ts",
    ]);
  });

  it("does not export the locked transition or the launch lock", () => {
    // Each writes or locks on the assumption that its caller holds what makes
    // it safe; published, either would be reachable without that.
    expect("applyLockedTransition" in database).toBe(false);
    expect("acquireJobLaunchLock" in database).toBe(false);
    const callers = productionSources()
      .filter(({ text }) => text.includes("applyLockedTransition("))
      .map(({ name }) => name)
      .sort();
    expect(callers).toEqual([
      "packages/database/src/job-launch-repository.ts",
      "packages/database/src/orchestration-repositories.ts",
    ]);
  });

  it("keeps Transaction B's body private to the module that runs it", () => {
    // GS-4b (ADR-0087): `reserveJobWithin` runs Transaction B inside a
    // transaction its caller opened. Both of its callers live beside it; one
    // outside would be reserving Units with no idea which locks it already holds.
    expect("reserveJobWithin" in database).toBe(false);
    const callers = productionSources()
      .filter(({ text }) => text.includes("reserveJobWithin"))
      .map(({ name }) => name)
      .sort();
    expect(callers).toEqual(["packages/database/src/orchestration-repositories.ts"]);
    const repo = readFileSync(join(DATABASE_SRC, "orchestration-repositories.ts"), "utf8");
    expect(repo).toContain("\nasync function reserveJobWithin(");
    expect(repo).not.toContain("export async function reserveJobWithin(");
  });
});
