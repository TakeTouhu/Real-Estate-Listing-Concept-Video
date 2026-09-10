import { describe, expect, it } from "vitest";
import {
  isWellFormedPollObservation,
  REDACTED_LOCATOR,
  TransientProviderOutputLocator,
  type ProviderPollObservation,
  type ProviderStatusLookupRef,
} from "@app/domain";
import { MINIMAX_H3_MAX_MODEL_ID } from "../catalog";
import { ProviderErrorException } from "../errors";
import type { HttpClient, HttpRequest, HttpResponse } from "../http";
import { FAL_QUEUE_BASE_URL } from "./h3-max-mapping";
import { FAL_QUEUE_ERROR_TYPES, type FalQueueErrorType } from "./queue-status-mapping";
import { FalQueueCompletionStatusSource } from "./queue-status-source";

/**
 * The fal status adapter against a transport that only ever answers from a
 * script.
 *
 * Every test counts requests as well as reading the answer, because half of
 * this phase's contract is about calls that must *not* happen: a second status
 * request, a result request for a running job, a retry after a timeout, any
 * request at all when the identity is wrong. An assertion about the return
 * value alone would pass for all of those.
 */

const CREDENTIAL = "fal-key-do-not-log-me-0000";
const REQUEST_ID = "764cabcf-b745-4b3e-ae38-1200304cf45b";
const OUTPUT_URL = "https://fal.media/files/panda/abc.mp4?X-Fal-Signature=SECRETSIGNATURE";

const STATUS_URL = `${FAL_QUEUE_BASE_URL}/${MINIMAX_H3_MAX_MODEL_ID}/requests/${REQUEST_ID}/status`;
const RESPONSE_URL = `${FAL_QUEUE_BASE_URL}/${MINIMAX_H3_MAX_MODEL_ID}/requests/${REQUEST_ID}/response`;

function ref(overrides: Partial<ProviderStatusLookupRef> = {}): ProviderStatusLookupRef {
  return {
    providerName: "fal",
    providerModelId: MINIMAX_H3_MAX_MODEL_ID,
    providerPredictionId: REQUEST_ID,
    ...overrides,
  };
}

type Answer = HttpResponse | (() => never) | (() => Promise<never>);

/**
 * A transport that records every request and answers from a queue.
 *
 * It throws if asked for more answers than the script holds, which is what
 * turns "at most one status request" into something a test can fail on rather
 * than something a reviewer has to notice.
 */
function transport(...answers: readonly Answer[]): HttpClient & {
  readonly sent: HttpRequest[];
} {
  const sent: HttpRequest[] = [];
  let index = 0;
  return {
    sent,
    async request(req) {
      sent.push(req);
      const answer = answers[index++];
      if (answer === undefined) {
        throw new Error(`unscripted request ${index}: ${req.method} ${req.url}`);
      }
      if (typeof answer === "function") return answer();
      return answer;
    },
  };
}

function ok(body: unknown): HttpResponse {
  return { status: 200, body: JSON.stringify(body) };
}

function source(
  http: HttpClient,
  credential = CREDENTIAL,
): FalQueueCompletionStatusSource {
  return new FalQueueCompletionStatusSource({ credential }, { http });
}

function thrower(error: unknown): () => never {
  return () => {
    throw error;
  };
}

function abortError(): Error {
  const error = new Error("The operation was aborted due to timeout");
  error.name = "AbortError";
  return error;
}

/** The error a call rejected with, proving it rejected at all. */
async function rejection(promise: Promise<unknown>): Promise<ProviderErrorException> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ProviderErrorException) return error;
    throw new Error(`expected a ProviderErrorException, got ${String(error)}`);
  }
  throw new Error("expected the poll to reject");
}

