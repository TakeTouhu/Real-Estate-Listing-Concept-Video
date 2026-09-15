import { describe, expect, it } from "vitest";
import {
  ISO_BMFF_CONTAINER,
  isWellFormedMediaValidationOutcome,
  MEDIA_INVALID_REASONS,
  parseManagedOutputMediaFacts,
  parseManagedOutputMediaValidationOutcome,
} from "./media-validation";

/**
 * The media-validation result boundary. The port returns `unknown`, so this
 * parser is the single authority — and it is the place a hostile adapter value
 * arrives. Every test here is about reading that value exactly once, under a
 * guard, into something the caller cannot be surprised by.
 */

function facts(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    container: ISO_BMFF_CONTAINER,
    durationMs: 8500,
    videoWidth: 1920,
    videoHeight: 1080,
    videoStreamCount: 1,
    audioStreamCount: 0,
    ...overrides,
  };
}

describe("the closed outcome model", () => {
  it("names exactly the five invalid reasons", () => {
    expect([...MEDIA_INVALID_REASONS]).toEqual([
      "CONTAINER_UNSUPPORTED",
      "VIDEO_STREAM_MISSING",
      "VIDEO_DIMENSIONS_INVALID",
      "DURATION_INVALID",
      "PROBE_REJECTED",
    ]);
  });

  it("materializes a VALID outcome into a fresh plain object", () => {
    const raw = { kind: "VALID", facts: facts() };
    const parsed = parseManagedOutputMediaValidationOutcome(raw);
    expect(parsed).toEqual({
      kind: "VALID",
      facts: {
        container: ISO_BMFF_CONTAINER,
        durationMs: 8500,
        videoWidth: 1920,
        videoHeight: 1080,
        videoStreamCount: 1,
        audioStreamCount: 0,
      },
    });
    // A fresh object, not the adapter's.
    expect((parsed as { facts: unknown }).facts).not.toBe(raw.facts);
  });

  it.each([
    ["INTEGRITY_MISMATCH", { kind: "INTEGRITY_MISMATCH" }],
    ["RETRYABLE_FAILURE", { kind: "RETRYABLE_FAILURE" }],
  ])("materializes %s", (kind, raw) => {
    expect(parseManagedOutputMediaValidationOutcome(raw)).toEqual({ kind });
  });

  it.each(MEDIA_INVALID_REASONS)("materializes INVALID_MEDIA with reason %s", (reason) => {
    expect(parseManagedOutputMediaValidationOutcome({ kind: "INVALID_MEDIA", reason })).toEqual({
      kind: "INVALID_MEDIA",
      reason,
    });
  });

  it("refuses an invalid reason outside the closed set", () => {
    expect(
      parseManagedOutputMediaValidationOutcome({ kind: "INVALID_MEDIA", reason: "CODEC_BAD" }),
    ).toBeNull();
  });

  it.each([
    ["null", null],
    ["an array", []],
    ["a string", "VALID"],
    ["an unknown kind", { kind: "MAYBE" }],
    ["VALID without facts", { kind: "VALID" }],
    ["VALID with an extra key", { kind: "VALID", facts: facts(), probePath: "/tmp/x" }],
    ["INVALID_MEDIA without a reason", { kind: "INVALID_MEDIA" }],
    ["INTEGRITY_MISMATCH with a message", { kind: "INTEGRITY_MISMATCH", message: "no" }],
    ["RETRYABLE_FAILURE with a diagnostic", { kind: "RETRYABLE_FAILURE", code: "E" }],
  ])("refuses %s", (_label, value) => {
    expect(parseManagedOutputMediaValidationOutcome(value)).toBeNull();
    expect(isWellFormedMediaValidationOutcome(value)).toBe(false);
  });
});

