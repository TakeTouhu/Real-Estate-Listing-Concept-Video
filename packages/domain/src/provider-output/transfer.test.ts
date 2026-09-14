import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isWellFormedTransferOutcome, parseManagedOutputTransferOutcome } from "./transfer";

/**
 * What a transfer port may conclude.
 *
 * Only the top level is checked. The receipt travels onward as `unknown` and
 * Phase 2H-1 decides whether its digest and byte count are real — a second
 * validator here would be a second set of rules for one contract, and two sets
 * of rules for one contract drift.
 */

const RECEIPT = { sha256: "a".repeat(64), sizeBytes: 4_194_304 };

describe("the two things a transfer may conclude", () => {
  it("accepts VERIFIED with a receipt", () => {
    expect(isWellFormedTransferOutcome({ kind: "VERIFIED", receipt: RECEIPT })).toBe(true);
  });

  it("accepts RETRYABLE_FAILURE", () => {
    expect(isWellFormedTransferOutcome({ kind: "RETRYABLE_FAILURE" })).toBe(true);
  });

  it("accepts a receipt of any shape, because judging it is not this boundary's job", () => {
    // Deliberate. A malformed receipt is refused by Phase 2H-1's finalization,
    // with its own closed answer; pre-judging it here would mean two boundaries
    // could disagree about what a valid receipt is.
    for (const receipt of [null, {}, { sha256: "nope" }, 42, "x", []]) {
      expect(isWellFormedTransferOutcome({ kind: "VERIFIED", receipt })).toBe(true);
    }
  });
});

describe("the validator treats its input as unknown, because it is", () => {
  it.each([
    ["null", null],
    ["undefined", undefined],
    ["a number", 1],
    ["a string", "VERIFIED"],
    ["a boolean", true],
    ["an array", []],
    ["an array carrying a valid arm's properties", Object.assign([], { kind: "RETRYABLE_FAILURE" })],
    ["an empty object", {}],
    ["an unknown kind", { kind: "TERMINAL_FAILURE" }],
    ["a lowercase kind", { kind: "verified", receipt: RECEIPT }],
    ["a null kind", { kind: null }],
  ])("refuses %s", (_label, value) => {
    expect(isWellFormedTransferOutcome(value)).toBe(false);
  });

  it("refuses VERIFIED with no receipt", () => {
    // An adapter that verified something must say what it verified. Absence is a
    // defect in the adapter, not a receipt of unknown shape.
    expect(isWellFormedTransferOutcome({ kind: "VERIFIED" })).toBe(false);
  });

  it("never throws on hostile input", () => {
    for (const hostile of [null, undefined, 1, "x", [], {}, { kind: {} }]) {
      expect(() => isWellFormedTransferOutcome(hostile)).not.toThrow();
    }
  });
});

describe("no arm may carry storage or provider text", () => {
  it.each([
    ["a provider output URL", "providerOutputUrl"],
    ["a signed URL", "signedUrl"],
    ["a raw response", "rawResponse"],
    ["a storage diagnostic", "storageError"],
    ["an error message", "message"],
    ["a bucket name", "bucket"],
    ["an unremarkable unknown field", "note"],
  ])("refuses VERIFIED carrying %s", (_label, extra) => {
    expect(
      isWellFormedTransferOutcome({
        kind: "VERIFIED",
        receipt: RECEIPT,
        [extra]: "https://provider.example/o?sig=SECRET",
      }),
    ).toBe(false);
  });

  it.each([
    ["an error message", "message"],
    ["a cause", "cause"],
    ["a URL", "url"],
    ["a retry-after hint", "retryAfterMs"],
    ["a storage diagnostic", "storageError"],
    ["an unremarkable unknown field", "note"],
  ])("refuses RETRYABLE_FAILURE carrying %s", (_label, extra) => {
    // The moment a field exists to carry an adapter's error text, something logs
    // it — and a storage adapter's error text is where a signed URL lives.
    expect(isWellFormedTransferOutcome({ kind: "RETRYABLE_FAILURE", [extra]: "boom" })).toBe(
      false,
    );
  });

  it("is not fooled by a field hidden from enumeration", () => {
    const smuggled: Record<string, unknown> = { kind: "RETRYABLE_FAILURE" };
    Object.defineProperty(smuggled, "signedUrl", { value: "https://x", enumerable: false });
    expect(isWellFormedTransferOutcome(smuggled)).toBe(false);
  });
});

