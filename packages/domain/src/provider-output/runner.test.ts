import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sanitizeTransitionMetadata } from "../orchestration/transition-metadata";
import type { TransitionContext } from "../orchestration/ports";
import { managedGenerationOutputKey } from "../completion/output";
import type { ProviderCompletionService } from "../completion/service";
import { TransientProviderOutputLocator } from "./locator";
import type {
  ProviderOutputDeps,
  ProviderOutputRunResult,
  ProviderPollingContext,
  ProviderStatusLookupRef,
} from "./ports";
import { createProviderOutputRunner } from "./runner";

/**
 * What one run does, at the seams a database cannot reach: which order the
 * operations happen in, what the status source is told, what happens when
 * something external misbehaves, and what never leaves the process.
 *
 * Phase 2H-1's service is faked here so its answers can be dictated. That is the
 * point of the split: this file tests *orchestration decisions*, and the live
 * database suite tests that those decisions land correctly on real rows.
 */

const ORG = "org_po";
const ATTEMPT = "sgen_po";
const RAW_URL = "https://provider.example/outputs/x.mp4?X-Amz-Signature=SECRETSIG";

const CONTEXT: TransitionContext = {
  actorType: "SYSTEM",
  actorUserId: null,
  correlationId: "corr_po",
  causationId: null,
  reasonCode: null,
  eventType: "TEST",
  metadata: sanitizeTransitionMetadata({}),
};

function locator(raw = RAW_URL): TransientProviderOutputLocator {
  const built = TransientProviderOutputLocator.fromUnknown(raw);
  if (!built.ok) throw new Error("fixture");
  return built.value;
}

function context(overrides: Partial<ProviderPollingContext> = {}): ProviderPollingContext {
  return {
    organizationId: ORG,
    attemptId: ATTEMPT,
    orchestrationState: "PROCESSING",
    submissionCertainty: "ACCEPTED",
    providerName: "wavespeed",
    providerModelId: "wavespeed-ai/open-video/image-to-video",
    providerPredictionId: "pred_persisted",
    ...overrides,
  };
}

type CompletionAnswers = {
  record?: { kind: string; [k: string]: unknown };
  begin?: { kind: string; [k: string]: unknown };
  finalize?: { kind: string; [k: string]: unknown };
};

interface HarnessOptions {
  readonly context?: ProviderPollingContext | null;
  readonly poll?: (ref: ProviderStatusLookupRef) => Promise<unknown>;
  readonly transferResult?: () => Promise<unknown>;
  readonly answers?: CompletionAnswers;
  readonly candidates?: Record<string, readonly { organizationId: string; attemptId: string }[]>;
}

function harness(options: HarnessOptions = {}) {
  const order: string[] = [];
  const polledWith: ProviderStatusLookupRef[] = [];
  const transferredWith: { source: TransientProviderOutputLocator; destinationKey: string }[] = [];
  const completionCalls: { op: string; input: Record<string, unknown> }[] = [];

  const answer = (op: keyof CompletionAnswers, fallback: Record<string, unknown>) =>
    (options.answers?.[op] ?? fallback) as never;

  const completion = {
    async recordProviderCompletion(input: Record<string, unknown>) {
      order.push("record");
      completionCalls.push({ op: "record", input });
      return answer("record", { kind: "APPLIED", attemptId: ATTEMPT, stateVersion: 2 });
    },
    async beginOutputIngestion(input: Record<string, unknown>) {
      order.push("begin");
      completionCalls.push({ op: "begin", input });
      return answer("begin", { kind: "APPLIED", attemptId: ATTEMPT, stateVersion: 3 });
    },
    async finalizeOutputVerification(input: Record<string, unknown>) {
      order.push("finalize");
      completionCalls.push({ op: "finalize", input });
      return answer("finalize", {
        kind: "APPLIED",
        attemptId: ATTEMPT,
        stateVersion: 4,
        outputStorageKey: "k",
        outputVerifiedAt: 1,
      });
    },
  } as unknown as ProviderCompletionService;

  const deps: ProviderOutputDeps = {
    polling: {
      async loadPollingContext() {
        order.push("load");
        return options.context === undefined ? context() : options.context;
      },
      async findOrchestrationCandidates({ stage }) {
        order.push(`discover:${stage}`);
        return options.candidates?.[stage] ?? [];
      },
    },
    statusSource: {
      async poll(ref) {
        order.push("poll");
        polledWith.push(ref);
        if (options.poll !== undefined) return options.poll(ref);
        return { kind: "IN_PROGRESS" };
      },
    },
    transfer: {
      async transferAndVerify(input) {
        order.push("transfer");
        transferredWith.push(input);
        if (options.transferResult !== undefined) return options.transferResult();
        return { kind: "VERIFIED", receipt: { sha256: "a".repeat(64), sizeBytes: 1024 } };
      },
    },
    completion,
  };

  return {
    order,
    polledWith,
    transferredWith,
    completionCalls,
    runner: createProviderOutputRunner(deps),
  };
}