describe("local refusals happen before any HTTP", () => {
  it.each([
    ["an unsupported provider", ref({ providerName: "wavespeed" }), "FAL_STATUS_UNSUPPORTED_PROVIDER"],
    ["a differently-cased provider", ref({ providerName: "FAL" }), "FAL_STATUS_UNSUPPORTED_PROVIDER"],
    ["a padded provider", ref({ providerName: " fal " }), "FAL_STATUS_UNSUPPORTED_PROVIDER"],
    ["an empty provider", ref({ providerName: "" }), "FAL_STATUS_UNSUPPORTED_PROVIDER"],
    ["an unsupported model", ref({ providerModelId: "minimax/h3-2k/image-to-video" }), "FAL_UNSUPPORTED_MODEL"],
    ["a Veo model", ref({ providerModelId: "google/veo-3.1/image-to-video" }), "FAL_UNSUPPORTED_MODEL"],
    ["an empty model", ref({ providerModelId: "" }), "FAL_UNSUPPORTED_MODEL"],
    ["a blank prediction id", ref({ providerPredictionId: "   " }), "FAL_STATUS_REQUEST_ID_UNUSABLE"],
    ["an empty prediction id", ref({ providerPredictionId: "" }), "FAL_STATUS_REQUEST_ID_UNUSABLE"],
    ["a traversal prediction id", ref({ providerPredictionId: ".." }), "FAL_STATUS_REQUEST_ID_UNUSABLE"],
  ])("refuses %s with zero requests", async (_label, lookup, code) => {
    const http = transport();
    const failure = await rejection(source(http).poll(lookup));
    expect(failure.error.code).toBe(code);
    expect(http.sent).toEqual([]);
  });

  it("refuses a blank credential with zero requests", async () => {
    const http = transport();
    const failure = await rejection(source(http, "   ").poll(ref()));
    expect(failure.error.code).toBe("FAL_MISSING_CREDENTIAL");
    expect(http.sent).toEqual([]);
  });

  it("checks the model before the credential, so neither leaks through the other", async () => {
    const http = transport();
    const failure = await rejection(
      source(http, "").poll(ref({ providerModelId: "someone/else" })),
    );
    expect(failure.error.code).toBe("FAL_UNSUPPORTED_MODEL");
    expect(http.sent).toEqual([]);
  });

  it("never substitutes a supported model for an unsupported one", async () => {
    const http = transport(ok({ status: "COMPLETED" }));
    await rejection(source(http).poll(ref({ providerModelId: "minimax/h3-2k/image-to-video" })));
    // Silently polling H3 Max about an H3 2K prediction would ask the right
    // vendor the wrong question and believe the answer.
    expect(http.sent).toEqual([]);
  });
});

describe("the status request itself", () => {
  it("is exactly one authenticated GET against the derived resource", async () => {
    const http = transport(ok({ status: "IN_QUEUE" }));
    await source(http).poll(ref());

    expect(http.sent).toHaveLength(1);
    const sent = http.sent[0]!;
    expect(sent.method).toBe("GET");
    expect(sent.url).toBe(STATUS_URL);
    expect(sent.headers).toEqual({ Authorization: `Key ${CREDENTIAL}` });
    expect(sent.body).toBeUndefined();
    expect(sent.redirect).toBe("manual");
    expect(typeof sent.timeoutMs).toBe("number");
  });

  it("requests no logs", async () => {
    const http = transport(ok({ status: "IN_PROGRESS" }));
    await source(http).poll(ref());
    expect(http.sent[0]!.url).not.toContain("logs");
    expect(http.sent[0]!.url).not.toContain("?");
  });

  it("sends nothing about the customer, the prompt or the price", async () => {
    const http = transport(ok({ status: "IN_QUEUE" }));
    await source(http).poll(ref());
    const sent = http.sent[0]!;

    // Stated as an exhaustive allowlist rather than a substring hunt: the
    // request is *only* these fields, so there is no channel through which an
    // organization id, a prompt, a source image or a price could travel — and
    // adding one to the adapter fails here rather than passing unnoticed.
    expect(Object.getOwnPropertyNames(sent).sort()).toEqual([
      "headers",
      "method",
      "redirect",
      "timeoutMs",
      "url",
    ]);
    expect(Object.getOwnPropertyNames(sent.headers)).toEqual(["Authorization"]);
    expect(sent.body).toBeUndefined();
    // The only variable part of the URL is the request id fal itself issued.
    expect(sent.url).toBe(STATUS_URL);
  });

  it("encodes a hostile request id into the path rather than letting it steer", async () => {
    const http = transport(ok({ status: "IN_QUEUE" }));
    await source(http).poll(ref({ providerPredictionId: "abc/../../v1/other" }));

    const url = new URL(http.sent[0]!.url);
    expect(url.origin).toBe("https://queue.fal.run");
    expect(url.pathname).toBe(
      `/${MINIMAX_H3_MAX_MODEL_ID}/requests/abc%2F..%2F..%2Fv1%2Fother/status`,
    );
    // The route structure is intact: the model, `requests`, and `status` are
    // still where they belong, and the id is one segment between them.
    expect(url.pathname.split("/").at(-1)).toBe("status");
    expect(url.search).toBe("");
  });

  it("cannot be steered to another host by the request id", async () => {
    const http = transport(ok({ status: "IN_QUEUE" }));
    await source(http).poll(ref({ providerPredictionId: "https://attacker.example/x" }));
    expect(new URL(http.sent[0]!.url).origin).toBe("https://queue.fal.run");
  });
});