describe("media facts are normalized, never adapter-shaped", () => {
  it("accepts zero audio streams — audio is optional", () => {
    expect(parseManagedOutputMediaFacts(facts({ audioStreamCount: 0 }))).toEqual(
      facts({ audioStreamCount: 0 }),
    );
  });

  it("accepts multiple video and audio streams", () => {
    expect(
      parseManagedOutputMediaFacts(facts({ videoStreamCount: 2, audioStreamCount: 3 })),
    ).toEqual(facts({ videoStreamCount: 2, audioStreamCount: 3 }));
  });

  it.each([
    ["a foreign container", { container: "MATROSKA" }],
    ["zero duration", { durationMs: 0 }],
    ["negative duration", { durationMs: -1 }],
    ["fractional duration", { durationMs: 1.5 }],
    ["NaN duration", { durationMs: Number.NaN }],
    ["Infinite duration", { durationMs: Number.POSITIVE_INFINITY }],
    ["a string duration", { durationMs: "8500" }],
    ["zero width", { videoWidth: 0 }],
    ["negative width", { videoWidth: -1920 }],
    ["fractional width", { videoWidth: 1920.5 }],
    ["zero height", { videoHeight: 0 }],
    ["a string height", { videoHeight: "1080" }],
    ["zero video streams", { videoStreamCount: 0 }],
    ["negative audio streams", { audioStreamCount: -1 }],
    ["fractional audio streams", { audioStreamCount: 1.5 }],
  ])("refuses facts with %s", (_label, overrides) => {
    expect(parseManagedOutputMediaFacts(facts(overrides))).toBeNull();
  });

  it("refuses facts carrying an extra key", () => {
    expect(parseManagedOutputMediaFacts(facts({ codecName: "h264" }))).toBeNull();
    expect(parseManagedOutputMediaFacts(facts({ localPath: "/tmp/x/input" }))).toBeNull();
  });

  it("refuses facts missing a key", () => {
    const partial = facts();
    delete partial.audioStreamCount;
    expect(parseManagedOutputMediaFacts(partial)).toBeNull();
  });
});

describe("hostile adapter values are absorbed, never propagated", () => {
  it("absorbs a throwing kind getter", () => {
    const hostile = {
      get kind(): never {
        throw new Error("GETTER-SECRET /tmp/priv/input");
      },
    };
    expect(parseManagedOutputMediaValidationOutcome(hostile)).toBeNull();
  });

  it("reads kind exactly once, so a stateful getter cannot spring a second-read trap", () => {
    let reads = 0;
    const stateful = {
      get kind(): string {
        reads += 1;
        if (reads > 1) throw new Error("GETTER-SECRET-SECOND-READ");
        return "INTEGRITY_MISMATCH";
      },
    };
    expect(parseManagedOutputMediaValidationOutcome(stateful)).toEqual({
      kind: "INTEGRITY_MISMATCH",
    });
    expect(reads).toBe(1);
  });

  it("absorbs a throwing ownKeys trap", () => {
    const trapped = new Proxy(
      { kind: "VALID", facts: facts() },
      {
        ownKeys(): never {
          throw new Error("GETTER-SECRET");
        },
      },
    );
    expect(parseManagedOutputMediaValidationOutcome(trapped)).toBeNull();
  });

  it("absorbs a throwing media fact getter", () => {
    const hostileFacts = {
      container: ISO_BMFF_CONTAINER,
      get durationMs(): never {
        throw new Error("GETTER-SECRET");
      },
      videoWidth: 1920,
      videoHeight: 1080,
      videoStreamCount: 1,
      audioStreamCount: 0,
    };
    expect(parseManagedOutputMediaValidationOutcome({ kind: "VALID", facts: hostileFacts })).toBeNull();
  });

  it("reads each media fact once, so a stateful fact getter cannot change after validation", () => {
    let reads = 0;
    const stateful = {
      container: ISO_BMFF_CONTAINER,
      durationMs: 8500,
      get videoWidth(): number {
        reads += 1;
        return reads === 1 ? 1920 : -1;
      },
      videoHeight: 1080,
      videoStreamCount: 1,
      audioStreamCount: 0,
    };
    const parsed = parseManagedOutputMediaFacts(stateful);
    expect(parsed?.videoWidth).toBe(1920);
    expect(reads).toBe(1);
    // The materialized copy keeps the validated value however the raw changes.
    expect(parsed?.videoWidth).toBe(1920);
  });

  it("absorbs a revoked Proxy as the outcome and as the facts", () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    expect(parseManagedOutputMediaValidationOutcome(proxy)).toBeNull();
    expect(parseManagedOutputMediaFacts(proxy)).toBeNull();
  });

  it("puts nothing from a hostile value into the answer", () => {
    const hostile = {
      kind: "VALID",
      facts: facts({ container: "s3://bucket/key?sig=SECRETSIGNATURE" }),
    };
    const parsed = parseManagedOutputMediaValidationOutcome(hostile);
    expect(parsed).toBeNull();
    expect(JSON.stringify(parsed)).not.toContain("SECRETSIGNATURE");
  });
});