const run = (h: ReturnType<typeof harness>): Promise<ProviderOutputRunResult> =>
  h.runner.runProviderOutputAttemptOnce({
    organizationId: ORG,
    attemptId: ATTEMPT,
    context: CONTEXT,
  });

describe("the attempt decides which provider is asked", () => {
  it("presents exactly the persisted provider, model and prediction", async () => {
    const h = harness();
    await run(h);
    expect(h.polledWith).toEqual([
      {
        providerName: "wavespeed",
        providerModelId: "wavespeed-ai/open-video/image-to-video",
        providerPredictionId: "pred_persisted",
      },
    ]);
  });

  it("keeps presenting the persisted identity when it is not today's default", async () => {
    // The whole point. An attempt admitted against one vendor holds a prediction
    // id only that vendor issued; asking today's default about it is a lookup
    // that either fails or, worse, succeeds against something unrelated.
    const h = harness({
      context: context({
        providerName: "some-retired-provider",
        providerModelId: "retired/model-v1",
        providerPredictionId: "pred_old",
      }),
    });
    await run(h);
    expect(h.polledWith[0]).toEqual({
      providerName: "some-retired-provider",
      providerModelId: "retired/model-v1",
      providerPredictionId: "pred_old",
    });
  });

  it("tells the status source nothing about the customer", async () => {
    const h = harness();
    await run(h);
    const keys = Object.keys(h.polledWith[0] ?? {}).sort();
    expect(keys).toEqual(["providerModelId", "providerName", "providerPredictionId"]);
    for (const forbidden of [
      "organizationId",
      "attemptId",
      "prompt",
      "assetId",
      "requestHash",
      "pricingSnapshotId",
    ]) {
      expect(keys).not.toContain(forbidden);
    }
  });

  it("reads no environment or catalog default anywhere in the module", () => {
    // Comments are stripped first, deliberately. The claim under test is about
    // what the code *does*, and `ports.ts` explains at length why current
    // defaults must never be consulted — prose documenting a prohibition must
    // not read as evidence of the thing it prohibits.
    const dir = __dirname;
    for (const name of readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.includes(".test."))) {
      const text = readFileSync(join(dir, name), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, " ")
        .replace(/\/\/[^\n]*/g, " ");
      for (const banned of [
        "process.env",
        "VIDEO_PROVIDER",
        "loadEnv",
        "createVideoProvider",
        "ProviderPricingCatalog",
        "createProviderPricingCatalog",
        "defaultModel",
        "routingPolicy",
      ]) {
        expect(`${name}:${banned}: ${text.includes(banned)}`).toBe(`${name}:${banned}: false`);
      }
    }
  });

  it.each([
    ["a blank provider name", { providerName: "  " }, "PROVIDER_NAME_BLANK"],
    ["an empty provider name", { providerName: "" }, "PROVIDER_NAME_BLANK"],
    ["a blank model id", { providerModelId: " " }, "PROVIDER_MODEL_ID_BLANK"],
    ["a blank prediction id", { providerPredictionId: "" }, "PROVIDER_PREDICTION_ID_BLANK"],
  ])("refuses %s without calling the status source", async (_l, overrides, reason) => {
    // Answered, not repaired. Substituting today's default asks the wrong vendor
    // about a prediction it never issued; rewriting the row invents history.
    const h = harness({ context: context(overrides) });
    expect(await run(h)).toEqual({ kind: "ATTEMPT_CONTEXT_INVALID", reason });
    expect(h.order).not.toContain("poll");
  });
});