describe("still-running answers", () => {
  it.each(["IN_QUEUE", "IN_PROGRESS"])("maps %s to IN_PROGRESS with one request", async (status) => {
    const http = transport(ok({ status, queue_position: 4, logs: ["x"], metrics: { t: 1 } }));
    const observation = await source(http).poll(ref());

    expect(observation).toEqual({ kind: "IN_PROGRESS" });
    // No result request. The artifact does not exist yet, and asking for it
    // would be a second call per poll for a body that cannot be there.
    expect(http.sent).toHaveLength(1);
    expect(http.sent[0]!.url).toBe(STATUS_URL);
  });

  it("returns an object with no fields beyond the discriminant", async () => {
    const http = transport(ok({ status: "IN_PROGRESS", queue_position: 9 }));
    const observation = await source(http).poll(ref());
    expect(Object.getOwnPropertyNames(observation)).toEqual(["kind"]);
  });
});

describe("completed success with a usable output location", () => {
  it("returns SUCCEEDED with a nominal locator after exactly two requests", async () => {
    const http = transport(ok({ status: "COMPLETED" }), ok({ video: { url: OUTPUT_URL } }));
    const observation = await source(http).poll(ref());

    expect(observation.kind).toBe("SUCCEEDED");
    if (observation.kind !== "SUCCEEDED") throw new Error("unreachable");
    expect(TransientProviderOutputLocator.isLocator(observation.outputLocator)).toBe(true);

    expect(http.sent.map((r) => r.url)).toEqual([STATUS_URL, RESPONSE_URL]);
    expect(http.sent.every((r) => r.method === "GET")).toBe(true);
    expect(http.sent.every((r) => r.body === undefined)).toBe(true);
    expect(http.sent.every((r) => r.redirect === "manual")).toBe(true);
  });

  it("uses the same credential on the result request", async () => {
    const http = transport(ok({ status: "COMPLETED" }), ok({ video: { url: OUTPUT_URL } }));
    await source(http).poll(ref());
    expect(http.sent[1]!.headers).toEqual({ Authorization: `Key ${CREDENTIAL}` });
  });

  it("carries the exact provider URL inside the locator, and only inside it", async () => {
    const http = transport(ok({ status: "COMPLETED" }), ok({ video: { url: OUTPUT_URL } }));
    const observation = await source(http).poll(ref());
    if (observation.kind !== "SUCCEEDED" || observation.outputLocator === null) {
      throw new Error("expected a locator");
    }

    const expected = TransientProviderOutputLocator.fromUnknown(OUTPUT_URL);
    if (!expected.ok) throw new Error("fixture");
    // Equality without disclosure: the value is right, and reading it back is
    // still not something this type offers.
    expect(observation.outputLocator.equals(expected.value)).toBe(true);
    expect(String(observation.outputLocator)).toBe(REDACTED_LOCATOR);
    expect(JSON.stringify(observation)).not.toContain("SECRETSIGNATURE");
    expect(JSON.stringify(observation)).not.toContain("fal.media");
  });

  it("returns the locator as an object, never as a raw string", async () => {
    const http = transport(ok({ status: "COMPLETED" }), ok({ video: { url: OUTPUT_URL } }));
    const observation = await source(http).poll(ref());
    if (observation.kind !== "SUCCEEDED") throw new Error("unreachable");
    expect(typeof observation.outputLocator).toBe("object");
  });

  it("ignores every result field except video.url", async () => {
    const http = transport(
      ok({ status: "COMPLETED" }),
      ok({
        video: {
          url: OUTPUT_URL,
          content_type: "video/mp4",
          file_name: "abc.mp4",
          file_size: 4_194_304,
        },
        expanded_prompt: "a sunlit living room, golden hour",
        timings: { inference: 41.2 },
        logs: ["loading weights"],
      }),
    );
    const observation = await source(http).poll(ref());
    expect(Object.getOwnPropertyNames(observation)).toEqual(["kind", "outputLocator"]);
  });
});

