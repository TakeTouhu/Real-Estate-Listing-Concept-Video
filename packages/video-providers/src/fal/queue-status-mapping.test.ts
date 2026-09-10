import { describe, expect, it } from "vitest";
import { SUBMISSION_DIAGNOSTIC_CODES } from "@app/domain";
import { MINIMAX_H3_MAX_MODEL_ID } from "../catalog";
import { FAL_QUEUE_BASE_URL } from "./h3-max-mapping";
import {
  encodeFalQueueRequestId,
  falQueueResponseUrl,
  falQueueStatusUrl,
  FAL_ERROR_TYPE_DIAGNOSTIC,
  FAL_ERROR_TYPE_RETRYABLE,
  FAL_PROVIDER_NAME,
  FAL_QUEUE_ERROR_TYPES,
  isFalQueueErrorType,
  parseFalH3MaxOutputUrl,
  parseFalQueueStatus,
  type FalQueueErrorType,
} from "./queue-status-mapping";

/**
 * The pure half of the fal status adapter.
 *
 * Everything here is decidable without a transport, which is why the whole
 * vocabulary can be enumerated rather than sampled: the error-type table is
 * asserted member by member against the values it must produce, not spot
 * checked, because a single wrong entry is either an abandoned paid render or a
 * customer's unit spent twice on the same doomed request.
 */

describe("the closed fal error-type vocabulary", () => {
  it("contains exactly the thirteen published request-error types", () => {
    expect([...FAL_QUEUE_ERROR_TYPES]).toEqual([
      "request_timeout",
      "startup_timeout",
      "runner_scheduling_failure",
      "runner_connection_timeout",
      "runner_disconnected",
      "runner_connection_refused",
      "runner_connection_error",
      "runner_incomplete_response",
      "runner_server_error",
      "client_disconnected",
      "client_cancelled",
      "bad_request",
      "internal_error",
    ]);
  });

  it("is frozen", () => {
    expect(Object.isFrozen(FAL_QUEUE_ERROR_TYPES)).toBe(true);
  });

  it("names fal as the only supported provider", () => {
    expect(FAL_PROVIDER_NAME).toBe("fal");
  });

  it.each([
    "runner_something_new",
    "RUNNER_DISCONNECTED",
    "request_timeout ",
    " request_timeout",
    "",
    "timeout",
  ])("refuses %o, which is not a member", (value) => {
    expect(isFalQueueErrorType(value)).toBe(false);
  });

  it.each([null, undefined, 7, true, {}, [], ["request_timeout"]])(
    "refuses the non-string %o",
    (value) => {
      expect(isFalQueueErrorType(value)).toBe(false);
    },
  );

  it("matches on membership, never by prefix or substring", () => {
    // `runner_disconnected_v2` contains a member and is not one. Substring
    // matching would classify an error type fal has not published, using the
    // retryability of a different one.
    expect(isFalQueueErrorType("runner_disconnected_v2")).toBe(false);
    expect(isFalQueueErrorType("x_bad_request")).toBe(false);
  });
});

describe("retryability", () => {
  const RETRYABLE: readonly FalQueueErrorType[] = [
    "request_timeout",
    "startup_timeout",
    "runner_scheduling_failure",
    "runner_connection_timeout",
    "runner_disconnected",
    "runner_connection_refused",
    "runner_connection_error",
    "runner_incomplete_response",
    "runner_server_error",
    "internal_error",
  ];
  const TERMINAL: readonly FalQueueErrorType[] = [
    "client_disconnected",
    "client_cancelled",
    "bad_request",
  ];

  it.each(RETRYABLE)("treats %s as retryable", (type) => {
    expect(FAL_ERROR_TYPE_RETRYABLE[type]).toBe(true);
  });

  it.each(TERMINAL)("treats %s as not retryable", (type) => {
    expect(FAL_ERROR_TYPE_RETRYABLE[type]).toBe(false);
  });

  it("covers every member exactly once, with a real boolean", () => {
    // Not truthiness. This flag decides whether a customer's request may be
    // attempted — and paid for — again.
    expect(Object.keys(FAL_ERROR_TYPE_RETRYABLE).sort()).toEqual([...FAL_QUEUE_ERROR_TYPES].sort());
    for (const type of FAL_QUEUE_ERROR_TYPES) {
      expect(typeof FAL_ERROR_TYPE_RETRYABLE[type]).toBe("boolean");
    }
  });

  it("partitions the vocabulary — the two lists together are the whole catalog", () => {
    expect([...RETRYABLE, ...TERMINAL].sort()).toEqual([...FAL_QUEUE_ERROR_TYPES].sort());
  });
});

