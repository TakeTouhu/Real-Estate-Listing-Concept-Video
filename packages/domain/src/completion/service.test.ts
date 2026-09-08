import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  sanitizeTransitionMetadata,
  ALLOWED_TRANSITION_METADATA_KEYS,
} from "../orchestration/transition-metadata";
import type { TransitionContext } from "../orchestration/ports";
import { epochMillis, epochMillisFromDate, type EpochMillis } from "../pricing/units";
import type { CompletingAttemptFacts } from "./decide";
import type {
  ApplyCompletionResult,
  CompletionCandidate,
  CompletionRepository,
  CompletionSession,
} from "./ports";
import type { ProviderCompletionObservation } from "./observation";
import {
  managedGenerationOutputKey,
  safePositiveByteCount,
  sha256Digest,
  type ManagedOutputVerificationReceipt,
} from "./output";
import {
  OUTPUT_INGESTION_STARTED_EVENT_TYPE,
  OUTPUT_VERIFIED_EVENT_TYPE,
  PROVIDER_COMPLETION_FAILED_EVENT_TYPE,
  PROVIDER_COMPLETION_SUCCEEDED_EVENT_TYPE,
  createProviderCompletionService,
} from "./service";

/**
 * The service's contract at the seams a database cannot reach: which clock it
 * reads and when, which label it writes, what reaches the audit record, and what
 * it refuses to touch.
 */

const ACCEPTED_AT = epochMillisFromDate(new Date("2026-09-10T00:00:00.000Z"));
const NOW = epochMillis(ACCEPTED_AT + 120_000);
const ORG = "org_c";

const SHA = sha256Digest("c".repeat(64));
const SIZE = safePositiveByteCount(2_097_152);
const RECEIPT: ManagedOutputVerificationReceipt = { sha256: SHA, sizeBytes: SIZE };
const KEY = managedGenerationOutputKey({ organizationId: ORG, attemptId: "sgen_c" });

function facts(overrides: Partial<CompletingAttemptFacts> = {}): CompletingAttemptFacts {
  return {
    attemptId: "sgen_c",
    orchestrationState: "PROCESSING",
    submissionCertainty: "ACCEPTED",
    stateVersion: 5,
    providerPredictionId: "pred_accepted",
    providerAcceptedAt: ACCEPTED_AT,
    outputStorageKey: null,
    outputSha256: null,
    outputSizeBytes: null,
    outputVerifiedAt: null,
    ...overrides,
  };
}

const CONTEXT: TransitionContext = {
  actorType: "SYSTEM",
  actorUserId: null,
  correlationId: "corr_c",
  causationId: null,
  reasonCode: null,
  eventType: "CALLER_CHOSEN",
  metadata: sanitizeTransitionMetadata({}),
};

interface AppliedCall {
  op: "completion" | "ingest" | "verify";
  expectedVersion: number;
  context: TransitionContext;
  write?: Record<string, unknown>;
}

function harness(
  options: {
    attempt?: CompletingAttemptFacts;
    missing?: true;
    now?: EpochMillis;
    apply?: () => Promise<ApplyCompletionResult>;
    candidates?: readonly CompletionCandidate[];
  } = {},
) {
  const calls = { apply: 0, clock: 0 };
  const applied: AppliedCall[] = [];
  const order: string[] = [];

  /**
   * One recorder for all three apply methods.
   *
   * Generic over the input rather than cast into place: a cast here would let
   * the harness accept a shape the real session would not, and the point of
   * this file is to check what the service actually hands the persistence.
   */
  const record =
    (op: AppliedCall["op"]) =>
    async <I extends { expectedVersion: number; context: TransitionContext }>(
      input: I,
    ): Promise<ApplyCompletionResult> => {
      calls.apply += 1;
      applied.push({
        op,
        expectedVersion: input.expectedVersion,
        context: input.context,
        write: (input as { write?: Record<string, unknown> }).write,
      });
      return (options.apply ?? (async () => ({ kind: "APPLIED", stateVersion: 6 })))();
    };

  const completion: CompletionRepository = {
    async withCompletingAttempt(_input, run) {
      order.push("lock");
      const session: CompletionSession = {
        async loadFacts() {
          order.push("load");
          if (options.missing === true) return null;
          return { attempt: options.attempt ?? facts() };
        },
        applyCompletion: record("completion"),
        applyBeginIngestion: record("ingest"),
        applyOutputVerification: record("verify"),
      };
      return run(session);
    },
    async findCompletionCandidates() {
      return options.candidates ?? [];
    },
  };

  return {
    calls,
    applied,
    order,
    service: createProviderCompletionService({
      completion,
      clock: {
        now(): EpochMillis {
          calls.clock += 1;
          order.push("clock");
          return options.now ?? NOW;
        },
      },
    }),
  };
}

