import { describe, expect, it } from "vitest";
import type { EligibleInput } from "./eligibility";
import { computeCompositionFingerprint } from "./fingerprint";

function input(assetId: string, analysisRevision = 1): EligibleInput {
  return { assetId, analysisRevision, roomType: "KITCHEN", suggestedOrder: 1 };
}

const BASE = [input("ast_a"), input("ast_b"), input("ast_c")];

describe("representation", () => {
  it("returns the documented sha256:<hex> form", () => {
    expect(computeCompositionFingerprint(BASE)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("is defined for an empty input set, and distinct from any non-empty one", () => {
    const empty = computeCompositionFingerprint([]);
    expect(empty).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(empty).not.toBe(computeCompositionFingerprint([input("ast_a")]));
  });
});

describe("what must change the fingerprint", () => {
  it("changes when an eligible approved asset is added", () => {
    expect(computeCompositionFingerprint([...BASE, input("ast_d")])).not.toBe(
      computeCompositionFingerprint(BASE),
    );
  });

  it("changes when an eligible approved asset disappears", () => {
    expect(computeCompositionFingerprint(BASE.slice(0, 2))).not.toBe(
      computeCompositionFingerprint(BASE),
    );
  });

  it("changes when an eligible asset's analysisRevision changes", () => {
    const refreshed = [input("ast_a"), input("ast_b", 2), input("ast_c")];
    expect(computeCompositionFingerprint(refreshed)).not.toBe(
      computeCompositionFingerprint(BASE),
    );
  });

  it("changes when one asset is swapped for another at the same revision", () => {
    const swapped = [input("ast_a"), input("ast_b"), input("ast_z")];
    expect(computeCompositionFingerprint(swapped)).not.toBe(computeCompositionFingerprint(BASE));
  });
});

describe("what must not change the fingerprint", () => {
  it("is unaffected by the order the inputs arrive in", () => {
    const shuffled = [input("ast_c"), input("ast_a"), input("ast_b")];
    expect(computeCompositionFingerprint(shuffled)).toBe(computeCompositionFingerprint(BASE));
  });

  it("ignores room type and suggested order — it identifies the input set only", () => {
    // Ordering and duration are storyboard decisions, not input identity:
    // reordering a storyboard does not make it stale.
    const relabelled: EligibleInput[] = BASE.map((i) => ({
      ...i,
      roomType: "BALCONY",
      suggestedOrder: 99,
    }));
    expect(computeCompositionFingerprint(relabelled)).toBe(computeCompositionFingerprint(BASE));
  });
});

describe("encoding is unambiguous", () => {
  it("distinguishes sets that a delimiter-joined encoding could collide", () => {
    // "a|1" + "b|2" vs "a" + "1|b" + "2" — identical under naive concatenation,
    // distinct under a canonical tuple structure.
    const left = [input("ast|a", 1), input("ast|b", 2)];
    const right = [input("ast", 1), input("a|ast|b", 2)];
    expect(computeCompositionFingerprint(left)).not.toBe(computeCompositionFingerprint(right));
  });

  it("distinguishes ids differing only by characters JSON escapes", () => {
    const plain = [input('ast_"a"')];
    const escaped = [input("ast_\\a\\")];
    expect(computeCompositionFingerprint(plain)).not.toBe(
      computeCompositionFingerprint(escaped),
    );
  });

  it("distinguishes a revision digit from an id digit", () => {
    // ("ast_a1", 2) must not hash like ("ast_a", 12).
    expect(computeCompositionFingerprint([input("ast_a1", 2)])).not.toBe(
      computeCompositionFingerprint([input("ast_a", 12)]),
    );
  });

  it("is stable across calls with equal but distinct objects", () => {
    const first = computeCompositionFingerprint([input("ast_a", 4)]);
    const second = computeCompositionFingerprint([input("ast_a", 4)]);
    expect(first).toBe(second);
  });
});