describe("a missing, cross-tenant or legacy attempt", () => {
  it("answers not-found without any external call", async () => {
    const h = harness({ context: null });
    expect(await run(h)).toEqual({ kind: "ATTEMPT_NOT_FOUND" });
    expect(h.order).toEqual(["load"]);
  });
});

describe("an already verified attempt", () => {
  it("does nothing at all", async () => {
    // Zero external I/O and zero mutation. Polling a finished attempt is an
    // outbound request with nothing to learn and a locator to leak.
    const h = harness({ context: context({ orchestrationState: "OUTPUT_VERIFIED" }) });
    expect(await run(h)).toEqual({ kind: "ALREADY_VERIFIED" });
    expect(h.order).toEqual(["load"]);
  });
});

describe("a provider still working", () => {
  it("writes nothing and says so", async () => {
    const h = harness({ poll: async () => ({ kind: "IN_PROGRESS" }) });
    expect(await run(h)).toEqual({ kind: "STILL_PROCESSING" });
    expect(h.completionCalls).toHaveLength(0);
    expect(h.order).toEqual(["load", "poll"]);
  });
});

describe("a status lookup that fails is not a provider failure", () => {
  it.each([
    ["throws", () => Promise.reject(new Error("ECONNRESET https://p.example?sig=SECRET"))],
    ["rejects with a non-error", () => Promise.reject("boom")],
  ])("answers STATUS_SOURCE_FAILED when the source %s", async (_label, poll) => {
    // The distinction that matters: "I could not find out" says nothing about
    // the provider. Recording it as a failure would convert a network blip into
    // a terminal state for a paid render.
    const h = harness({ poll });
    expect(await run(h)).toEqual({ kind: "STATUS_SOURCE_FAILED" });
    expect(h.completionCalls).toHaveLength(0);
  });

  it("never lets the thrown value reach a result", async () => {
    const h = harness({
      poll: () => Promise.reject(new Error(`failed fetching ${RAW_URL}`)),
    });
    const result = await run(h);
    expect(JSON.stringify(result)).not.toContain("SECRETSIG");
    expect(JSON.stringify(result)).not.toContain("provider.example");
    expect(Object.keys(result)).toEqual(["kind"]);
  });

  it.each([
    ["null", null],
    ["a bare string", "SUCCEEDED"],
    ["an array", []],
    ["an unknown kind", { kind: "WHATEVER" }],
    ["IN_PROGRESS with an extra key", { kind: "IN_PROGRESS", progress: 50 }],
    ["SUCCEEDED with a raw string locator", { kind: "SUCCEEDED", outputLocator: RAW_URL }],
    [
      "SUCCEEDED with a provider URL beside a valid locator",
      { kind: "SUCCEEDED", outputLocator: null, providerOutputUrl: RAW_URL },
    ],
    [
      "SUCCEEDED with a raw provider response",
      { kind: "SUCCEEDED", outputLocator: null, rawProviderResponse: { status: 200 } },
    ],
    [
      'FAILED with retryable "false"',
      { kind: "FAILED", retryable: "false", diagnosticCode: null },
    ],
    [
      "FAILED with an invalid diagnostic",
      { kind: "FAILED", retryable: true, diagnosticCode: "NOT_A_CODE" },
    ],
    [
      "FAILED with a provider body",
      { kind: "FAILED", retryable: true, diagnosticCode: null, providerBody: "{}" },
    ],
  ])("answers STATUS_OBSERVATION_MALFORMED for %s", async (_label, value) => {
    const h = harness({ poll: async () => value });
    expect(await run(h)).toEqual({ kind: "STATUS_OBSERVATION_MALFORMED" });
    expect(h.completionCalls).toHaveLength(0);
  });
});