const SUCCEEDED: ProviderCompletionObservation = { kind: "SUCCEEDED" };
const FAILED_RETRYABLE: ProviderCompletionObservation = {
  kind: "FAILED",
  retryable: true,
  diagnosticCode: null,
};

const base = { organizationId: ORG, attemptId: "sgen_c", context: CONTEXT };

describe("recording a provider completion", () => {
  it("applies and reports the committed version", async () => {
    const { service } = harness();
    expect(
      await service.recordProviderCompletion({ ...base, observation: SUCCEEDED }),
    ).toEqual({ kind: "APPLIED", attemptId: "sgen_c", stateVersion: 6 });
  });

  it("answers a missing or cross-tenant attempt without writing", async () => {
    const { service, calls } = harness({ missing: true });
    expect(
      await service.recordProviderCompletion({ ...base, observation: SUCCEEDED }),
    ).toEqual({ kind: "ATTEMPT_NOT_FOUND" });
    expect(calls.apply).toBe(0);
  });

  it("reports a lost compare-and-set, never an application", async () => {
    const { service } = harness({ apply: async () => ({ kind: "LOST" }) });
    expect(
      await service.recordProviderCompletion({ ...base, observation: SUCCEEDED }),
    ).toEqual({ kind: "LOST_CONCURRENCY" });
  });

  it("carries the compare-and-set against the version it read", async () => {
    const { service, applied } = harness();
    await service.recordProviderCompletion({ ...base, observation: SUCCEEDED });
    expect(applied[0]?.expectedVersion).toBe(5);
  });

  it("replays without writing", async () => {
    const { service, calls } = harness({
      attempt: facts({ orchestrationState: "OUTPUT_VERIFIED" }),
    });
    expect(
      await service.recordProviderCompletion({ ...base, observation: SUCCEEDED }),
    ).toEqual({ kind: "REPLAYED", attemptId: "sgen_c" });
    expect(calls.apply).toBe(0);
  });

  it("refuses a conflict without writing", async () => {
    const { service, calls } = harness({
      attempt: facts({ orchestrationState: "PROVIDER_SUCCEEDED" }),
    });
    expect(
      await service.recordProviderCompletion({ ...base, observation: FAILED_RETRYABLE }),
    ).toEqual({ kind: "CONFLICTING_COMPLETION", reason: "COMPLETION_OUTCOME_MISMATCH" });
    expect(calls.apply).toBe(0);
  });

  it("refuses an attempt that never reached an accepted provider job", async () => {
    const { service, calls } = harness({
      attempt: facts({ submissionCertainty: "SUBMISSION_UNKNOWN" }),
    });
    expect(
      await service.recordProviderCompletion({ ...base, observation: SUCCEEDED }),
    ).toEqual({ kind: "ATTEMPT_NOT_PROCESSING", reason: "PROVIDER_NEVER_ACCEPTED" });
    expect(calls.apply).toBe(0);
  });

  it.each([
    ["an unknown discriminant", { kind: "UNKNOWN" }],
    ["a stringly-typed retryable flag", { kind: "FAILED", retryable: "false", diagnosticCode: null }],
    ["a bare string", "SUCCEEDED"],
    ["null", null],
    ["an array", []],
  ])("refuses %s end to end, writing nothing", async (_label, hostile) => {
    const { service, calls } = harness();
    expect(
      await service.recordProviderCompletion({
        ...base,
        observation: hostile as unknown as ProviderCompletionObservation,
      }),
    ).toEqual({ kind: "OBSERVATION_MALFORMED" });
    expect(calls.apply).toBe(0);
  });

  it("reads no clock at all — a completion needs no timestamp", async () => {
    // Nothing durable is stamped by a completion, so there is no instant to
    // take. A clock read here would be a timestamp with nowhere honest to go.
    const { service, calls } = harness();
    await service.recordProviderCompletion({ ...base, observation: SUCCEEDED });
    expect(calls.clock).toBe(0);
  });
});

