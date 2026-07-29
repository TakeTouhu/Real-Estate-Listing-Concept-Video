import { describe, expect, it } from "vitest";
import { analysisProviderError, clampScore, deriveQualityFlags, normalizeAnalysisResult } from "./normalization";
import { resolveDuplicateGroup, roomOrderRank } from "./rules";
import {
  LOW_CONFIDENCE_THRESHOLD,
  ROOM_TYPES,
  hasBlockingFlag,
  isLowConfidence,
  isRoomType,
  type AssetAnalysis,
} from "./types";

describe("room-type vocabulary", () => {
  it("covers the fifteen documented room types", () => {
    expect(ROOM_TYPES).toHaveLength(15);
    expect(ROOM_TYPES).toContain("LIVING_ROOM");
    expect(ROOM_TYPES).toContain("EXTERIOR");
    expect(ROOM_TYPES).toContain("OTHER");
  });

  it("guards unknown values", () => {
    expect(isRoomType("KITCHEN")).toBe(true);
    expect(isRoomType("SPACESHIP")).toBe(false);
    expect(isRoomType(undefined)).toBe(false);
  });
});

describe("score normalization", () => {
  it("clamps finite values into 0..1", () => {
    expect(clampScore(1.7)).toBe(1);
    expect(clampScore(-2)).toBe(0);
    expect(clampScore(0.42)).toBeCloseTo(0.42);
    expect(clampScore(0)).toBe(0);
    expect(clampScore(1)).toBe(1);
  });

  it("maps any non-finite value to 0, so malformed output cannot inflate a score", () => {
    expect(clampScore(Number.NaN)).toBe(0);
    expect(clampScore(Number.POSITIVE_INFINITY)).toBe(0);
    expect(clampScore(Number.NEGATIVE_INFINITY)).toBe(0);
  });

  it("maps an unknown room type to OTHER with zero confidence", () => {
    const r = normalizeAnalysisResult({ roomType: "SPACESHIP", confidence: 0.99 });
    expect(r.roomType).toBe("OTHER");
    expect(r.confidence).toBe(0);
  });

  it("keeps a known room type and clamps its confidence", () => {
    const r = normalizeAnalysisResult({ roomType: "KITCHEN", confidence: 2 });
    expect(r.roomType).toBe("KITCHEN");
    expect(r.confidence).toBe(1);
  });

  it("bounds detected objects and clamps their confidences", () => {
    const r = normalizeAnalysisResult({
      roomType: "KITCHEN",
      confidence: 0.5,
      detectedObjects: Array.from({ length: 80 }, () => ({ label: "x", confidence: 5 })),
    });
    expect(r.detectedObjects).toHaveLength(50);
    expect(r.detectedObjects[0]?.confidence).toBe(1);
  });

  it("bounds safety flags and tolerates missing collections", () => {
    const r = normalizeAnalysisResult({ roomType: "BEDROOM", confidence: 0.7 });
    expect(r.detectedObjects).toEqual([]);
    expect(r.safetyFlags).toEqual([]);
    const many = normalizeAnalysisResult({
      roomType: "BEDROOM",
      confidence: 0.7,
      safetyFlags: Array.from({ length: 40 }, () => ({
        code: "BLURRY",
        severity: "WARNING",
        message: "m",
      })),
    });
    expect(many.safetyFlags).toHaveLength(20);
  });
});

describe("derived quality flags", () => {
  it("derives resolution, blur, and exposure warnings", () => {
    const flags = deriveQualityFlags({
      width: 100,
      height: 100,
      blurScore: 0.8,
      brightnessScore: 0.95,
    });
    expect(flags.map((f) => f.code).sort()).toEqual([
      "BLURRY",
      "EXPOSURE_PROBLEM",
      "LOW_RESOLUTION",
    ]);
    expect(flags.every((f) => f.severity === "WARNING")).toBe(true);
  });

  it("derives nothing for a good image", () => {
    expect(
      deriveQualityFlags({ width: 1600, height: 1200, blurScore: 0.1, brightnessScore: 0.5 }),
    ).toEqual([]);
  });

  it("flags an under-exposed image", () => {
    const flags = deriveQualityFlags({
      width: 1600,
      height: 1200,
      blurScore: 0,
      brightnessScore: 0.1,
    });
    expect(flags.map((f) => f.code)).toEqual(["EXPOSURE_PROBLEM"]);
  });
});

