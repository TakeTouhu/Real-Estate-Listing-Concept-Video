import { describe, expect, it } from "vitest";
import { AppError } from "@app/shared";
import { allocateDurations, requireMinimumScenes, type DurationBounds } from "./duration";

const BOUNDS: DurationBounds = { minSeconds: 2, maxSeconds: 10 };

/** Run the call and return the AppError it must throw. */
function failure(call: () => unknown): AppError {
  try {
    call();
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error("expected AppError, but the call succeeded");
}

describe("structural validation reports no achievable range", () => {
  // When the duration model itself is invalid, n × min … n × max would be
  // arithmetic over nonsense presented as advice.
  const cases: ReadonlyArray<readonly [string, () => unknown]> = [
    ["scene count below one", () => allocateDurations(0, 30, BOUNDS)],
    ["negative scene count", () => allocateDurations(-3, 30, BOUNDS)],
    ["fractional scene count", () => allocateDurations(2.5, 30, BOUNDS)],
    ["fractional total", () => allocateDurations(3, 30.5, BOUNDS)],
    ["zero total", () => allocateDurations(3, 0, BOUNDS)],
    ["negative total", () => allocateDurations(3, -30, BOUNDS)],
    ["fractional minimum", () => allocateDurations(3, 30, { minSeconds: 1.5, maxSeconds: 10 })],
    ["zero minimum", () => allocateDurations(3, 30, { minSeconds: 0, maxSeconds: 10 })],
    ["fractional maximum", () => allocateDurations(3, 30, { minSeconds: 2, maxSeconds: 9.5 })],
    ["negative maximum", () => allocateDurations(3, 30, { minSeconds: 2, maxSeconds: -1 })],
    ["minimum above maximum", () => allocateDurations(3, 30, { minSeconds: 11, maxSeconds: 10 })],
  ];

  for (const [name, call] of cases) {
    it(`rejects a ${name} without quoting a range`, () => {
      const error = failure(call);
      expect(error.code).toBe("VALIDATION_FAILED");
      expect(error.details).not.toHaveProperty("minimumAchievableDuration");
      expect(error.details).not.toHaveProperty("maximumAchievableDuration");
      expect(error.message).not.toMatch(/can run between/);
    });
  }
});

describe("out-of-range requests report the achievable range", () => {
  it("refuses a total below the minimum achievable", () => {
    const error = failure(() => allocateDurations(4, 5, BOUNDS));
    expect(error.details).toMatchObject({
      minimumAchievableDuration: 8,
      maximumAchievableDuration: 40,
      totalSeconds: 5,
    });
    expect(error.message).toContain("between 8 and 40");
  });

  it("refuses a total above the maximum achievable", () => {
    const error = failure(() => allocateDurations(4, 41, BOUNDS));
    expect(error.details).toMatchObject({
      minimumAchievableDuration: 8,
      maximumAchievableDuration: 40,
      totalSeconds: 41,
    });
  });

  it("does not shorten an over-long request to fit", () => {
    // The alternative — silently returning 40 seconds — hands back a video the
    // customer did not ask for.
    expect(() => allocateDurations(4, 100, BOUNDS)).toThrow(AppError);
  });

  it("does not reuse a photo to satisfy a too-long request", () => {
    const error = failure(() => allocateDurations(3, 60, BOUNDS));
    expect(error.code).toBe("VALIDATION_FAILED");
    expect(error.details).toMatchObject({ maximumAchievableDuration: 30 });
  });
});

describe("allocation", () => {
  it("splits an exact multiple evenly", () => {
    expect(allocateDurations(4, 20, BOUNDS)).toEqual([5, 5, 5, 5]);
  });

  it("gives the remainder to the earliest scenes, deterministically", () => {
    expect(allocateDurations(4, 22, BOUNDS)).toEqual([6, 6, 5, 5]);
    expect(allocateDurations(3, 20, BOUNDS)).toEqual([7, 7, 6]);
    expect(allocateDurations(4, 22, BOUNDS)).toEqual(allocateDurations(4, 22, BOUNDS));
  });

  it("sums to the request and stays within bounds across a range of inputs", () => {
    for (let sceneCount = 1; sceneCount <= 12; sceneCount += 1) {
      for (
        let total = sceneCount * BOUNDS.minSeconds;
        total <= sceneCount * BOUNDS.maxSeconds;
        total += 1
      ) {
        const durations = allocateDurations(sceneCount, total, BOUNDS);
        expect(durations).toHaveLength(sceneCount);
        expect(durations.reduce((sum, d) => sum + d, 0)).toBe(total);
        for (const duration of durations) {
          expect(duration).toBeGreaterThanOrEqual(BOUNDS.minSeconds);
          expect(duration).toBeLessThanOrEqual(BOUNDS.maxSeconds);
        }
      }
    }
  });

  it("handles both boundaries exactly", () => {
    expect(allocateDurations(5, 10, BOUNDS)).toEqual([2, 2, 2, 2, 2]);
    expect(allocateDurations(5, 50, BOUNDS)).toEqual([10, 10, 10, 10, 10]);
  });

  it("respects whatever bounds the caller supplies — it has no defaults", () => {
    const tight: DurationBounds = { minSeconds: 7, maxSeconds: 7 };
    expect(allocateDurations(3, 21, tight)).toEqual([7, 7, 7]);
    expect(() => allocateDurations(3, 22, tight)).toThrow(AppError);
  });
});

describe("minimum scene count is a separate invariant", () => {
  it("rejects fewer than three scenes without any duration vocabulary", () => {
    for (const count of [0, 1, 2]) {
      const error = failure(() => requireMinimumScenes(count));
      expect(error.code).toBe("VALIDATION_FAILED");
      expect(error.details).toMatchObject({ sceneCount: count, minimumScenes: 3 });
      expect(error.details).not.toHaveProperty("minimumAchievableDuration");
    }
  });

  it("accepts three or more", () => {
    expect(() => requireMinimumScenes(3)).not.toThrow();
    expect(() => requireMinimumScenes(20)).not.toThrow();
  });

  it("does not constrain allocation, which allocates for any positive count", () => {
    // The two rules are independent: allocation for two scenes is arithmetically
    // fine, and refusing the storyboard is the caller's separate decision.
    expect(allocateDurations(2, 10, BOUNDS)).toEqual([5, 5]);
  });
});