describe("completed success where the location cannot be acquired", () => {
  const CASES: readonly [string, Answer][] = [
    ["the result request throws", thrower(new Error("ECONNRESET reading https://fal.media"))],
    ["the result request times out", thrower(abortError())],
    ["the result returns 404", { status: 404, body: "" }],
    ["the result returns 401", { status: 401, body: "" }],
    ["the result returns 500", { status: 500, body: "" }],
    ["the result returns a 302", { status: 302, body: "" }],
    ["the result body is not JSON", { status: 200, body: "<html>gateway</html>" }],
    ["the result body is null", { status: 200, body: "null" }],
    ["the result body is an array", { status: 200, body: "[]" }],
    ["the result omits video", { status: 200, body: JSON.stringify({ seed: 1 }) }],
    ["video is a string", { status: 200, body: JSON.stringify({ video: OUTPUT_URL }) }],
    ["video omits url", { status: 200, body: JSON.stringify({ video: { file_name: "x.mp4" } }) }],
    ["video.url is null", { status: 200, body: JSON.stringify({ video: { url: null } }) }],
    ["video.url is a number", { status: 200, body: JSON.stringify({ video: { url: 42 } }) }],
    ["video.url is blank", { status: 200, body: JSON.stringify({ video: { url: "   " } }) }],
  ];

  it.each(CASES)("records provider success anyway when %s", async (_label, answer) => {
    const http = transport(ok({ status: "COMPLETED" }), answer);
    const observation = await source(http).poll(ref());

    // The render happened and fal will bill for it. Output acquisition is a
    // separate fact with a separate owner, and it may never suppress this one.
    expect(observation).toEqual({ kind: "SUCCEEDED", outputLocator: null });
    expect(http.sent).toHaveLength(2);
  });

  it.each(CASES)("neither throws nor reports failure when %s", async (_label, answer) => {
    const http = transport(ok({ status: "COMPLETED" }), answer);
    const observation = await source(http).poll(ref());
    expect(observation.kind).not.toBe("FAILED");
  });

  it("does not retry the result request", async () => {
    const http = transport(ok({ status: "COMPLETED" }), { status: 503, body: "" });
    await source(http).poll(ref());
    expect(http.sent.filter((r) => r.url === RESPONSE_URL)).toHaveLength(1);
  });

  it("does not re-request the status after a failed result fetch", async () => {
    const http = transport(ok({ status: "COMPLETED" }), { status: 503, body: "" });
    await source(http).poll(ref());
    expect(http.sent.filter((r) => r.url === STATUS_URL)).toHaveLength(1);
  });
});

