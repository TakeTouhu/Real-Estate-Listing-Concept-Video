import { describe, expect, it } from "vitest";
import { effectiveRoomType, isCorrected } from "./effective";
import type { AssetAnalysis } from "./types";

const NOW = new Date("2026-08-04T00:00:00.000Z");

function analysis(overrides: Partial<AssetAnalysis> = {}): AssetAnalysis {
  return {
    id: "ana_1",
    organizationId: "org_1",
    assetId: "ast_1",
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
    suggestedOrder: 5,
    failureReason: null,
    roomTypeOverride: null,
    orderOverride: null,
    correctedBy: null,
    correctedAt: null,
    analysisRevision: 1,
    reviewStatus: "UNREVIEWED",
    reviewNote: null,
    reviewedBy: null,
    reviewedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe("effectiveRoomType", () => {
  it("is the analyzer's classification when nothing has been corrected", () => {
    expect(effectiveRoomType(analysis())).toBe("KITCHEN");
  });

  it("is the reviewer's correction when one exists", () => {
    expect(effectiveRoomType(analysis({ roomTypeOverride: "LIVING_ROOM" }))).toBe("LIVING_ROOM");
  });

  it("returns to the analyzer's classification when the correction is cleared", () => {
    const corrected = analysis({ roomTypeOverride: "LIVING_ROOM" });
    const cleared = { ...corrected, roomTypeOverride: null };
    expect(effectiveRoomType(corrected)).toBe("LIVING_ROOM");
    expect(effectiveRoomType(cleared)).toBe("KITCHEN");
  });

  it("never mutates the analyzer's own field", () => {
    const corrected = analysis({ roomTypeOverride: "BALCONY" });
    expect(effectiveRoomType(corrected)).toBe("BALCONY");
    // The model's answer stays recoverable — that is the whole point of storing
    // the correction beside it rather than over it.
    expect(corrected.roomType).toBe("KITCHEN");
  });

  it("lets a reviewer correct an analysis the analyzer could not classify", () => {
    expect(effectiveRoomType(analysis({ roomType: null }))).toBeNull();
    expect(effectiveRoomType(analysis({ roomType: null, roomTypeOverride: "STUDY" }))).toBe(
      "STUDY",
    );
  });

  it("does not treat a correction that agrees with the analyzer as a special case", () => {
    expect(effectiveRoomType(analysis({ roomTypeOverride: "KITCHEN" }))).toBe("KITCHEN");
  });
});

describe("isCorrected", () => {
  it("is false for an untouched analysis", () => {
    expect(isCorrected(analysis())).toBe(false);
  });

  it("is true when either override is set", () => {
    expect(isCorrected(analysis({ roomTypeOverride: "STUDY" }))).toBe(true);
    expect(isCorrected(analysis({ orderOverride: 1 }))).toBe(true);
    expect(isCorrected(analysis({ roomTypeOverride: "STUDY", orderOverride: 1 }))).toBe(true);
  });

  it("reads the overrides, not the actor, so cleared corrections read as uncorrected", () => {
    // A row corrected and then cleared within one revision keeps correctedBy —
    // it is provenance — but is no longer carrying a correction.
    const cleared = analysis({
      roomTypeOverride: null,
      orderOverride: null,
      correctedBy: "usr_reviewer",
      correctedAt: NOW,
    });
    expect(isCorrected(cleared)).toBe(false);
  });

  it("counts an order priority of zero as a correction", () => {
    // Whether zero is a *valid* priority is the correction service's rule
    // (Phase 3D-2). This module must not silently treat it as absent.
    expect(isCorrected(analysis({ orderOverride: 0 }))).toBe(true);
  });
});