describe("a provider failure, from PROCESSING", () => {
  it("delegates to the completion service with the normalized fields", async () => {
    const h = harness({
      poll: async () => ({ kind: "FAILED", retryable: true, diagnosticCode: null }),
    });
    expect(await run(h)).toEqual({ kind: "PROVIDER_COMPLETION_APPLIED" });
    expect(h.completionCalls).toHaveLength(1);
    expect(h.completionCalls[0]?.input.observation).toEqual({
      kind: "FAILED",
      retryable: true,
      diagnosticCode: null,
    });
  });

  it("reports a replay as a replay", async () => {
    const h = harness({
      poll: async () => ({ kind: "FAILED", retryable: false, diagnosticCode: null }),
      answers: { record: { kind: "REPLAYED", attemptId: ATTEMPT } },
    });
    expect(await run(h)).toEqual({ kind: "PROVIDER_COMPLETION_REPLAYED" });
  });

  it("surfaces a conflict rather than forcing the write", async () => {
    const h = harness({
      poll: async () => ({ kind: "FAILED", retryable: true, diagnosticCode: null }),
      answers: {
        record: { kind: "CONFLICTING_COMPLETION", reason: "COMPLETION_OUTCOME_MISMATCH" },
      },
    });
    expect(await run(h)).toEqual({
      kind: "PROVIDER_REALITY_CONFLICT",
      reason: "COMPLETION_CONFLICT",
    });
  });

  it("never starts ingestion after a failure", async () => {
    const h = harness({
      poll: async () => ({ kind: "FAILED", retryable: true, diagnosticCode: null }),
    });
    await run(h);
    expect(h.order).toEqual(["load", "poll", "record"]);
  });
});

describe("provider truth is recorded before output acquisition matters", () => {
  it("persists success first, then reports the missing locator", async () => {
    // The ordering this phase exists to get right. The provider finished and
    // will bill for it; that fact must not wait on the platform's ability to
    // reach the artifact.
    const h = harness({ poll: async () => ({ kind: "SUCCEEDED", outputLocator: null }) });
    expect(await run(h)).toEqual({ kind: "OUTPUT_LOCATOR_UNAVAILABLE" });
    expect(h.order).toEqual(["load", "poll", "record"]);
    expect(h.completionCalls[0]?.input.observation).toEqual({ kind: "SUCCEEDED" });
  });

  it("does not begin ingestion when there is nothing to ingest", async () => {
    const h = harness({ poll: async () => ({ kind: "SUCCEEDED", outputLocator: null }) });
    await run(h);
    expect(h.order).not.toContain("begin");
    expect(h.order).not.toContain("transfer");
  });

  it("records completion before beginning ingestion, always", async () => {
    const h = harness({ poll: async () => ({ kind: "SUCCEEDED", outputLocator: locator() }) });
    await run(h);
    expect(h.order.indexOf("record")).toBeLessThan(h.order.indexOf("begin"));
    expect(h.order).toEqual(["load", "poll", "record", "begin", "transfer", "finalize"]);
  });
});