describe("diagnostic mapping", () => {
  it.each([
    ["request_timeout", "TIMEOUT"],
    ["startup_timeout", "TIMEOUT"],
    ["runner_connection_timeout", "CONNECTION_RESET"],
    ["runner_disconnected", "CONNECTION_RESET"],
    ["runner_connection_refused", "CONNECTION_RESET"],
    ["runner_connection_error", "CONNECTION_RESET"],
    ["runner_incomplete_response", "CONNECTION_RESET"],
    ["bad_request", "LOCAL_CONFIGURATION"],
  ] as const)("maps %s to %s", (type, code) => {
    expect(FAL_ERROR_TYPE_DIAGNOSTIC[type]).toBe(code);
  });

  it.each([
    "runner_scheduling_failure",
    "runner_server_error",
    "internal_error",
    "client_disconnected",
    "client_cancelled",
  ] as const)("declines to diagnose %s rather than inventing a code", (type) => {
    expect(FAL_ERROR_TYPE_DIAGNOSTIC[type]).toBeNull();
  });

  it("covers every member exactly once", () => {
    expect(Object.keys(FAL_ERROR_TYPE_DIAGNOSTIC).sort()).toEqual(
      [...FAL_QUEUE_ERROR_TYPES].sort(),
    );
  });

  it("never invents a code outside Phase 2G-1's closed catalog", () => {
    // The catalog is three members wide and this phase does not extend it. A
    // fal-shaped code here would be a vendor's taxonomy in a field ADR-0031
    // requires this application to own.
    for (const type of FAL_QUEUE_ERROR_TYPES) {
      const code = FAL_ERROR_TYPE_DIAGNOSTIC[type];
      if (code === null) continue;
      expect((SUBMISSION_DIAGNOSTIC_CODES as readonly string[]).includes(code)).toBe(true);
    }
  });

  it("never uses a fal error type as its own diagnostic", () => {
    for (const type of FAL_QUEUE_ERROR_TYPES) {
      expect(FAL_ERROR_TYPE_DIAGNOSTIC[type]).not.toBe(type);
    }
  });
});