describe("the transfer outcome is read once, under a guard, into a fresh object", () => {
  it("materializes VERIFIED as a fresh two-key object carrying the receipt reference", () => {
    const receipt = { sha256: "a".repeat(64), sizeBytes: 1 };
    const input = { kind: "VERIFIED" as const, receipt };
    const parsed = parseManagedOutputTransferOutcome(input);
    expect(parsed).toEqual({ kind: "VERIFIED", receipt });
    expect(parsed).not.toBe(input);
    // The receipt itself is carried through by reference, untouched: its
    // contents are Phase 2H-1's question.
    expect((parsed as { receipt: unknown }).receipt).toBe(receipt);
    expect(Object.getOwnPropertyNames(parsed)).toEqual(["kind", "receipt"]);
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
  });

  it("materializes RETRYABLE_FAILURE as a fresh one-key object", () => {
    const input = { kind: "RETRYABLE_FAILURE" as const };
    const parsed = parseManagedOutputTransferOutcome(input);
    expect(parsed).toEqual({ kind: "RETRYABLE_FAILURE" });
    expect(parsed).not.toBe(input);
    expect(Object.getOwnPropertyNames(parsed)).toEqual(["kind"]);
  });

  it.each([
    ["a throwing kind getter", { get kind(): never { throw new Error("SECRET"); }, receipt: {} }],
    [
      "a throwing receipt getter on VERIFIED",
      { kind: "VERIFIED", get receipt(): never { throw new Error("SECRET"); } },
    ],
  ])("returns null, rather than throwing, for %s", (_label, hostile) => {
    expect(() => parseManagedOutputTransferOutcome(hostile)).not.toThrow();
    expect(parseManagedOutputTransferOutcome(hostile)).toBeNull();
    expect(() => isWellFormedTransferOutcome(hostile)).not.toThrow();
    expect(isWellFormedTransferOutcome(hostile)).toBe(false);
  });

  it("returns null when own-key enumeration itself throws", () => {
    const trapped = new Proxy(
      { kind: "VERIFIED", receipt: {} },
      {
        ownKeys() {
          throw new Error("SECRET");
        },
      },
    );
    expect(() => parseManagedOutputTransferOutcome(trapped)).not.toThrow();
    expect(parseManagedOutputTransferOutcome(trapped)).toBeNull();
  });

  it("reads kind exactly once, so a getter that answers once and then throws cannot pass and later explode", () => {
    let reads = 0;
    const stateful = {
      get kind(): string {
        reads += 1;
        if (reads > 1) throw new Error("SECOND-READ");
        return "VERIFIED";
      },
      receipt: { sha256: "b".repeat(64), sizeBytes: 2 },
    };
    const parsed = parseManagedOutputTransferOutcome(stateful);
    expect(parsed).toEqual({ kind: "VERIFIED", receipt: stateful.receipt });
    expect(reads).toBe(1);
  });

  it("reads the receipt exactly once and holds that value", () => {
    let reads = 0;
    const receipt = { sha256: "c".repeat(64), sizeBytes: 3 };
    const stateful = {
      kind: "VERIFIED",
      get receipt(): unknown {
        reads += 1;
        if (reads > 1) throw new Error("SECOND-READ");
        return receipt;
      },
    };
    const parsed = parseManagedOutputTransferOutcome(stateful);
    expect((parsed as { receipt: unknown }).receipt).toBe(receipt);
    expect(reads).toBe(1);
    // Re-reading the materialized copy never re-invokes the getter.
    void (parsed as { receipt: unknown }).receipt;
    expect(reads).toBe(1);
  });

  it("returns null, rather than throwing, for a revoked Proxy", () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    expect(() => parseManagedOutputTransferOutcome(proxy)).not.toThrow();
    expect(parseManagedOutputTransferOutcome(proxy)).toBeNull();
  });
});

describe("the contract itself names no transport", () => {
  it("declares a port, not an implementation", () => {
    const text = readFileSync(join(__dirname, "transfer.ts"), "utf8");
    for (const banned of [
      "fetch(",
      "axios",
      "S3Client",
      "PutObjectCommand",
      "@aws-sdk",
      "googleapis",
      "@google-cloud",
      "https://",
    ]) {
      expect(`${banned}: ${text.includes(banned)}`).toBe(`${banned}: false`);
    }
  });

  it("offers no terminal failure arm", () => {
    // Nothing here has evidence that a storage failure is permanent, and the arm
    // would invite an adapter to classify an outage as one — abandoning a paid,
    // still-retrievable render.
    expect(isWellFormedTransferOutcome({ kind: "TERMINAL_FAILURE" })).toBe(false);
    const text = readFileSync(join(__dirname, "transfer.ts"), "utf8");
    expect(text).not.toContain('"TERMINAL_FAILURE"');
  });
});