describe("claiming ingestion, and who transfers", () => {
  it("transfers when this run won the transition", async () => {
    const h = harness({ poll: async () => ({ kind: "SUCCEEDED", outputLocator: locator() }) });
    expect(await run(h)).toEqual({ kind: "OUTPUT_VERIFIED" });
    expect(h.transferredWith).toHaveLength(1);
  });

  it("does not transfer when another runner won it", async () => {
    // Not a correctness requirement — the key is deterministic and finalization
    // is idempotent — but a duplicate transfer is wasted vendor bandwidth and a
    // storage bill for nothing.
    const h = harness({
      poll: async () => ({ kind: "SUCCEEDED", outputLocator: locator() }),
      answers: { begin: { kind: "ALREADY_INGESTING", attemptId: ATTEMPT } },
    });
    expect(await run(h)).toEqual({ kind: "INGESTION_ALREADY_CLAIMED" });
    expect(h.transferredWith).toHaveLength(0);
  });

  it.each([
    ["ALREADY_VERIFIED", { kind: "ALREADY_VERIFIED", attemptId: ATTEMPT }, { kind: "ALREADY_VERIFIED" }],
    [
      "NOT_INGESTIBLE",
      { kind: "NOT_INGESTIBLE", reason: "PROVIDER_NOT_SUCCEEDED" },
      { kind: "ATTEMPT_NOT_APPLICABLE", reason: "TRANSITION_REFUSED" },
    ],
    ["LOST_CONCURRENCY", { kind: "LOST_CONCURRENCY" }, { kind: "LOST_CONCURRENCY" }],
  ])("maps a %s begin without transferring", async (_l, begin, expected) => {
    const h = harness({
      poll: async () => ({ kind: "SUCCEEDED", outputLocator: locator() }),
      answers: { begin },
    });
    expect(await run(h)).toEqual(expected);
    expect(h.transferredWith).toHaveLength(0);
  });

  it("sends the derived destination key, never a provider-chosen one", async () => {
    const h = harness({ poll: async () => ({ kind: "SUCCEEDED", outputLocator: locator() }) });
    await run(h);
    expect(h.transferredWith[0]?.destinationKey).toBe(
      managedGenerationOutputKey({ organizationId: ORG, attemptId: ATTEMPT }),
    );
    expect(Object.keys(h.transferredWith[0] ?? {}).sort()).toEqual([
      "destinationKey",
      "source",
    ]);
  });

  it("hands the transfer port the very locator the source produced", async () => {
    const produced = locator();
    const h = harness({ poll: async () => ({ kind: "SUCCEEDED", outputLocator: produced }) });
    await run(h);
    expect(h.transferredWith[0]?.source.equals(produced)).toBe(true);
  });
});

describe("a transfer that fails is not a provider failure", () => {
  it("leaves the attempt ingesting when the port reports a transient problem", async () => {
    const h = harness({
      poll: async () => ({ kind: "SUCCEEDED", outputLocator: locator() }),
      transferResult: async () => ({ kind: "RETRYABLE_FAILURE" }),
    });
    expect(await run(h)).toEqual({ kind: "TRANSFER_RETRYABLE_FAILURE" });
    // No finalization, and — crucially — no provider-completion write. The
    // provider rendered the video; the platform's storage had a bad minute.
    expect(h.order).toEqual(["load", "poll", "record", "begin", "transfer"]);
  });

  it("leaves the attempt ingesting when the port throws", async () => {
    const h = harness({
      poll: async () => ({ kind: "SUCCEEDED", outputLocator: locator() }),
      transferResult: () => Promise.reject(new Error(`upload failed for ${RAW_URL}`)),
    });
    const result = await run(h);
    expect(result).toEqual({ kind: "TRANSFER_SOURCE_FAILED" });
    expect(JSON.stringify(result)).not.toContain("SECRETSIG");
  });

  it("never records a provider failure on any transfer path", async () => {
    for (const transferResult of [
      async () => ({ kind: "RETRYABLE_FAILURE" }),
      () => Promise.reject(new Error("boom")),
      async () => ({ kind: "NONSENSE" }),
    ]) {
      const h = harness({
        poll: async () => ({ kind: "SUCCEEDED", outputLocator: locator() }),
        transferResult,
      });
      await run(h);
      const recorded = h.completionCalls.filter((c) => c.op === "record");
      expect(recorded).toHaveLength(1);
      expect(recorded[0]?.input.observation).toEqual({ kind: "SUCCEEDED" });
    }
  });

  it.each([
    ["null", null],
    ["an array", []],
    ["an unknown kind", { kind: "TERMINAL_FAILURE" }],
    ["VERIFIED with no receipt", { kind: "VERIFIED" }],
    [
      "VERIFIED with a provider URL",
      { kind: "VERIFIED", receipt: {}, providerOutputUrl: RAW_URL },
    ],
    ["VERIFIED with a raw response", { kind: "VERIFIED", receipt: {}, rawResponse: "{}" }],
    ["RETRYABLE_FAILURE with a message", { kind: "RETRYABLE_FAILURE", message: "disk full" }],
    ["RETRYABLE_FAILURE with a URL", { kind: "RETRYABLE_FAILURE", url: RAW_URL }],
  ])("answers TRANSFER_OUTCOME_MALFORMED for %s", async (_label, value) => {
    const h = harness({
      poll: async () => ({ kind: "SUCCEEDED", outputLocator: locator() }),
      transferResult: async () => value,
    });
    expect(await run(h)).toEqual({ kind: "TRANSFER_OUTCOME_MALFORMED" });
    // Ingestion had already been entered and committed. Rolling it back because
    // a port misbehaved would discard a fact that is true.
    expect(h.order).toContain("begin");
    expect(h.order).not.toContain("finalize");
  });
});