describe("beginning managed output ingestion", () => {
  const succeeded = facts({ orchestrationState: "PROVIDER_SUCCEEDED" });

  it("applies from PROVIDER_SUCCEEDED", async () => {
    const { service } = harness({ attempt: succeeded });
    expect(await service.beginOutputIngestion(base)).toEqual({
      kind: "APPLIED",
      attemptId: "sgen_c",
      stateVersion: 6,
    });
  });

  it("reports an ingestion already under way, writing nothing", async () => {
    const { service, calls } = harness({
      attempt: facts({ orchestrationState: "OUTPUT_INGESTING" }),
    });
    expect(await service.beginOutputIngestion(base)).toEqual({
      kind: "ALREADY_INGESTING",
      attemptId: "sgen_c",
    });
    expect(calls.apply).toBe(0);
  });

  it("reports an output already verified rather than moving backwards", async () => {
    const { service, calls } = harness({
      attempt: facts({ orchestrationState: "OUTPUT_VERIFIED" }),
    });
    expect(await service.beginOutputIngestion(base)).toEqual({
      kind: "ALREADY_VERIFIED",
      attemptId: "sgen_c",
    });
    expect(calls.apply).toBe(0);
  });

  it("refuses a provider-failed attempt", async () => {
    const { service, calls } = harness({
      attempt: facts({ orchestrationState: "FAILED_RETRYABLE" }),
    });
    expect(await service.beginOutputIngestion(base)).toEqual({
      kind: "NOT_INGESTIBLE",
      reason: "PROVIDER_NOT_SUCCEEDED",
    });
    expect(calls.apply).toBe(0);
  });

  it("reads no clock — starting a copy stamps nothing", async () => {
    const { service, calls } = harness({ attempt: succeeded });
    await service.beginOutputIngestion(base);
    expect(calls.clock).toBe(0);
  });
});

describe("finalizing a managed output", () => {
  const ingesting = facts({ orchestrationState: "OUTPUT_INGESTING" });

  it("applies and reports the derived key and verification instant", async () => {
    const { service } = harness({ attempt: ingesting });
    expect(
      await service.finalizeOutputVerification({ ...base, receipt: RECEIPT }),
    ).toEqual({
      kind: "APPLIED",
      attemptId: "sgen_c",
      stateVersion: 6,
      outputStorageKey: KEY,
      outputVerifiedAt: NOW,
    });
  });

  it("reads the clock inside the lock, after the facts", async () => {
    // A verification instant taken before queueing behind the lock would claim
    // the platform proved the bytes at a moment it had not yet read the row.
    const { service, order } = harness({ attempt: ingesting });
    await service.finalizeOutputVerification({ ...base, receipt: RECEIPT });
    expect(order).toEqual(["lock", "load", "clock"]);
  });

  it("reads the clock exactly once", async () => {
    const { service, calls } = harness({ attempt: ingesting });
    await service.finalizeOutputVerification({ ...base, receipt: RECEIPT });
    expect(calls.clock).toBe(1);
  });

  it("takes no verification instant and no storage key from the caller", async () => {
    // The input type is the proof: there is nowhere to put either.
    expect(Object.keys({ ...base, receipt: RECEIPT }).sort()).toEqual([
      "attemptId",
      "context",
      "organizationId",
      "receipt",
    ]);
    expect(Object.keys(RECEIPT).sort()).toEqual(["sha256", "sizeBytes"]);
  });

  it("replays without writing", async () => {
    const { service, calls } = harness({
      attempt: facts({
        orchestrationState: "OUTPUT_VERIFIED",
        outputStorageKey: KEY,
        outputSha256: SHA,
        outputSizeBytes: SIZE,
        outputVerifiedAt: epochMillis(NOW - 1_000),
      }),
    });
    expect(
      await service.finalizeOutputVerification({ ...base, receipt: RECEIPT }),
    ).toEqual({ kind: "REPLAYED", attemptId: "sgen_c" });
    expect(calls.apply).toBe(0);
  });

  it("refuses a conflicting receipt without writing", async () => {
    const { service, calls } = harness({
      attempt: facts({
        orchestrationState: "OUTPUT_VERIFIED",
        outputStorageKey: KEY,
        outputSha256: sha256Digest("d".repeat(64)),
        outputSizeBytes: SIZE,
        outputVerifiedAt: NOW,
      }),
    });
    expect(
      await service.finalizeOutputVerification({ ...base, receipt: RECEIPT }),
    ).toEqual({ kind: "CONFLICTING_OUTPUT", reason: "SHA256_MISMATCH" });
    expect(calls.apply).toBe(0);
  });

  it("refuses a malformed receipt without writing", async () => {
    const { service, calls } = harness({ attempt: ingesting });
    expect(
      await service.finalizeOutputVerification({
        ...base,
        receipt: { sha256: "nope", sizeBytes: 0 } as unknown as ManagedOutputVerificationReceipt,
      }),
    ).toEqual({ kind: "RECEIPT_MALFORMED" });
    expect(calls.apply).toBe(0);
  });
});

