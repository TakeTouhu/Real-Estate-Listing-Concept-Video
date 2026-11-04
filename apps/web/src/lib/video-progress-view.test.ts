import { describe, expect, it } from "vitest";
import type { VideoProgress } from "@app/domain";
import { NOT_DELIVERED_MESSAGE, PHASE_NAMES, unitsOf, videoProgressPanel } from "./video-progress-view";

/**
 * How the project page words its video (GS-11b, ADR-0114): each phase in
 * UXFlow's words, the Units in words that never contradict ADR-0052, and for a
 * video that ended without one ADR-0052's own message, whether a new video can
 * be started for the project and the reference to quote to support.
 */

function progress(overrides: Partial<VideoProgress> = {}): VideoProgress {
  return {
    phase: "GENERATING_SCENES",
    qualityTier: "HIGH_QUALITY",
    durationSeconds: 45,
    units: { count: 2, state: "RESERVED" },
    scenes: { ready: 1, total: 3 },
    supportReference: "gjob_1",
    ...overrides,
  };
}

const panel = (overrides: Partial<VideoProgress> = {}) =>
  videoProgressPanel({ kind: "PROGRESS", progress: progress(overrides) });

describe("the panel's words", () => {
  it("names every phase as UXFlow does, and never as a job state", () => {
    expect(PHASE_NAMES).toEqual({
      QUEUED: "Queued",
      GENERATING_SCENES: "Generating scenes",
      COMPOSING: "Composing",
      VALIDATING: "Validating",
      COMPLETED: "Completed",
      FAILED: "Failed",
      CANCELLED: "Cancelled",
    });
  });

  it("is ADR-0052's message, as written", () => {
    expect(NOT_DELIVERED_MESSAGE).toBe("動画を正常に生成できませんでした。今回の生成ではUnitは消費されていません。");
  });

  it("counts Units of the video's quality, one in the singular", () => {
    expect(unitsOf(1, "HIGH_QUALITY")).toBe("1 HQ Unit");
    expect(unitsOf(2, "NORMAL")).toBe("2 Normal Units");
  });
});

describe("a video being made", () => {
  it("says where it is, how many scenes are made, that its Units are used only if it is delivered", () => {
    expect(panel()).toEqual({
      status: "Generating scenes",
      tone: "neutral",
      summary: "HQ · 45 seconds",
      scenes: "1 of 3 scenes made",
      units: "2 HQ Units are reserved for it, and used only if it is delivered.",
      notDelivered: null,
      startAgain: null,
      reload: "This is its progress as of when the page was loaded; reload the page to see it now.",
      supportReference: "gjob_1",
    });
  });

  it("shows the scenes and the reload note in every phase before it is delivered", () => {
    for (const phase of ["QUEUED", "GENERATING_SCENES", "COMPOSING", "VALIDATING"] as const) {
      const shown = panel({ phase, scenes: { ready: 3, total: 3 } });
      expect(shown).toMatchObject({ status: PHASE_NAMES[phase], tone: "neutral", scenes: "3 of 3 scenes made" });
      expect(shown?.reload).not.toBeNull();
      expect(shown?.notDelivered).toBeNull();
      expect(shown?.startAgain).toBeNull();
    }
  });

  it("says a Normal video's quality, and Units that came back or were never reserved", () => {
    expect(panel({ qualityTier: "NORMAL", units: { count: 1, state: "RELEASED" } })).toMatchObject({
      summary: "Normal · 45 seconds",
      units: "The 1 Normal Unit reserved for it came back; it was not used.",
    });
    expect(panel({ units: { count: 2, state: "NONE" } })?.units).toBe("It reserved no Units.");
    expect(panel({ units: { count: 2, state: "RELEASED" } })?.units).toBe(
      "The 2 HQ Units reserved for it came back; none was used.",
    );
    expect(panel({ units: { count: 1, state: "RESERVED" } })?.units).toBe(
      "1 HQ Unit is reserved for it, and used only if it is delivered.",
    );
  });
});

describe("a delivered video", () => {
  it("says it is completed and the Units it used, with no scene count, message or start", () => {
    expect(panel({ phase: "COMPLETED", units: { count: 2, state: "CONSUMED" } })).toEqual({
      status: "Completed",
      tone: "ok",
      summary: "HQ · 45 seconds",
      scenes: null,
      units: "It used 2 HQ Units.",
      notDelivered: null,
      startAgain: null,
      reload: null,
      supportReference: "gjob_1",
    });
  });
});

describe("a video that ended without one", () => {
  it("shows ADR-0052's message, that its Units came back, and that a new video can be started", () => {
    expect(panel({ phase: "FAILED", units: { count: 2, state: "RELEASED" } })).toEqual({
      status: "Failed",
      tone: "bad",
      summary: "HQ · 45 seconds",
      scenes: null,
      units: "The 2 HQ Units reserved for it came back; none was used.",
      notDelivered: NOT_DELIVERED_MESSAGE,
      startAgain: "A new video can be started for this project.",
      reload: null,
      supportReference: "gjob_1",
    });
  });

  it("says the same of a cancelled video, and of one that reserved no Units", () => {
    for (const phase of ["FAILED", "CANCELLED"] as const) {
      expect(panel({ phase, units: { count: 2, state: "NONE" } })).toMatchObject({
        status: PHASE_NAMES[phase],
        tone: "bad",
        units: "It reserved no Units.",
        notDelivered: NOT_DELIVERED_MESSAGE,
        startAgain: "A new video can be started for this project.",
      });
    }
  });

  it("says Units still held are not used, and the project waits for them (ADR-0110)", () => {
    expect(panel({ phase: "FAILED", units: { count: 2, state: "RESERVED" } })).toMatchObject({
      units: "The 2 HQ Units reserved for it are still held, and come back once settled; none was used.",
      startAgain: "A new video can be started for this project once its Units have come back.",
    });
    expect(panel({ phase: "CANCELLED", units: { count: 1, state: "RESERVED" } })?.units).toBe(
      "The 1 HQ Unit reserved for it is still held, and comes back once settled; it was not used.",
    );
  });
});

describe("what was read", () => {
  it("shows no panel for a project with no video", () => {
    expect(videoProgressPanel({ kind: "NONE" })).toBeNull();
  });

  it("shows a video it could not read with only that, and its reference", () => {
    expect(videoProgressPanel({ kind: "UNREADABLE", supportReference: "gjob_9" })).toEqual({
      status: "This video's progress could not be read.",
      tone: "bad",
      summary: null,
      scenes: null,
      units: null,
      notDelivered: null,
      startAgain: null,
      reload: null,
      supportReference: "gjob_9",
    });
  });
});