describe("finalization is Phase 2H-1's, unchanged", () => {
  it("passes the receipt through exactly as received", async () => {
    const receipt = { sha256: "b".repeat(64), sizeBytes: 2048 };
    const h = harness({
      poll: async () => ({ kind: "SUCCEEDED", outputLocator: locator() }),
      transferResult: async () => ({ kind: "VERIFIED", receipt }),
    });
    await run(h);
    const finalize = h.completionCalls.find((c) => c.op === "finalize");
    expect(finalize?.input.receipt).toBe(receipt);
  });

  it("does not pre-validate an obviously invalid receipt", async () => {
    // Deliberate: a second validator with its own rules is how two boundaries
    // start disagreeing about what a valid receipt is.
    const h = harness({
      poll: async () => ({ kind: "SUCCEEDED", outputLocator: locator() }),
      transferResult: async () => ({ kind: "VERIFIED", receipt: { sha256: "nope" } }),
      answers: { finalize: { kind: "RECEIPT_MALFORMED" } },
    });
    expect(await run(h)).toEqual({ kind: "TRANSFER_OUTCOME_MALFORMED" });
    expect(h.completionCalls.some((c) => c.op === "finalize")).toBe(true);
  });

  it.each([
    ["APPLIED", { kind: "APPLIED", attemptId: ATTEMPT, stateVersion: 4, outputStorageKey: "k", outputVerifiedAt: 1 }, { kind: "OUTPUT_VERIFIED" }],
    ["REPLAYED", { kind: "REPLAYED", attemptId: ATTEMPT }, { kind: "OUTPUT_VERIFICATION_REPLAYED" }],
    [
      "CONFLICTING_OUTPUT",
      { kind: "CONFLICTING_OUTPUT", reason: "SHA256_MISMATCH" },
      { kind: "PROVIDER_REALITY_CONFLICT", reason: "COMPLETION_CONFLICT" },
    ],
    [
      "NOT_INGESTING",
      { kind: "NOT_INGESTING", reason: "ATTEMPT_NOT_INGESTING" },
      { kind: "ATTEMPT_NOT_APPLICABLE", reason: "ATTEMPT_STATE_MOVED" },
    ],
    ["LOST_CONCURRENCY", { kind: "LOST_CONCURRENCY" }, { kind: "LOST_CONCURRENCY" }],
  ])("maps a %s finalization", async (_l, finalize, expected) => {
    const h = harness({
      poll: async () => ({ kind: "SUCCEEDED", outputLocator: locator() }),
      answers: { finalize },
    });
    expect(await run(h)).toEqual(expected);
  });

  it("never returns the storage key or the locator", async () => {
    const h = harness({ poll: async () => ({ kind: "SUCCEEDED", outputLocator: locator() }) });
    const result = await run(h);
    expect(Object.keys(result)).toEqual(["kind"]);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("SECRETSIG");
    expect(serialized).not.toContain("org/");
  });
});

describe("provider reality already recorded is never overwritten", () => {
  it.each([
    ["PROVIDER_SUCCEEDED", "PROVIDER_SUCCEEDED"],
    ["OUTPUT_INGESTING", "OUTPUT_INGESTING"],
  ] as const)("refuses a late FAILED poll against a %s attempt", async (_l, state) => {
    // A later failure report is a discrepancy for a human, not an instruction to
    // erase a success — and with it the charge the Safety Guard is counting.
    const h = harness({
      context: context({ orchestrationState: state }),
      poll: async () => ({ kind: "FAILED", retryable: true, diagnosticCode: null }),
    });
    expect(await run(h)).toEqual({
      kind: "PROVIDER_REALITY_CONFLICT",
      reason: "FAILED_AGAINST_RECORDED_SUCCESS",
    });
    expect(h.completionCalls).toHaveLength(0);
  });

  it.each([
    ["PROVIDER_SUCCEEDED", "PROVIDER_SUCCEEDED"],
    ["OUTPUT_INGESTING", "OUTPUT_INGESTING"],
  ] as const)("refuses to move a %s attempt backwards on IN_PROGRESS", async (_l, state) => {
    const h = harness({
      context: context({ orchestrationState: state }),
      poll: async () => ({ kind: "IN_PROGRESS" }),
    });
    expect(await run(h)).toEqual({
      kind: "PROVIDER_REALITY_CONFLICT",
      reason: "IN_PROGRESS_AGAINST_RECORDED_SUCCESS",
    });
    expect(h.completionCalls).toHaveLength(0);
  });
});

