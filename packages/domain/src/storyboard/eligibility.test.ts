import { describe, expect, it } from "vitest";
import { AppError } from "@app/shared";
import type { AssetAnalysis } from "../analysis/types";
import { selectEligibleAnalyses } from "./eligibility";

const NOW = new Date("2026-08-03T00:00:00.000Z");

function analysis(assetId: string, overrides: Partial<AssetAnalysis> = {}): AssetAnalysis {
  return {
    id: `ana_${assetId}`,
    organizationId: "org_1",
    assetId,
    provider: "deterministic",
    status: "SUCCEEDED",
    roomType: "KITCHEN",
    confidence: 0.9,
    qualityScore: 0.8,
    brightnessScore: 0.5,
    blurScore: 0.1,
    duplicateGroup: null,
    detectedObjects: [],
    safetyFlags: [],
    suggestedOrder: 1,
    failureReason: null,
    analysisRevision: 1,
    reviewStatus: "APPROVED",
    reviewNote: null,
    reviewedBy: "usr_reviewer",
    reviewedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe("approval is the whole filter", () => {
  it("admits only succeeded, approved analyses", () => {
    const eligible = selectEligibleAnalyses([
      analysis("a"),
      analysis("b", { reviewStatus: "UNREVIEWED", reviewedBy: null, reviewedAt: null }),
      analysis("c", { reviewStatus: "REJECTED", reviewNote: "too blurry" }),
      analysis("d", { status: "PENDING", reviewStatus: "UNREVIEWED" }),
      analysis("e", { status: "FAILED", failureReason: "provider timeout" }),
    ]);
    expect(eligible.map((i) => i.assetId)).toEqual(["a"]);
  });

  it("never admits an unapproved analysis to make up the numbers", () => {
    // Two approved and three not: the result is two, not a padded three.
    const eligible = selectEligibleAnalyses([
      analysis("a"),
      analysis("b"),
      analysis("c", { reviewStatus: "UNREVIEWED" }),
      analysis("d", { reviewStatus: "REJECTED" }),
      analysis("e", { reviewStatus: "UNREVIEWED" }),
    ]);
    expect(eligible.map((i) => i.assetId)).toEqual(["a", "b"]);
  });

  it("does not admit a SUCCEEDED-but-unapproved analysis even with a duplicate group", () => {
    const eligible = selectEligibleAnalyses([
      analysis("a", { duplicateGroup: "dup_1" }),
      analysis("b", { duplicateGroup: "dup_1", reviewStatus: "UNREVIEWED" }),
    ]);
    expect(eligible.map((i) => i.assetId)).toEqual(["a"]);
  });
});

describe("no minimum is enforced here", () => {
  it("returns an empty set rather than failing", () => {
    expect(selectEligibleAnalyses([])).toEqual([]);
    expect(selectEligibleAnalyses([analysis("a", { reviewStatus: "REJECTED" })])).toEqual([]);
  });

  it("returns one and two eligible analyses unchanged", () => {
    // The minimum-three rule belongs to composition (Phase 3C-2b); selection
    // must not pre-empt it.
    expect(selectEligibleAnalyses([analysis("a")])).toHaveLength(1);
    expect(selectEligibleAnalyses([analysis("a"), analysis("b")])).toHaveLength(2);
  });
});

describe("duplicate-group invariant", () => {
  it("rejects two approved analyses sharing one duplicate group", () => {
    // The partial unique index makes this state impossible in the database, so
    // reaching it means a guarantee has been violated. Picking a winner here
    // would hide that.
    const call = () =>
      selectEligibleAnalyses([
        analysis("a", { duplicateGroup: "dup_1" }),
        analysis("b", { duplicateGroup: "dup_1" }),
      ]);
    expect(call).toThrow(AppError);
    expect(call).toThrow(/duplicate group/i);
  });

  it("accepts one approved member per group across several groups", () => {
    const eligible = selectEligibleAnalyses([
      analysis("a", { duplicateGroup: "dup_1" }),
      analysis("b", { duplicateGroup: "dup_2" }),
    ]);
    expect(eligible.map((i) => i.assetId)).toEqual(["a", "b"]);
  });

  it("accepts many approved analyses with no duplicate group", () => {
    const eligible = selectEligibleAnalyses([
      analysis("a"),
      analysis("b"),
      analysis("c"),
    ]);
    expect(eligible).toHaveLength(3);
  });

  it("ignores duplicate-group collisions among unapproved analyses", () => {
    const eligible = selectEligibleAnalyses([
      analysis("a", { duplicateGroup: "dup_1" }),
      analysis("b", { duplicateGroup: "dup_1", reviewStatus: "REJECTED" }),
      analysis("c", { duplicateGroup: "dup_1", reviewStatus: "UNREVIEWED" }),
    ]);
    expect(eligible.map((i) => i.assetId)).toEqual(["a"]);
  });
});

describe("projection and ordering", () => {
  it("sorts by assetId regardless of input order", () => {
    const inOrder = selectEligibleAnalyses([analysis("a"), analysis("b"), analysis("c")]);
    const shuffled = selectEligibleAnalyses([analysis("c"), analysis("a"), analysis("b")]);
    expect(shuffled).toEqual(inOrder);
    expect(inOrder.map((i) => i.assetId)).toEqual(["a", "b", "c"]);
  });

  it("projects exactly the four facts composition may depend on", () => {
    const [input] = selectEligibleAnalyses([
      analysis("a", { analysisRevision: 3, roomType: "BALCONY", suggestedOrder: 7 }),
    ]);
    expect(input).toEqual({
      assetId: "a",
      analysisRevision: 3,
      roomType: "BALCONY",
      suggestedOrder: 7,
    });
  });

  it("carries a null room type and null suggested order through", () => {
    const [input] = selectEligibleAnalyses([
      analysis("a", { roomType: null, suggestedOrder: null }),
    ]);
    expect(input!.roomType).toBeNull();
    expect(input!.suggestedOrder).toBeNull();
  });
});