describe("provider error normalization", () => {
  it("marks transient kinds retryable and input errors not", () => {
    expect(analysisProviderError({ kind: "RATE_LIMITED", code: "c", messageSanitized: "m" }).retryable).toBe(true);
    expect(analysisProviderError({ kind: "TIMEOUT", code: "c", messageSanitized: "m" }).retryable).toBe(true);
    expect(analysisProviderError({ kind: "PROVIDER", code: "c", messageSanitized: "m" }).retryable).toBe(true);
    expect(analysisProviderError({ kind: "INVALID_INPUT", code: "c", messageSanitized: "m" }).retryable).toBe(false);
    expect(analysisProviderError({ kind: "UNSUPPORTED", code: "c", messageSanitized: "m" }).retryable).toBe(false);
    expect(analysisProviderError({ kind: "UNKNOWN", code: "c", messageSanitized: "m" }).retryable).toBe(false);
  });

  it("honours an explicit retryable override", () => {
    expect(
      analysisProviderError({ kind: "UNKNOWN", code: "c", messageSanitized: "m", retryable: true })
        .retryable,
    ).toBe(true);
  });
});

describe("ordering rules", () => {
  it("ranks rooms in the documented sequence", () => {
    expect(roomOrderRank("EXTERIOR")).toBeLessThan(roomOrderRank("ENTRANCE"));
    expect(roomOrderRank("ENTRANCE")).toBeLessThan(roomOrderRank("HALLWAY"));
    expect(roomOrderRank("HALLWAY")).toBeLessThan(roomOrderRank("LIVING_ROOM"));
    expect(roomOrderRank("LIVING_ROOM")).toBeLessThan(roomOrderRank("DINING_ROOM"));
    expect(roomOrderRank("DINING_ROOM")).toBeLessThan(roomOrderRank("KITCHEN"));
    expect(roomOrderRank("KITCHEN")).toBeLessThan(roomOrderRank("BEDROOM"));
    expect(roomOrderRank("BEDROOM")).toBeLessThan(roomOrderRank("BATHROOM"));
    expect(roomOrderRank("BATHROOM")).toBeLessThan(roomOrderRank("STORAGE"));
    expect(roomOrderRank("STORAGE")).toBeLessThan(roomOrderRank("BALCONY"));
  });

  it("sorts an unknown or null room type last", () => {
    expect(roomOrderRank(null)).toBe(ROOM_TYPES.length);
  });
});

describe("duplicate grouping", () => {
  it("reuses an existing group for a near-duplicate hash", () => {
    expect(
      resolveDuplicateGroup("0f0f0f0f0f0f0f0f", "ast_2", [
        { assetId: "ast_1", perceptualHash: "0f0f0f0f0f0f0f0f", duplicateGroup: "dup_ast_1" },
      ]),
    ).toBe("dup_ast_1");
  });

  it("starts a new group when nothing is similar", () => {
    expect(
      resolveDuplicateGroup("ffffffffffffffff", "ast_2", [
        { assetId: "ast_1", perceptualHash: "0000000000000000", duplicateGroup: "dup_ast_1" },
      ]),
    ).toBe("dup_ast_2");
  });

  it("ignores itself, ungrouped candidates, and length mismatches", () => {
    expect(
      resolveDuplicateGroup("0f0f0f0f0f0f0f0f", "ast_1", [
        { assetId: "ast_1", perceptualHash: "0f0f0f0f0f0f0f0f", duplicateGroup: "dup_ast_1" },
        { assetId: "ast_2", perceptualHash: "0f0f0f0f0f0f0f0f", duplicateGroup: null },
        { assetId: "ast_3", perceptualHash: "0f0f", duplicateGroup: "dup_ast_3" },
      ]),
    ).toBe("dup_ast_1");
  });

  it("returns null without a hash to compare", () => {
    expect(resolveDuplicateGroup(null, "ast_1", [])).toBeNull();
  });
});

describe("analysis record helpers", () => {
  const base: AssetAnalysis = {
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
    analysisRevision: 1,
    reviewStatus: "UNREVIEWED",
    reviewNote: null,
    reviewedBy: null,
    reviewedAt: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  };

  it("treats null or at-threshold confidence as needing confirmation", () => {
    expect(isLowConfidence(base)).toBe(false);
    expect(isLowConfidence({ ...base, confidence: LOW_CONFIDENCE_THRESHOLD })).toBe(true);
    expect(isLowConfidence({ ...base, confidence: null })).toBe(true);
  });

  it("detects blocking flags but not warnings", () => {
    expect(hasBlockingFlag(base)).toBe(false);
    expect(
      hasBlockingFlag({
        ...base,
        safetyFlags: [{ code: "BLURRY", severity: "WARNING", message: "soft" }],
      }),
    ).toBe(false);
    expect(
      hasBlockingFlag({
        ...base,
        safetyFlags: [{ code: "UNSAFE_CONTENT", severity: "BLOCKING", message: "no" }],
      }),
    ).toBe(true);
  });
});