describe("completed failure", () => {
  it.each([...FAL_QUEUE_ERROR_TYPES])(
    "maps %s to FAILED without fetching a result",
    async (errorType) => {
      const http = transport(
        ok({ status: "COMPLETED", error: "a human sentence", error_type: errorType }),
      );
      const observation = await source(http).poll(ref());

      expect(observation.kind).toBe("FAILED");
      expect(http.sent).toHaveLength(1);
    },
  );

  it.each([
    ["request_timeout", true, "TIMEOUT"],
    ["startup_timeout", true, "TIMEOUT"],
    ["runner_scheduling_failure", true, null],
    ["runner_connection_timeout", true, "CONNECTION_RESET"],
    ["runner_disconnected", true, "CONNECTION_RESET"],
    ["runner_connection_refused", true, "CONNECTION_RESET"],
    ["runner_connection_error", true, "CONNECTION_RESET"],
    ["runner_incomplete_response", true, "CONNECTION_RESET"],
    ["runner_server_error", true, null],
    ["internal_error", true, null],
    ["client_disconnected", false, null],
    ["client_cancelled", false, null],
    ["bad_request", false, "LOCAL_CONFIGURATION"],
  ] as const)("reports %s as retryable=%s diagnostic=%s", async (errorType, retryable, code) => {
    const http = transport(ok({ status: "COMPLETED", error_type: errorType }));
    const observation = await source(http).poll(ref());
    expect(observation).toEqual({ kind: "FAILED", retryable, diagnosticCode: code });
  });

  it("never lets the fal error type reach the observation", async () => {
    for (const errorType of FAL_QUEUE_ERROR_TYPES) {
      const http = transport(ok({ status: "COMPLETED", error_type: errorType }));
      const observation = await source(http).poll(ref());
      expect(JSON.stringify(observation)).not.toContain(errorType);
    }
  });

  it("never lets the human-readable error reach the observation", async () => {
    const http = transport(
      ok({
        status: "COMPLETED",
        error: "CUDA OOM at /opt/weights/secret.safetensors while rendering 'a sunlit living room'",
        error_type: "runner_server_error",
      }),
    );
    const observation = await source(http).poll(ref());
    const serialized = JSON.stringify(observation);
    for (const fragment of ["CUDA", "safetensors", "sunlit", "opt/weights"]) {
      expect(serialized).not.toContain(fragment);
    }
  });

  it("classifies from error_type even when the prose names a different type", async () => {
    const http = transport(
      ok({
        status: "COMPLETED",
        error: "bad_request: your prompt was rejected",
        error_type: "runner_disconnected",
      }),
    );
    const observation = await source(http).poll(ref());
    // Prose says terminal, machine-readable says retryable. The prose is never
    // consulted, so the answer follows `error_type`.
    expect(observation).toEqual({
      kind: "FAILED",
      retryable: true,
      diagnosticCode: "CONNECTION_RESET",
    });
  });

  it("does not classify from the HTTP status", async () => {
    // A 200 carrying a terminal failure and a 200 carrying a retryable one are
    // the same exchange. Only `error_type` separates them.
    const terminal = transport(ok({ status: "COMPLETED", error_type: "bad_request" }));
    const retryable = transport(ok({ status: "COMPLETED", error_type: "internal_error" }));
    const a = await source(terminal).poll(ref());
    const b = await source(retryable).poll(ref());
    expect(a).not.toEqual(b);
    expect(terminal.sent[0]!.url).toBe(retryable.sent[0]!.url);
  });
});