describe("reading a fal status body", () => {
  it.each(["IN_QUEUE", "IN_PROGRESS"])("reads %s as still working", (status) => {
    expect(parseFalQueueStatus({ status })).toEqual({ kind: "IN_PROGRESS" });
  });

  it("ignores queue position, logs and metrics on an in-queue body", () => {
    expect(
      parseFalQueueStatus({
        status: "IN_QUEUE",
        queue_position: 3,
        logs: [{ message: "loading weights from s3://bucket/secret" }],
        metrics: { inference_time: 12.5 },
        response_url: "https://attacker.example/response",
      }),
    ).toEqual({ kind: "IN_PROGRESS" });
  });

  it("reads COMPLETED with no failure fields as success", () => {
    expect(parseFalQueueStatus({ status: "COMPLETED" })).toEqual({ kind: "COMPLETED_SUCCESS" });
  });

  it("treats explicitly null failure fields as no failure", () => {
    // fal serializing an absent field as `null` is not a failure claim.
    expect(parseFalQueueStatus({ status: "COMPLETED", error: null, error_type: null })).toEqual({
      kind: "COMPLETED_SUCCESS",
    });
  });

  it.each([...FAL_QUEUE_ERROR_TYPES])("classifies the recognized failure %s", (errorType) => {
    expect(
      parseFalQueueStatus({
        status: "COMPLETED",
        error: "the runner exploded at 03:14 while processing prompt 'a sunlit living room'",
        error_type: errorType,
      }),
    ).toEqual({ kind: "COMPLETED_FAILURE", errorType });
  });

  it("classifies a failure carrying only error_type", () => {
    expect(parseFalQueueStatus({ status: "COMPLETED", error_type: "bad_request" })).toEqual({
      kind: "COMPLETED_FAILURE",
      errorType: "bad_request",
    });
  });

  it("treats a failure claimed only through the human-readable half as unclassified", () => {
    // The claim is real — a paid render did not produce output — so it must not
    // read as success. But `error` is never parsed, so it cannot be classified.
    expect(parseFalQueueStatus({ status: "COMPLETED", error: "Internal server error" })).toEqual({
      kind: "COMPLETED_FAILURE_UNCLASSIFIED",
    });
  });

  it.each([
    ["an unknown type", "runner_evaporated"],
    ["a blank type", ""],
    ["a whitespace type", "   "],
    ["a numeric type", 500],
    ["a boolean type", true],
    ["an object type", { code: "bad_request" }],
    ["an array type", ["bad_request"]],
  ])("refuses to classify %s", (_label, errorType) => {
    expect(parseFalQueueStatus({ status: "COMPLETED", error: "x", error_type: errorType })).toEqual(
      { kind: "COMPLETED_FAILURE_UNCLASSIFIED" },
    );
  });

  it("never uses the human-readable error to classify", () => {
    // The text names a recognized type; the machine-readable field does not.
    // Reading the prose would produce a confident, wrong classification.
    expect(
      parseFalQueueStatus({
        status: "COMPLETED",
        error: "request_timeout: the request timed out",
        error_type: "not_a_real_type",
      }),
    ).toEqual({ kind: "COMPLETED_FAILURE_UNCLASSIFIED" });
  });

  it.each([
    ["null", null],
    ["an array", []],
    ["a string", "COMPLETED"],
    ["a number", 200],
    ["a boolean", true],
    ["an object with no status", { error_type: "bad_request" }],
    ["a non-string status", { status: 200 }],
    ["a null status", { status: null }],
    ["an unpublished status", { status: "CANCELLED" }],
    ["a lowercased status", { status: "completed" }],
    ["an empty status", { status: "" }],
  ])("refuses %s outright", (_label, payload) => {
    expect(parseFalQueueStatus(payload)).toBeNull();
  });

  it("does not treat an unknown lifecycle state as either finished or running", () => {
    // A fourth fal state must not be swept into one of the three we know. Both
    // readings are wrong in an expensive direction.
    const parsed = parseFalQueueStatus({ status: "PAUSED" });
    expect(parsed).toBeNull();
  });
});

describe("reading an H3 Max result body", () => {
  it("recovers video.url", () => {
    expect(parseFalH3MaxOutputUrl({ video: { url: "https://fal.media/files/x.mp4" } })).toBe(
      "https://fal.media/files/x.mp4",
    );
  });

  it("ignores every other documented result field", () => {
    expect(
      parseFalH3MaxOutputUrl({
        video: {
          url: "https://fal.media/files/y.mp4",
          content_type: "video/mp4",
          file_name: "y.mp4",
          file_size: 4_194_304,
        },
        expanded_prompt: "a sunlit living room, golden hour, slow dolly in",
        timings: { inference: 41.2 },
        logs: ["loading"],
        seed: 12345,
      }),
    ).toBe("https://fal.media/files/y.mp4");
  });

  it.each([
    ["null", null],
    ["an array", []],
    ["a string", "https://fal.media/files/x.mp4"],
    ["no video", { seed: 1 }],
    ["a null video", { video: null }],
    ["a string video", { video: "https://fal.media/files/x.mp4" }],
    ["an array video", { video: [] }],
    ["no url", { video: { content_type: "video/mp4" } }],
    ["a null url", { video: { url: null } }],
    ["a numeric url", { video: { url: 42 } }],
    ["a blank url", { video: { url: "" } }],
    ["a whitespace url", { video: { url: "   " } }],
  ])("returns null for %s", (_label, payload) => {
    expect(parseFalH3MaxOutputUrl(payload)).toBeNull();
  });

  it("never reads a top-level url as the output", () => {
    // Only `video.url` is the documented artifact. A sibling `url` is some
    // other resource, and dereferencing it later would fetch the wrong thing.
    expect(parseFalH3MaxOutputUrl({ url: "https://fal.media/files/other.mp4" })).toBeNull();
  });
});

