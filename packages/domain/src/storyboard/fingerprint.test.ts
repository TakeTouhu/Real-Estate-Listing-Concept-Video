import { describe, expect, it } from "vitest";
import type { EligibleInput } from "./eligibility";
import { computeCompositionFingerprint } from "./fingerprint";

function input(
  assetId: string,
  analysisRevision = 1,
  overrides: Partial<EligibleInput> = {},
): EligibleInput {
  return {
    assetId,
    analysisRevision,
    roomType: "KITCHEN",
    orderOverride: null,
    suggestedOrder: 1,
    ...overrides,
  };
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

  it("ignores suggestedOrder — analyzer output nobody can correct", () => {
    // `suggestedOrder` is derived from the analyzer's own room type and cannot
    // move without `roomType` or `analysisRevision` moving too, so it adds no
    // information the digest does not already carry.
    //
    // Room type used to be listed here as well. Since Phase 3D-3 it is the
    // *effective* room and a reviewer can change it without any other field
    // moving, so it now participates — see "correction sensitivity" below and
    // ADR-0015.
    const rescored: EligibleInput[] = BASE.map((i) => ({ ...i, suggestedOrder: 99 }));
    expect(computeCompositionFingerprint(rescored)).toBe(computeCompositionFingerprint(BASE));
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

describe("correction sensitivity", () => {
  // A correction never advances `analysisRevision` — that identifies an
  // analysis *result*, and a human edit is not one. So the digest has to carry
  // the corrected values itself, or a changed correction would go unnoticed.
  const SAME_ASSET = "ast_a";
  const SAME_REVISION = 7;

  it("changes when the effective room type changes, with asset and revision fixed", () => {
    const kitchen = [input(SAME_ASSET, SAME_REVISION, { roomType: "KITCHEN" })];
    const living = [input(SAME_ASSET, SAME_REVISION, { roomType: "LIVING_ROOM" })];

    expect(computeCompositionFingerprint(kitchen)).not.toBe(
      computeCompositionFingerprint(living),
    );
  });

  it("changes when an effective room becomes null, or stops being null", () => {
    const classified = [input(SAME_ASSET, SAME_REVISION, { roomType: "KITCHEN" })];
    const unclassified = [input(SAME_ASSET, SAME_REVISION, { roomType: null })];

    expect(computeCompositionFingerprint(classified)).not.toBe(
      computeCompositionFingerprint(unclassified),
    );
  });

  it("changes when the order priority changes, with asset and revision fixed", () => {
    const two = [input(SAME_ASSET, SAME_REVISION, { orderOverride: 2 })];
    const five = [input(SAME_ASSET, SAME_REVISION, { orderOverride: 5 })];

    expect(computeCompositionFingerprint(two)).not.toBe(computeCompositionFingerprint(five));
  });

  it("distinguishes no priority from a stated one", () => {
    const none = [input(SAME_ASSET, SAME_REVISION, { orderOverride: null })];
    const stated = [input(SAME_ASSET, SAME_REVISION, { orderOverride: 1 })];

    // Setting a priority and clearing it are both real changes to what would
    // be generated.
    expect(computeCompositionFingerprint(none)).not.toBe(computeCompositionFingerprint(stated));
  });

  it("is stable when the correction-sensitive values are identical", () => {
    const build = () => [
      input("ast_a", 3, { roomType: "BALCONY", orderOverride: 4 }),
      input("ast_b", 1, { roomType: "STUDY", orderOverride: null }),
    ];
    expect(computeCompositionFingerprint(build())).toBe(computeCompositionFingerprint(build()));
  });

  it("ignores the order the corrected inputs arrive in", () => {
    const a = input("ast_a", 3, { roomType: "BALCONY", orderOverride: 4 });
    const b = input("ast_b", 1, { roomType: "STUDY", orderOverride: 2 });
    const c = input("ast_c", 2, { roomType: null, orderOverride: null });

    expect(computeCompositionFingerprint([a, b, c])).toBe(
      computeCompositionFingerprint([c, a, b]),
    );
  });

  it("still returns the documented sha256:<hex> form for corrected inputs", () => {
    const corrected = [input("ast_a", 1, { roomType: "STUDY", orderOverride: 12 })];
    expect(computeCompositionFingerprint(corrected)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