describe("reacquiring an output for an attempt already past PROCESSING", () => {
  it("claims ingestion from PROVIDER_SUCCEEDED", async () => {
    const h = harness({
      context: context({ orchestrationState: "PROVIDER_SUCCEEDED" }),
      poll: async () => ({ kind: "SUCCEEDED", outputLocator: locator() }),
    });
    expect(await run(h)).toEqual({ kind: "OUTPUT_VERIFIED" });
    // No second completion write: provider success is already on file.
    expect(h.order).toEqual(["load", "poll", "begin", "transfer", "finalize"]);
  });

  it("resumes an OUTPUT_INGESTING attempt without re-claiming the transition", async () => {
    // The crash-recovery path. A previous process entered OUTPUT_INGESTING and
    // stopped; asking Phase 2H-1 to begin again would only answer
    // ALREADY_INGESTING and stall the resume this path exists for.
    const h = harness({
      context: context({ orchestrationState: "OUTPUT_INGESTING" }),
      poll: async () => ({ kind: "SUCCEEDED", outputLocator: locator() }),
    });
    expect(await run(h)).toEqual({ kind: "OUTPUT_VERIFIED" });
    expect(h.order).toEqual(["load", "poll", "transfer", "finalize"]);
    expect(h.completionCalls.some((c) => c.op === "begin")).toBe(false);
  });

  it.each([
    ["PROVIDER_SUCCEEDED", "PROVIDER_SUCCEEDED"],
    ["OUTPUT_INGESTING", "OUTPUT_INGESTING"],
  ] as const)("reports an unavailable locator from %s without writing", async (_l, state) => {
    const h = harness({
      context: context({ orchestrationState: state }),
      poll: async () => ({ kind: "SUCCEEDED", outputLocator: null }),
    });
    expect(await run(h)).toEqual({ kind: "OUTPUT_LOCATOR_UNAVAILABLE" });
    expect(h.completionCalls).toHaveLength(0);
  });
});

