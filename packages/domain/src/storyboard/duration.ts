import { AppError } from "@app/shared";
import { MIN_STORYBOARD_SCENES } from "./types";

/** Per-scene limits. Always supplied by the caller — this module has no defaults. */
export interface DurationBounds {
  readonly minSeconds: number;
  readonly maxSeconds: number;
}

function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

/**
 * The composition minimum, kept separate from the duration math.
 *
 * A storyboard shorter than {@link MIN_STORYBOARD_SCENES} is refused for having
 * too few approved photos, which has nothing to do with how long the video is —
 * so this failure carries no achievable duration range, and the two rules can
 * never mask each other.
 *
 * @throws AppError VALIDATION_FAILED when fewer than three scenes are available.
 */
export function requireMinimumScenes(sceneCount: number): void {
  if (sceneCount < MIN_STORYBOARD_SCENES) {
    throw new AppError(
      "VALIDATION_FAILED",
      `A storyboard needs at least ${MIN_STORYBOARD_SCENES} approved photos; ${sceneCount} are available`,
      { details: { sceneCount, minimumScenes: MIN_STORYBOARD_SCENES } },
    );
  }
}

/**
 * Split a requested total across scenes.
 *
 * Validation happens in two stages, and the order matters. **Structural**
 * problems — a scene count below one, a non-integer or non-positive total or
 * bound, or a minimum above the maximum — fail on their own terms and carry
 * **no achievable range**: when the duration model itself is nonsense, quoting
 * `n × min … n × max` would present arithmetic over invalid numbers as if it
 * were advice. Only once the model is sound does an out-of-range request report
 * `minimumAchievableDuration` and `maximumAchievableDuration`.
 *
 * A request outside that range **fails**. It is never satisfied by reusing a
 * photo for a second scene, and never quietly shortened to fit: both would hand
 * back a video the customer did not ask for.
 *
 * Allocation gives every scene `floor(total / n)` seconds and distributes the
 * remainder one second at a time to the earliest scenes. Within a valid range
 * this provably keeps each value inside the bounds and makes the sum exactly the
 * requested total, deterministically.
 *
 * @throws AppError VALIDATION_FAILED for structural problems, and for a total
 *   outside the achievable range.
 */
export function allocateDurations(
  sceneCount: number,
  totalSeconds: number,
  bounds: DurationBounds,
): readonly number[] {
  if (!isPositiveInteger(sceneCount)) {
    throw structuralError("Scene count must be a positive whole number", { sceneCount });
  }
  if (!isPositiveInteger(totalSeconds)) {
    throw structuralError("Requested duration must be a positive whole number of seconds", {
      totalSeconds,
    });
  }
  if (!isPositiveInteger(bounds.minSeconds) || !isPositiveInteger(bounds.maxSeconds)) {
    throw structuralError("Scene duration bounds must be positive whole numbers of seconds", {
      minSeconds: bounds.minSeconds,
      maxSeconds: bounds.maxSeconds,
    });
  }
  if (bounds.minSeconds > bounds.maxSeconds) {
    throw structuralError("Minimum scene duration cannot exceed the maximum", {
      minSeconds: bounds.minSeconds,
      maxSeconds: bounds.maxSeconds,
    });
  }

  const minimumAchievableDuration = sceneCount * bounds.minSeconds;
  const maximumAchievableDuration = sceneCount * bounds.maxSeconds;
  if (totalSeconds < minimumAchievableDuration || totalSeconds > maximumAchievableDuration) {
    throw new AppError(
      "VALIDATION_FAILED",
      `${sceneCount} scenes can run between ${minimumAchievableDuration} and ${maximumAchievableDuration} seconds; ${totalSeconds} was requested`,
      { details: { minimumAchievableDuration, maximumAchievableDuration, totalSeconds } },
    );
  }

  const base = Math.floor(totalSeconds / sceneCount);
  const remainder = totalSeconds - base * sceneCount;
  return Array.from({ length: sceneCount }, (_unused, index) =>
    index < remainder ? base + 1 : base,
  );
}

/** A structural failure states the problem and quotes no achievable range. */
function structuralError(message: string, details: Record<string, unknown>): AppError {
  return new AppError("VALIDATION_FAILED", message, { details });
}