describe("failures this adapter refuses to classify", () => {
  it.each([
    ["an unknown error type", { status: "COMPLETED", error_type: "runner_evaporated" }],
    ["a blank error type", { status: "COMPLETED", error: "x", error_type: "" }],
    ["a numeric error type", { status: "COMPLETED", error_type: 500 }],
    ["an object error type", { status: "COMPLETED", error_type: { code: "bad_request" } }],
    ["only a human-readable error", { status: "COMPLETED", error: "Internal Server Error" }],
  ])("throws rather than guessing for %s", async (_label, body) => {
    const http = transport(ok(body));
    const failure = await rejection(source(http).poll(ref()));

    expect(failure.error.code).toBe("FAL_STATUS_FAILURE_UNCLASSIFIED");
    // No result request: nothing is known to have been produced.
    expect(http.sent).toHaveLength(1);
  });

  it("puts no part of the unrecognized failure into the thrown error", async () => {
    const http = transport(
      ok({
        status: "COMPLETED",
        error: "billing account 4242424242424242 suspended",
        error_type: "runner_evaporated_at_0314",
      }),
    );
    const failure = await rejection(source(http).poll(ref()));
    const surfaces = [
      failure.message,
      failure.error.messageSanitized,
      failure.error.code,
      JSON.stringify(failure.error),
    ];
    for (const surface of surfaces) {
      for (const fragment of ["runner_evaporated", "4242", "billing account"]) {
        expect(surface).not.toContain(fragment);
      }
    }
  });

  it("is not retryable, so nothing reads the refusal as an instruction to spend again", async () => {
    const http = transport(ok({ status: "COMPLETED", error_type: "unknown_to_us" }));
    const failure = await rejection(source(http).poll(ref()));
    expect(failure.error.retryable).toBe(false);
  });
});

describe("status transport and body failures", () => {
  it.each([
    ["a thrown network error", thrower(new Error("ECONNREFUSED 1.2.3.4:443")), "FAL_STATUS_NETWORK_ERROR"],
    ["an abort", thrower(abortError()), "FAL_STATUS_TIMEOUT"],
    ["a thrown string", thrower("boom"), "FAL_STATUS_NETWORK_ERROR"],
    ["a thrown null", thrower(null), "FAL_STATUS_NETWORK_ERROR"],
  ])("throws %s as a status-source failure", async (_label, answer, code) => {
    const http = transport(answer);
    const failure = await rejection(source(http).poll(ref()));
    expect(failure.error.code).toBe(code);
    expect(http.sent).toHaveLength(1);
  });

  it.each([400, 401, 403, 404, 429, 500, 502, 503, 301, 302, 307])(
    "throws on HTTP %s rather than reporting a provider failure",
    async (status) => {
      const http = transport({ status, body: JSON.stringify({ detail: "nope" }) });
      const failure = await rejection(source(http).poll(ref()));
      // The application did not learn what fal did. Recording a provider
      // failure here would convert a gateway hiccup into a terminal state for a
      // paid render.
      expect(failure.error.code).toBe("FAL_HTTP_ERROR");
      expect(http.sent).toHaveLength(1);
    },
  );

  it.each([
    ["not JSON", "<html>502 Bad Gateway</html>"],
    ["null", "null"],
    ["an array", "[]"],
    ["a bare string", '"COMPLETED"'],
    ["a number", "200"],
    ["an object with no status", '{"error_type":"bad_request"}'],
    ["a non-string status", '{"status":200}'],
    ["an unpublished status", '{"status":"CANCELLED"}'],
    ["a lowercased status", '{"status":"completed"}'],
  ])("throws when the 2xx body is %s", async (_label, body) => {
    const http = transport({ status: 200, body });
    const failure = await rejection(source(http).poll(ref()));
    expect(failure.error.code).toBe("FAL_STATUS_RESPONSE_UNREADABLE");
    expect(http.sent).toHaveLength(1);
  });

  it("never puts the status body or URL into the thrown error", async () => {
    const http = transport({
      status: 403,
      body: JSON.stringify({ detail: "key fal-key-do-not-log-me-0000 is not authorized" }),
    });
    const failure = await rejection(source(http).poll(ref()));
    const surfaces = [failure.message, failure.error.messageSanitized, JSON.stringify(failure.error)];
    for (const surface of surfaces) {
      expect(surface).not.toContain(CREDENTIAL);
      expect(surface).not.toContain("queue.fal.run");
      expect(surface).not.toContain(REQUEST_ID);
    }
  });

  it("does not retry a thrown status request", async () => {
    const http = transport(thrower(abortError()));
    await rejection(source(http).poll(ref()));
    // Repetition belongs to Phase 2H-2's bounded batch cadence, which is
    // audited and interruptible. A retry here would be neither.
    expect(http.sent).toHaveLength(1);
  });
});