describe("event labels are service-owned", () => {
  it("labels a success", async () => {
    const { service, applied } = harness();
    await service.recordProviderCompletion({ ...base, observation: SUCCEEDED });
    expect(applied[0]?.context.eventType).toBe(PROVIDER_COMPLETION_SUCCEEDED_EVENT_TYPE);
    expect(applied[0]?.context.eventType).not.toBe("CALLER_CHOSEN");
  });

  it("labels a failure distinctly", async () => {
    const { service, applied } = harness();
    await service.recordProviderCompletion({ ...base, observation: FAILED_RETRYABLE });
    expect(applied[0]?.context.eventType).toBe(PROVIDER_COMPLETION_FAILED_EVENT_TYPE);
  });

  it("labels ingestion start and verification distinctly", async () => {
    const started = harness({ attempt: facts({ orchestrationState: "PROVIDER_SUCCEEDED" }) });
    await started.service.beginOutputIngestion(base);
    expect(started.applied[0]?.context.eventType).toBe(OUTPUT_INGESTION_STARTED_EVENT_TYPE);

    const done = harness({ attempt: facts({ orchestrationState: "OUTPUT_INGESTING" }) });
    await done.service.finalizeOutputVerification({ ...base, receipt: RECEIPT });
    expect(done.applied[0]?.context.eventType).toBe(OUTPUT_VERIFIED_EVENT_TYPE);
  });

  it("uses four distinct labels", () => {
    const labels = [
      PROVIDER_COMPLETION_SUCCEEDED_EVENT_TYPE,
      PROVIDER_COMPLETION_FAILED_EVENT_TYPE,
      OUTPUT_INGESTION_STARTED_EVENT_TYPE,
      OUTPUT_VERIFIED_EVENT_TYPE,
    ];
    expect(new Set(labels).size).toBe(labels.length);
  });
});

describe("the audit record", () => {
  it("records that certainty did not move when the execution failed", async () => {
    const { service, applied } = harness();
    await service.recordProviderCompletion({ ...base, observation: FAILED_RETRYABLE });
    expect(applied[0]?.context.metadata).toMatchObject({
      attemptId: "sgen_c",
      submissionCertainty: "ACCEPTED",
      retryable: true,
    });
  });

  it("records the execution diagnostic separately from the submission one", async () => {
    const { service, applied } = harness();
    await service.recordProviderCompletion({
      ...base,
      observation: { kind: "FAILED", retryable: false, diagnosticCode: "TIMEOUT" as never },
    });
    expect(applied[0]?.context.metadata).toMatchObject({
      retryable: false,
      diagnosticCode: "TIMEOUT",
    });
  });

  it("records the integrity facts on verification", async () => {
    const { service, applied } = harness({
      attempt: facts({ orchestrationState: "OUTPUT_INGESTING" }),
    });
    await service.finalizeOutputVerification({ ...base, receipt: RECEIPT });
    expect(applied[0]?.context.metadata).toMatchObject({
      attemptId: "sgen_c",
      outputSha256: SHA,
      outputSizeBytes: SIZE,
      outputVerifiedAt: NOW,
    });
  });

  it("does not put the storage key into the audit record", async () => {
    // Storage keys are not on the transition-metadata allowlist. The row is
    // authoritative for where the object lives, and broadening the audit
    // surface for convenience is how a location reaches a query nobody scoped.
    const { service, applied } = harness({
      attempt: facts({ orchestrationState: "OUTPUT_INGESTING" }),
    });
    await service.finalizeOutputVerification({ ...base, receipt: RECEIPT });
    const keys = Object.keys(applied[0]?.context.metadata ?? {});
    for (const forbidden of [
      "outputStorageKey",
      "storageKey",
      "outputUrl",
      "providerOutputUrl",
      "signedUrl",
      "prompt",
      "providerResponse",
      "apiKey",
    ]) {
      expect(keys).not.toContain(forbidden);
    }
  });

  it("keeps the location off the allowlist, not merely out of this one call", () => {
    // The assertion above is about what this service passes. This one is about
    // what the sanitizer would accept if it ever did — and it is the load-bearing
    // half, because the sanitizer drops an unknown key *silently*. A service that
    // started offering the storage key would leak nothing today and everything
    // the moment someone widened the allowlist to make an unrelated field work.
    // So the allowlist is asserted directly.
    expect(ALLOWED_TRANSITION_METADATA_KEYS).not.toContain("outputStorageKey");
    expect(sanitizeTransitionMetadata({ outputStorageKey: KEY, outputSha256: SHA })).toEqual({
      outputSha256: SHA,
    });
  });

  it("keeps the caller's actor, correlation and causation", async () => {
    const { service, applied } = harness();
    await service.recordProviderCompletion({
      ...base,
      observation: SUCCEEDED,
      context: { ...CONTEXT, actorType: "USER", actorUserId: "usr_1", causationId: "evt_p" },
    });
    expect(applied[0]?.context).toMatchObject({
      actorType: "USER",
      actorUserId: "usr_1",
      correlationId: "corr_c",
      causationId: "evt_p",
    });
  });
});