describe("one batch is one pass", () => {
  it("sweeps the three orchestrated stages and no others", async () => {
    const h = harness({ candidates: {} });
    await h.runner.runProviderOutputBatchOnce({ limit: 10, context: CONTEXT });
    expect(h.order).toEqual([
      "discover:AWAITING_PROVIDER_COMPLETION",
      "discover:AWAITING_OUTPUT_INGESTION",
      "discover:RESUMABLE_OUTPUT_INGESTION",
    ]);
  });

  it("runs each candidate exactly once", async () => {
    const h = harness({
      candidates: {
        AWAITING_PROVIDER_COMPLETION: [
          { organizationId: ORG, attemptId: "sgen_1" },
          { organizationId: ORG, attemptId: "sgen_2" },
        ],
      },
      poll: async () => ({ kind: "IN_PROGRESS" }),
    });
    const report = await h.runner.runProviderOutputBatchOnce({ limit: 10, context: CONTEXT });
    expect(report.candidates).toBe(2);
    expect(report.results).toEqual(["STILL_PROCESSING", "STILL_PROCESSING"]);
    expect(h.order.filter((o) => o === "poll")).toHaveLength(2);
  });

  it("keeps going when one candidate reaches an expected non-mutating outcome", async () => {
    let call = 0;
    const h = harness({
      candidates: {
        AWAITING_PROVIDER_COMPLETION: [
          { organizationId: ORG, attemptId: "sgen_1" },
          { organizationId: ORG, attemptId: "sgen_2" },
        ],
      },
      poll: async () => {
        call += 1;
        if (call === 1) throw new Error("first one is unreachable");
        return { kind: "IN_PROGRESS" };
      },
    });
    const report = await h.runner.runProviderOutputBatchOnce({ limit: 10, context: CONTEXT });
    expect(report.results).toEqual(["STATUS_SOURCE_FAILED", "STILL_PROCESSING"]);
  });

  it("reports only closed result kinds", async () => {
    const h = harness({
      candidates: { AWAITING_PROVIDER_COMPLETION: [{ organizationId: ORG, attemptId: "s" }] },
      poll: () => Promise.reject(new Error(`unreachable ${RAW_URL}`)),
    });
    const report = await h.runner.runProviderOutputBatchOnce({ limit: 10, context: CONTEXT });
    // A batch report is the thing most likely to be logged wholesale.
    expect(JSON.stringify(report)).not.toContain("SECRETSIG");
    expect(report.results.every((r) => typeof r === "string")).toBe(true);
  });

  it.each([
    ["zero", 0],
    ["negative", -1],
    ["fractional", 1.5],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["one over the maximum", 101],
    ["an unsafe integer", Number.MAX_SAFE_INTEGER + 1],
  ])("refuses a %s limit before any discovery", async (_label, limit) => {
    const h = harness();
    await expect(
      h.runner.runProviderOutputBatchOnce({ limit, context: CONTEXT }),
    ).rejects.toThrow(/between 1 and 100/);
    expect(h.order).toHaveLength(0);
  });

  it.each([1, 100])("accepts the bound %i", async (limit) => {
    const h = harness();
    await expect(
      h.runner.runProviderOutputBatchOnce({ limit, context: CONTEXT }),
    ).resolves.toBeTruthy();
  });
});

describe("the module has no transport, no scheduler and no way to spend money", () => {
  const sources = () =>
    readdirSync(__dirname)
      .filter((f) => f.endsWith(".ts") && !f.includes(".test."))
      .map((name) => ({ name, text: readFileSync(join(__dirname, name), "utf8") }));

  it("names no HTTP client or storage SDK", () => {
    for (const { name, text } of sources()) {
      for (const banned of [
        "fetch(",
        "axios",
        "undici",
        "http.request",
        "XMLHttpRequest",
        "S3Client",
        "PutObjectCommand",
        "GetObjectCommand",
        "@aws-sdk",
        "@google-cloud",
        "googleapis",
        "FetchHttpClient",
        "@app/video-providers",
        "WaveSpeed",
      ]) {
        expect(`${name}:${banned}: ${text.includes(banned)}`).toBe(`${name}:${banned}: false`);
      }
    }
  });

  it("names no scheduler, timer or loop", () => {
    for (const { name, text } of sources()) {
      for (const banned of [
        "setTimeout(",
        "setInterval(",
        "setImmediate(",
        "cron",
        "while (true)",
        "process.on(",
      ]) {
        expect(`${name}:${banned}: ${text.includes(banned)}`).toBe(`${name}:${banned}: false`);
      }
    }
  });

  it("cannot submit, re-submit or cancel a paid generation", () => {
    // Not "declines to" — cannot. The paid submission port is not among this
    // module's dependencies, so a second paid render is not expressible here.
    const withoutComments = (text: string): string =>
      text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
    for (const { name, text } of sources()) {
      const codeOnly = withoutComments(text);
      for (const banned of [
        "createGeneration",
        "cancelGeneration",
        "submitGeneration",
        "PaidSubmission",
        "authorizePaidSubmission",
        "GenerationReservation",
        "reservation",
        "CONSUMED",
      ]) {
        expect(`${name}:${banned}: ${codeOnly.includes(banned)}`).toBe(`${name}:${banned}: false`);
      }
    }
  });

  it("names no delivery transition", () => {
    for (const { name, text } of sources()) {
      for (const banned of ["DELIVERED", "SCENES_READY", "SYSTEM_RECOVERY"]) {
        expect(`${name}:${banned}: ${text.includes(banned)}`).toBe(`${name}:${banned}: false`);
      }
    }
  });
});