describe("request-id path safety", () => {
  it("passes a normal fal request id through as one component", () => {
    expect(encodeFalQueueRequestId("764cabcf-b745-4b3e-ae38-1200304cf45b")).toBe(
      "764cabcf-b745-4b3e-ae38-1200304cf45b",
    );
  });

  it.each([
    ["a path separator", "abc/def", "abc%2Fdef"],
    ["a leading separator", "/etc/passwd", "%2Fetc%2Fpasswd"],
    ["a query separator", "abc?logs=1", "abc%3Flogs%3D1"],
    ["a fragment", "abc#frag", "abc%23frag"],
    ["a percent", "abc%2e%2e", "abc%252e%252e"],
    ["a traversal inside a longer id", "a/../b", "a%2F..%2Fb"],
    ["a newline", "abc\ndef", "abc%0Adef"],
    ["a carriage return", "abc\r\ndef", "abc%0D%0Adef"],
    ["a space", "abc def", "abc%20def"],
    ["a colon-slash", "https://attacker.example", "https%3A%2F%2Fattacker.example"],
  ])("encodes %s as a single component", (_label, raw, encoded) => {
    const result = encodeFalQueueRequestId(raw);
    expect(result).toBe(encoded);
    // The decisive property, stated directly: nothing that could end the
    // component survives encoding.
    for (const dangerous of ["/", "?", "#"]) {
      expect(result?.includes(dangerous)).toBe(false);
    }
  });

  it.each(["..", ".", "...", "...."])("refuses the traversal segment %o outright", (raw) => {
    // `encodeURIComponent` leaves dots alone, so this is the one hostile shape
    // encoding cannot neutralize — `…/requests/../status` addresses a different
    // resource. There is no legitimate fal request id it could be.
    expect(encodeFalQueueRequestId(raw)).toBeNull();
  });

  it.each(["", "   ", "\t", "\n"])("refuses the blank id %o", (raw) => {
    expect(encodeFalQueueRequestId(raw)).toBeNull();
  });

  it("keeps a dot-containing id that is not purely dots", () => {
    expect(encodeFalQueueRequestId("a.b.c")).toBe("a.b.c");
  });
});

describe("queue resource derivation", () => {
  const ID = "764cabcf-b745-4b3e-ae38-1200304cf45b";

  it("derives the status resource from the frozen host and model constant", () => {
    expect(falQueueStatusUrl(ID)).toBe(
      `${FAL_QUEUE_BASE_URL}/${MINIMAX_H3_MAX_MODEL_ID}/requests/${ID}/status`,
    );
  });

  it("derives the result resource from the frozen host and model constant", () => {
    expect(falQueueResponseUrl(ID)).toBe(
      `${FAL_QUEUE_BASE_URL}/${MINIMAX_H3_MAX_MODEL_ID}/requests/${ID}/response`,
    );
  });

  it("never appends a logs query parameter", () => {
    // Provider log text is outside the approved audit surface and may contain
    // anything the model was given, including the customer's prompt.
    expect(falQueueStatusUrl(ID)).not.toContain("logs");
    expect(falQueueStatusUrl(ID)).not.toContain("?");
  });

  it("targets fal's queue host and nothing else", () => {
    for (const url of [falQueueStatusUrl(ID), falQueueResponseUrl(ID)]) {
      expect(new URL(url).origin).toBe("https://queue.fal.run");
    }
  });

  it("takes no model argument at all", () => {
    // The signature is the guarantee: there is no parameter through which a
    // persisted `providerModelId` could become part of the path.
    expect(falQueueStatusUrl.length).toBe(1);
    expect(falQueueResponseUrl.length).toBe(1);
  });
});
