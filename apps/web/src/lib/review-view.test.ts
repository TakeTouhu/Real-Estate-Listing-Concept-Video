import { describe, expect, it } from "vitest";
import type { AssetAnalysis, MediaAsset, SafetyFlag } from "@app/domain";
import { buildReviewBoard, humanizeRoomType } from "./review-view";

const NOW = new Date("2026-07-31T10:00:00.000Z");
const ORG = "org_1";

function asset(id: string, overrides: Partial<MediaAsset> = {}): MediaAsset {
  return {
    id,
    organizationId: ORG,
    propertyId: "prp_1",
    storageKey: `org/${ORG}/${id}.jpg`,
    originalFilename: `${id}.jpg`,
    mimeType: "image/jpeg",
    sizeBytes: 1000,
    width: 1600,
    height: 1200,
    sha256: null,
    perceptualHash: "ffffffffffffffff",
    status: "READY",
    failureReason: null,
    thumbnailKey: `org/${ORG}/${id}-thumb.jpg`,
    createdBy: "usr_1",
    deletionRequestedAt: null,
    retentionExpiresAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function analysis(assetId: string, overrides: Partial<AssetAnalysis> = {}): AssetAnalysis {
  return {
    id: `ana_${assetId}`,
    organizationId: ORG,
    assetId,
    provider: "deterministic",
    status: "SUCCEEDED",
    roomType: "LIVING_ROOM",
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
    reviewStatus: "UNREVIEWED",
    reviewNote: null,
    reviewedBy: null,
    reviewedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

const blocking: SafetyFlag = {
  code: "PERSON_DETECTED",
  severity: "BLOCKING",
  message: "A person appears in this photo.",
};
const warning: SafetyFlag = {
  code: "BLURRY",
  severity: "WARNING",
  message: "This photo looks soft.",
};

describe("bucketing", () => {
  it("puts a succeeded, unreviewed analysis in the awaiting bucket", () => {
    const board = buildReviewBoard([asset("a")], [analysis("a")], "OWNER");
    expect(board.awaiting.map((i) => i.assetId)).toEqual(["a"]);
    expect(board.decided).toEqual([]);
    expect(board.notReviewable).toEqual([]);
  });

  it("puts a decided analysis in the decided bucket with an immutable record", () => {
    const reviewed = analysis("a", {
      reviewStatus: "APPROVED",
      reviewNote: "Looks good",
      reviewedBy: "usr_reviewer",
      reviewedAt: NOW,
      analysisRevision: 2,
    });
    const board = buildReviewBoard([asset("a")], [reviewed], "OWNER");
    const item = board.decided[0]!;
    expect(item.decision).toEqual({
      status: "APPROVED",
      note: "Looks good",
      reviewedBy: "usr_reviewer",
      reviewedAt: NOW,
      analysisRevision: 2,
    });
    // A decision is final for its revision: no action is offered, and no
    // "unavailable" excuse is needed either.
    expect(item.actions).toEqual({
      canApprove: false,
      canReject: false,
      unavailableReason: null,
    });
  });

  it("reports why an asset is not reviewable", () => {
    const board = buildReviewBoard(
      [asset("a"), asset("b"), asset("c")],
      [
        analysis("a", { status: "PENDING" }),
        analysis("b", { status: "FAILED", failureReason: "Provider timed out" }),
      ],
      "OWNER",
    );
    expect(board.notReviewable.map((i) => i.notReviewableReason)).toEqual([
      "Analysis in progress.",
      "Provider timed out",
      "Not analyzed yet.",
    ]);
    expect(board.notReviewable.every((i) => !i.actions.canApprove && !i.actions.canReject)).toBe(
      true,
    );
  });
});

describe("safety flags", () => {
  it("splits blocking from warning flags and bars approval on a blocking finding", () => {
    const board = buildReviewBoard(
      [asset("a")],
      [analysis("a", { safetyFlags: [blocking, warning] })],
      "OWNER",
    );
    const item = board.awaiting[0]!;
    expect(item.blockingFlags).toEqual([blocking]);
    expect(item.warningFlags).toEqual([warning]);
    expect(item.actions.canApprove).toBe(false);
    // Rejection stays available: a blocked photo still needs a decision.
    expect(item.actions.canReject).toBe(true);
    expect(item.actions.unavailableReason).toContain("blocking safety finding");
  });

  it("treats low confidence as a caution, not a block", () => {
    const board = buildReviewBoard([asset("a")], [analysis("a", { confidence: 0.4 })], "OWNER");
    expect(board.awaiting[0]!.lowConfidence).toBe(true);
    expect(board.awaiting[0]!.actions.canApprove).toBe(true);
  });
});

describe("duplicate clusters", () => {
  it("groups members of a multi-member duplicate group and keeps them out of the flat buckets", () => {
    const board = buildReviewBoard(
      [asset("a"), asset("b"), asset("c")],
      [
        analysis("a", { duplicateGroup: "dup_1" }),
        analysis("b", { duplicateGroup: "dup_1" }),
        analysis("c"),
      ],
      "OWNER",
    );
    expect(board.clusters).toHaveLength(1);
    expect(board.clusters[0]!.items.map((i) => i.assetId)).toEqual(["a", "b"]);
    expect(board.clusters[0]!.approvedAssetId).toBeNull();
    expect(board.awaiting.map((i) => i.assetId)).toEqual(["c"]);
  });

  it("does not cluster a group of one, matching the domain's primary-choice rule", () => {
    const board = buildReviewBoard(
      [asset("a")],
      [analysis("a", { duplicateGroup: "dup_1" })],
      "OWNER",
    );
    expect(board.clusters).toEqual([]);
    expect(board.awaiting.map((i) => i.assetId)).toEqual(["a"]);
  });

  it("marks the approved member and stops the others being offered approval", () => {
    const board = buildReviewBoard(
      [asset("a"), asset("b")],
      [
        analysis("a", {
          duplicateGroup: "dup_1",
          reviewStatus: "APPROVED",
          reviewedBy: "usr_reviewer",
          reviewedAt: NOW,
        }),
        analysis("b", { duplicateGroup: "dup_1" }),
      ],
      "OWNER",
    );
    const cluster = board.clusters[0]!;
    expect(cluster.approvedAssetId).toBe("a");
    const other = cluster.items.find((i) => i.assetId === "b")!;
    expect(other.actions.canApprove).toBe(false);
    expect(other.actions.canReject).toBe(false);
    expect(other.actions.unavailableReason).toContain("already approved");
  });

  it("ignores duplicate groups on analyses that are not succeeded", () => {
    const board = buildReviewBoard(
      [asset("a"), asset("b")],
      [
        analysis("a", { duplicateGroup: "dup_1" }),
        analysis("b", { duplicateGroup: "dup_1", status: "FAILED", failureReason: "boom" }),
      ],
      "OWNER",
    );
    expect(board.clusters).toEqual([]);
    expect(board.awaiting.map((i) => i.assetId)).toEqual(["a"]);
    expect(board.notReviewable.map((i) => i.assetId)).toEqual(["b"]);
  });
});

describe("presentation-level authorization", () => {
  it("offers no decision to a role without video:review", () => {
    const board = buildReviewBoard([asset("a")], [analysis("a")], "CREATOR");
    expect(board.canReview).toBe(false);
    const item = board.awaiting[0]!;
    expect(item.actions.canApprove).toBe(false);
    expect(item.actions.canReject).toBe(false);
    expect(item.actions.unavailableReason).toContain("cannot approve or reject");
  });

  it("offers both decisions to every role that holds video:review", () => {
    for (const role of ["OWNER", "ADMIN", "REVIEWER"] as const) {
      const board = buildReviewBoard([asset("a")], [analysis("a")], role);
      expect(board.canReview).toBe(true);
      expect(board.awaiting[0]!.actions).toEqual({
        canApprove: true,
        canReject: true,
        unavailableReason: null,
      });
    }
  });
});

describe("labels", () => {
  it("shows the revision of every analysed asset and none for an unanalysed one", () => {
    const board = buildReviewBoard(
      [asset("a"), asset("b")],
      [analysis("a", { analysisRevision: 3 })],
      "OWNER",
    );
    expect(board.awaiting[0]!.analysisRevision).toBe(3);
    expect(board.notReviewable[0]!.analysisRevision).toBeNull();
  });

  it("humanizes room types and names the unclassified case", () => {
    expect(humanizeRoomType("LIVING_ROOM")).toBe("Living room");
    expect(humanizeRoomType("KITCHEN")).toBe("Kitchen");
    expect(humanizeRoomType(null)).toBe("Unclassified");
  });
});
