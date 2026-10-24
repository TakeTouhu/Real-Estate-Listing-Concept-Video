import { describe, expect, it } from "vitest";
import {
  COMPOSABLE_TARGETS,
  resolveCompositionProfile,
} from "../deliverable-composition-execution/profile";
import { ISO_BMFF_CONTAINER, type ManagedOutputMediaFacts } from "../provider-output/media-validation";
import { DeliverableValidationDefect } from "./durable";
import { deliverableOffPlanReason, plannedDeliverableMedia } from "./plan";

/**
 * What a composed deliverable must measure (ADR-0081): the frozen profile's frame
 * size exactly, and the admitted length within one frame period.
 */

const PLAN_INPUT = {
  targetWidthPx: 1920,
  targetHeightPx: 1080,
  frameRateNumerator: 30,
  frameRateDenominator: 1,
  requestedDurationSeconds: 10,
};

const FACTS: ManagedOutputMediaFacts = {
  container: ISO_BMFF_CONTAINER,
  durationMs: 10_000,
  videoWidth: 1920,
  videoHeight: 1080,
  videoStreamCount: 1,
  audioStreamCount: 0,
};

describe("the plan is the composition's raster and the job's length", () => {
  it("takes the frame size as frozen and the length in milliseconds", () => {
    expect(plannedDeliverableMedia(PLAN_INPUT)).toEqual({
      widthPx: 1920,
      heightPx: 1080,
      durationMs: 10_000,
      durationToleranceMs: 34,
    });
  });

  it("allows one frame period, rounded up to whole milliseconds", () => {
    const tolerance = (frameRateNumerator: number, frameRateDenominator: number) =>
      plannedDeliverableMedia({ ...PLAN_INPUT, frameRateNumerator, frameRateDenominator })
        .durationToleranceMs;
    expect(tolerance(30, 1)).toBe(34); // 33.33...
    expect(tolerance(30_000, 1_001)).toBe(34); // 33.366...
    expect(tolerance(25, 1)).toBe(40); // exact, not rounded up past it
    expect(tolerance(24, 1)).toBe(42); // 41.66...
    expect(tolerance(60, 1)).toBe(17); // 16.66...
    expect(tolerance(1, 1)).toBe(1_000);
  });

  it("gives every target this build composes a plan of its own raster", () => {
    expect(COMPOSABLE_TARGETS.length).toBeGreaterThan(0);
    for (const target of COMPOSABLE_TARGETS) {
      const resolved = resolveCompositionProfile(target);
      if (resolved.kind !== "RESOLVED") throw new Error("unresolvable composable target");
      const plan = plannedDeliverableMedia({ ...resolved.profile, requestedDurationSeconds: 30 });
      expect(plan).toEqual({
        widthPx: resolved.profile.targetWidthPx,
        heightPx: resolved.profile.targetHeightPx,
        durationMs: 30_000,
        durationToleranceMs: 34,
      });
    }
  });

  it("refuses a row no build writes, rather than planning around it", () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
      for (const field of Object.keys(PLAN_INPUT)) {
        expect(() => plannedDeliverableMedia({ ...PLAN_INPUT, [field]: bad })).toThrow(
          DeliverableValidationDefect,
        );
      }
    }
    // A length whose milliseconds would leave the safe range.
    expect(() =>
      plannedDeliverableMedia({ ...PLAN_INPUT, requestedDurationSeconds: 2 ** 52 }),
    ).toThrow(DeliverableValidationDefect);
    expect(() => plannedDeliverableMedia({ ...PLAN_INPUT, targetWidthPx: 0 })).toThrow(
      expect.objectContaining({ code: "PERSISTED_RECORD_MALFORMED" }),
    );
  });
});

describe("measured facts against the plan", () => {
  const plan = plannedDeliverableMedia(PLAN_INPUT);

  it("accepts the planned size and length", () => {
    expect(deliverableOffPlanReason(FACTS, plan)).toBeNull();
  });

  it("compares the frame size exactly, both edges", () => {
    for (const facts of [
      { ...FACTS, videoWidth: 1919 },
      { ...FACTS, videoWidth: 1921 },
      { ...FACTS, videoHeight: 1079 },
      { ...FACTS, videoHeight: 1081 },
      { ...FACTS, videoWidth: 1080, videoHeight: 1920 },
    ]) {
      expect(deliverableOffPlanReason(facts, plan)).toBe("VIDEO_DIMENSIONS_INVALID");
    }
  });

  it("accepts the length up to one frame either way and refuses one millisecond past", () => {
    expect(deliverableOffPlanReason({ ...FACTS, durationMs: 10_034 }, plan)).toBeNull();
    expect(deliverableOffPlanReason({ ...FACTS, durationMs: 9_966 }, plan)).toBeNull();
    expect(deliverableOffPlanReason({ ...FACTS, durationMs: 10_035 }, plan)).toBe(
      "DURATION_INVALID",
    );
    expect(deliverableOffPlanReason({ ...FACTS, durationMs: 9_965 }, plan)).toBe(
      "DURATION_INVALID",
    );
  });

  it("refuses a missing or an extra scene, which is at least a second", () => {
    expect(deliverableOffPlanReason({ ...FACTS, durationMs: 9_000 }, plan)).toBe(
      "DURATION_INVALID",
    );
    expect(deliverableOffPlanReason({ ...FACTS, durationMs: 11_000 }, plan)).toBe(
      "DURATION_INVALID",
    );
  });

  it("names the size when both are wrong, on every call", () => {
    expect(
      deliverableOffPlanReason({ ...FACTS, videoHeight: 720, durationMs: 1 }, plan),
    ).toBe("VIDEO_DIMENSIONS_INVALID");
  });

  it("judges nothing else: streams and container are the media policy's", () => {
    expect(
      deliverableOffPlanReason({ ...FACTS, videoStreamCount: 2, audioStreamCount: 1 }, plan),
    ).toBeNull();
  });
});