describe("the completion module has no provider, storage or scheduler dependency", () => {
  const HERE = join(__dirname);

  function sources(): { name: string; text: string }[] {
    return readdirSync(HERE)
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
      .map((name) => ({ name, text: readFileSync(join(HERE, name), "utf8") }));
  }

  it("imports no provider package, transport or storage client", () => {
    for (const { name, text } of sources()) {
      for (const pattern of [
        "@app/video-providers",
        "@app/ai-providers",
        "@app/storage",
        "node:http",
        "node:https",
        "node:fs",
        "undici",
        "axios",
        "node-fetch",
        "@aws-sdk/client-s3",
      ]) {
        expect(`${name}: ${text.includes(`"${pattern}"`)}`).toBe(`${name}: false`);
      }
    }
  });

  it("names no transport, download or upload call", () => {
    for (const { name, text } of sources()) {
      for (const call of [
        "fetch(",
        "getObject(",
        "putObject(",
        "createSignedUploadUrl(",
        "XMLHttpRequest",
        "new WebSocket",
        "WAVESPEED",
        "FAL_KEY",
      ]) {
        expect(`${name}: ${text.includes(call)}`).toBe(`${name}: false`);
      }
    }
  });

  it("reads wall time only through the injected clock", () => {
    for (const { name, text } of sources()) {
      expect(`${name}: ${text.includes("Date.now(")}`).toBe(`${name}: false`);
      expect(`${name}: ${text.includes("new Date(")}`).toBe(`${name}: false`);
    }
  });

  it("holds no scheduler, timer or loop", () => {
    for (const { name, text } of sources()) {
      for (const banned of [
        "setTimeout(",
        "setInterval(",
        "setImmediate(",
        "cron",
        "while (true)",
        "process.on(",
      ]) {
        expect(`${name}: ${text.includes(banned)}`).toBe(`${name}: false`);
      }
    }
  });

  it("never names a reservation, entitlement move or consumption in executable code", () => {
    // The strongest statement this phase makes about customer money: there is
    // no reservation handle in the module to misuse.
    //
    // Comments are stripped first, deliberately. The claim under test is about
    // what the code *does*, and several of these files explain at length why a
    // reservation is deliberately absent — prose documenting an absence must not
    // read as evidence of a presence.
    const withoutComments = (text: string): string =>
      text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");

    for (const { name, text } of sources()) {
      const code = withoutComments(text);
      for (const banned of [
        "GenerationReservation",
        "reservation",
        "CONSUMED",
        "RECONCILIATION_HOLD",
        "entitlement",
        "videoUnits",
      ]) {
        expect(`${name}: ${code.includes(banned)}`).toBe(`${name}: false`);
      }
    }
  });
});
