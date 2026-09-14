import { describe, expect, it } from "vitest";
import { managedGenerationOutputKey, type ManagedGenerationOutputKey } from "./output";
import type { ManagedOutputTransferInput } from "../provider-output/transfer";

/**
 * The brand on `ManagedGenerationOutputKey`, proved at the type level.
 *
 * `@ts-expect-error` is the assertion: each marked line must fail to compile
 * for the test file to typecheck at all. If a future change widened the key
 * back to `string`, every marked line would become an *unused* directive and
 * `tsc` would refuse the file — so the property is enforced by `pnpm typecheck`
 * rather than by anything vitest runs. The runtime checks below are secondary.
 */

/** A sink-shaped parameter: the boundary a real writer exposes. */
function acceptDestination(_key: ManagedGenerationOutputKey): void {}

/** Where the transfer contract puts the key. */
function acceptTransferInput(_input: ManagedOutputTransferInput): void {}

describe("ManagedGenerationOutputKey provenance", () => {
  const key = managedGenerationOutputKey({ organizationId: "org_a", attemptId: "sgen_a" });

  it("is produced only by the application helper", () => {
    acceptDestination(key);

    // @ts-expect-error — an arbitrary string, however well-shaped, is not a key.
    acceptDestination("org/org_a/generations/sgen_a/output");

    // @ts-expect-error — a provider file name is exactly what the brand refuses.
    acceptDestination("panda/abc.mp4");

    expect(key).toBe("org/org_a/generations/sgen_a/output");
  });

  it("cannot be forged into the transfer contract without an explicit cast", () => {
    const source = {} as ManagedOutputTransferInput["source"];
    acceptTransferInput({ source, destinationKey: key });

    // @ts-expect-error — the transfer destination is the branded key, not a string.
    acceptTransferInput({ source, destinationKey: "org/org_b/generations/x/output" });

    // The escape hatch is visible and greppable. That is the intended shape:
    // unusual, explicit, and reviewable — never silent.
    acceptTransferInput({
      source,
      destinationKey: "org/org_b/generations/x/output" as ManagedGenerationOutputKey,
    });
  });

  it("remains an ordinary string wherever a string is required", () => {
    // The database column and any object-store call take a string; the brand
    // narrows in one direction only.
    const asString: string = key;
    expect(asString.split("/")).toEqual(["org", "org_a", "generations", "sgen_a", "output"]);
    expect(typeof key).toBe("string");
  });

  it("carries no extension and no format claim", () => {
    expect(key.endsWith("/output")).toBe(true);
    for (const ext of [".mp4", ".webm", ".bin", ".mov"]) {
      expect(key.endsWith(ext)).toBe(false);
    }
  });
});