describe("provider-supplied URLs are never routing authority", () => {
  it("ignores response_url, status_url and cancel_url on the status body", async () => {
    const http = transport(
      ok({
        status: "COMPLETED",
        response_url: "https://attacker.example/response",
        status_url: "https://attacker.example/status",
        cancel_url: "https://attacker.example/cancel",
      }),
      ok({ video: { url: OUTPUT_URL } }),
    );
    await source(http).poll(ref());

    expect(http.sent.map((r) => r.url)).toEqual([STATUS_URL, RESPONSE_URL]);
    for (const sent of http.sent) {
      expect(new URL(sent.url).origin).toBe("https://queue.fal.run");
      expect(sent.url).not.toContain("attacker.example");
    }
  });

  it("derives the result resource even when fal offers one", async () => {
    const http = transport(
      ok({ status: "COMPLETED", response_url: `${FAL_QUEUE_BASE_URL}/other/model/requests/x/response` }),
      ok({ video: { url: OUTPUT_URL } }),
    );
    await source(http).poll(ref());
    // Same host, different model — still not followed. A provider-chosen path
    // is provider-chosen authority regardless of where it points today.
    expect(http.sent[1]!.url).toBe(RESPONSE_URL);
  });

  it("never follows redirects on either call", async () => {
    const http = transport(ok({ status: "COMPLETED" }), ok({ video: { url: OUTPUT_URL } }));
    await source(http).poll(ref());
    // A followed 3xx would re-send `Authorization: Key …` to whatever host the
    // redirect named, letting fal's response choose our credential's audience.
    expect(http.sent.map((r) => r.redirect)).toEqual(["manual", "manual"]);
  });
});

describe("every answer satisfies the Phase 2H-2 contract", () => {
  const SCRIPTS: readonly [string, readonly Answer[]][] = [
    ["in queue", [ok({ status: "IN_QUEUE" })]],
    ["in progress", [ok({ status: "IN_PROGRESS" })]],
    ["success with a locator", [ok({ status: "COMPLETED" }), ok({ video: { url: OUTPUT_URL } })]],
    ["success without a locator", [ok({ status: "COMPLETED" }), { status: 404, body: "" }]],
    ...FAL_QUEUE_ERROR_TYPES.map(
      (t: FalQueueErrorType): [string, readonly Answer[]] => [
        `failure ${t}`,
        [ok({ status: "COMPLETED", error_type: t })],
      ],
    ),
  ];

  it.each(SCRIPTS)("returns a well-formed observation for %s", async (_label, answers) => {
    const http = transport(...answers);
    const observation: ProviderPollObservation = await source(http).poll(ref());
    // The runner validates with exactly this predicate before acting. An
    // adapter whose output fails it produces STATUS_OBSERVATION_MALFORMED and
    // no state change at all.
    expect(isWellFormedPollObservation(observation)).toBe(true);
  });

  it.each(SCRIPTS)("returns no fal-specific fields for %s", async (_label, answers) => {
    const http = transport(...answers);
    const observation = await source(http).poll(ref());
    const keys = Object.getOwnPropertyNames(observation);
    for (const banned of [
      "status",
      "error",
      "error_type",
      "logs",
      "metrics",
      "queue_position",
      "response_url",
      "status_url",
      "url",
    ]) {
      expect(keys).not.toContain(banned);
    }
  });

  it("never serializes the credential into any answer", async () => {
    for (const [, answers] of SCRIPTS) {
      const http = transport(...answers);
      const observation = await source(http).poll(ref());
      expect(JSON.stringify(observation)).not.toContain(CREDENTIAL);
    }
  });
});
