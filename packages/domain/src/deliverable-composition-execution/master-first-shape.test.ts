import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { COMPOSITION_BLOCK_CODES } from "./durable";
import { COMPOSITION_PROFILE_KEY } from "./profile";

/**
 * What DS-5b-2b-1 may and may not have changed (ADR-0078). It adds no migration:
 * DS-5b-2a's shape test still pins migration 31 as the newest.
 *
 * 1. **Profile v2** is the one profile this build runs.
 * 2. **No video without its disclosure**: the runner never calls the composer's
 *    one-pass `compose`, only `composeCleanMaster` and `applyDisclosure`.
 * 3. **The master before the video**: the master's key is read before a scene
 *    is fetched, stored after it is encoded, and inspected before the
 *    disclosure is laid over a copy of the stored bytes.
 * 4. **Every finalize records a master**, so the runner never passes `null`.
 * 5. **A missing master is a defect, not a block code**: no durable value was
 *    added for it.
 *
 * The ordering claims are behaviour tests in `runner.test.ts` too; these pin
 * the source so a refactor cannot reach a path the fakes never exercise.
 */

function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

const runner = code(readFileSync(join(__dirname, "runner.ts"), "utf8"));

/** Where `needle` first occurs in the runner, which it must, exactly once. */
function once(needle: string): number {
  expect(`${needle}: ${runner.split(needle).length - 1}`).toBe(`${needle}: 1`);
  return runner.indexOf(needle);
}

describe("DS-5b-2b-1 shape", () => {
  it("runs profile v2", () => {
    expect(COMPOSITION_PROFILE_KEY).toBe("vtavision-compose:v2");
  });

  it("never makes the customer's video without its disclosure", () => {
    expect(runner.includes(".compose(")).toBe(false);
    once("composer.composeCleanMaster(");
    once("composer.applyDisclosure(");
    // Laid over the stored master's copy, never over the encoder's own output.
    expect(runner).toContain("cleanMasterPath: copy.cleanMasterPath,");
    expect(runner).toContain("disclosureMode: claim.disclosureMode,");
  });

  it("reads the master's key before a scene, and stores the master before the video", () => {
    const fetch = once("cleanMasterStore.fetch(");
    const materialize = once("materializer.materialize(");
    const encode = once("composer.composeCleanMaster(");
    const store = once("cleanMasterStore.publish(");
    const inspect = once("cleanMasterInspector.inspect(");
    const matches = once("cleanMasterMatchesProfile(");
    const disclose = once("composer.applyDisclosure(");
    const publish = once("publisher.publish(");
    // `#makeMaster` sits after `#masterInHand` and before `#deliverFrom`.
    expect(fetch).toBeLessThan(materialize);
    expect(materialize).toBeLessThan(encode);
    expect(encode).toBeLessThan(store);
    expect(store).toBeLessThan(inspect);
    expect(inspect).toBeLessThan(matches);
    expect(matches).toBeLessThan(disclose);
    expect(disclose).toBeLessThan(publish);
  });

  it("records a master on every finalize", () => {
    expect(runner.includes("cleanMaster: null")).toBe(false);
    expect(runner.match(/cleanMaster\b[^\n]*/g)).toEqual([
      "cleanMaster: CleanMasterReceipt,",
      "cleanMaster,",
    ]);
  });

  it("adds no durable code for a missing master", () => {
    expect(COMPOSITION_BLOCK_CODES as readonly string[]).not.toContain("CLEAN_MASTER_MISSING");
    // Thrown in one place: the probe of a stored video's master finding none.
    const thrown = once(`throw new DeliverableCompositionExecutionDefect("CLEAN_MASTER_MISSING");`);
    const absent = runner.lastIndexOf(`case "ABSENT":`, thrown);
    expect(absent).toBeGreaterThan(once("cleanMasterStore.probe("));
    expect(runner.slice(absent + `case "ABSENT":`.length, thrown).includes("case ")).toBe(false);
    const schema = readFileSync(
      join(__dirname, "..", "..", "..", "database", "prisma", "schema.prisma"),
      "utf8",
    );
    expect(schema.includes("CLEAN_MASTER_MISSING")).toBe(false);
  });
});
