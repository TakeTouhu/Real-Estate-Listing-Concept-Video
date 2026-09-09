import { describe, expect, it } from "vitest";
import { epochMillis, epochMillisFromDate, type EpochMillis } from "../pricing/units";
import {
  parseSubmissionDiagnosticCode,
  type SubmissionDiagnosticCode,
} from "../submission/diagnostic-code";
import {
  decideBeginOutputIngestion,
  decideFinalizeOutputVerification,
  decideProviderCompletion,
  type CompletingAttemptFacts,
  type CompletionWrite,
} from "./decide";
import type { ProviderCompletionObservation } from "./observation";
import {
  managedGenerationOutputKey,
  safePositiveByteCount,
  sha256Digest,
  type ManagedOutputVerificationReceipt,
} from "./output";

/**
 * The three conclusions a post-acceptance attempt can reach, and every way of
 * reaching none of them.
 *
 * Pure input, pure output. The verification instant is a value here, so a
 * replay's freshness is an ordinary test rather than something to race.
 */

const ACCEPTED_AT = epochMillisFromDate(new Date("2026-09-10T00:00:00.000Z"));
const VERIFIED_AT = epochMillis(ACCEPTED_AT + 60_000);
const ORG = "org_completion";

function code(raw: string): SubmissionDiagnosticCode {
  const parsed = parseSubmissionDiagnosticCode(raw);
  if (!parsed.ok || parsed.code === null) throw new Error(`fixture: ${raw}`);
  return parsed.code;
}

const SHA_A = sha256Digest("a".repeat(64));
const SHA_B = sha256Digest("b".repeat(64));
const SIZE_A = safePositiveByteCount(4_194_304);
const SIZE_B = safePositiveByteCount(8_388_608);

const RECEIPT: ManagedOutputVerificationReceipt = { sha256: SHA_A, sizeBytes: SIZE_A };
const KEY = managedGenerationOutputKey({ organizationId: ORG, attemptId: "sgen_c" });

function processing(overrides: Partial<CompletingAttemptFacts> = {}): CompletingAttemptFacts {
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

/** A fully verified row, for the replay and conflict paths. */
function verified(overrides: Partial<CompletingAttemptFacts> = {}): CompletingAttemptFacts {
  return processing({
    orchestrationState: "OUTPUT_VERIFIED",
    outputStorageKey: KEY,
    outputSha256: SHA_A,
    outputSizeBytes: SIZE_A,
    outputVerifiedAt: VERIFIED_AT,
    ...overrides,
  });
}

const SUCCEEDED: ProviderCompletionObservation = { kind: "SUCCEEDED" };
const FAILED_RETRYABLE: ProviderCompletionObservation = {
  kind: "FAILED",
  retryable: true,
  diagnosticCode: code("TIMEOUT"),
};
const FAILED_TERMINAL: ProviderCompletionObservation = {
  kind: "FAILED",
  retryable: false,
  diagnosticCode: null,
};

const complete = (facts: CompletingAttemptFacts, observation: ProviderCompletionObservation) =>
  decideProviderCompletion({ facts, observation });

const finalize = (
  facts: CompletingAttemptFacts,
  receipt: ManagedOutputVerificationReceipt = RECEIPT,
  now: EpochMillis = VERIFIED_AT,
) => decideFinalizeOutputVerification({ facts, organizationId: ORG, receipt, now });

describe("recording that the provider finished", () => {
  it("moves PROCESSING to PROVIDER_SUCCEEDED", () => {
    expect(complete(processing(), SUCCEEDED)).toEqual({
      kind: "APPLY",
      write: { orchestrationState: "PROVIDER_SUCCEEDED" },
    });
  });

  it("writes nothing but the execution state", () => {
    // The write shape is the whole permission set. Certainty, the provider
    // reference and the acceptance instant are absent from the type, so no
    // branch can revise what the submission boundary established.
    const decision = complete(processing(), SUCCEEDED);
    if (decision.kind !== "APPLY") throw new Error("expected APPLY");
    expect(Object.keys(decision.write)).toEqual(["orchestrationState"]);
  });

  it("records no output location", () => {
    // A success arm that could carry a location is a provider URL that will
    // eventually be persisted. The managed key is derived at verification.
    const decision = complete(processing(), SUCCEEDED);
    if (decision.kind !== "APPLY") throw new Error("expected APPLY");
    for (const forbidden of ["outputStorageKey", "providerOutputUrl", "outputUrl"]) {
      expect(Object.keys(decision.write)).not.toContain(forbidden);
    }
  });
});

describe("recording that the provider failed after accepting", () => {
  it("sends a retryable failure to FAILED_RETRYABLE", () => {
    expect(complete(processing(), FAILED_RETRYABLE)).toEqual({
      kind: "APPLY",
      write: { orchestrationState: "FAILED_RETRYABLE" },
    });
  });

  it("sends a terminal failure to FAILED_TERMINAL", () => {
    expect(complete(processing(), FAILED_TERMINAL)).toEqual({
      kind: "APPLY",
      write: { orchestrationState: "FAILED_TERMINAL" },
    });
  });

  it("never writes the submission certainty on either failure", () => {
    // The distinction the whole phase turns on. The provider accepted this
    // work and ran a paid job; calling that DEFINITIVELY_REJECTED would tell
    // the Safety Guard the money came back.
    for (const observation of [FAILED_RETRYABLE, FAILED_TERMINAL]) {
      const decision = complete(processing(), observation);
      if (decision.kind !== "APPLY") throw new Error("expected APPLY");
      expect(Object.keys(decision.write)).not.toContain("submissionCertainty");
    }
  });

  it("never clears the provider reference or acceptance instant", () => {
    const decision = complete(processing(), FAILED_TERMINAL);
    if (decision.kind !== "APPLY") throw new Error("expected APPLY");
    expect(Object.keys(decision.write)).not.toContain("providerPredictionId");
    expect(Object.keys(decision.write)).not.toContain("providerAcceptedAt");
  });
});

describe("completion preconditions", () => {
  it.each([
    ["PRE_SUBMISSION"],
    ["SUBMISSION_UNKNOWN"],
    ["DEFINITIVELY_REJECTED"],
  ] as const)("refuses a completion for a %s attempt", (certainty) => {
    // A completion observation is about work a provider admitted to taking.
    // These three say it did not, or that nobody knows.
    expect(complete(processing({ submissionCertainty: certainty }), SUCCEEDED)).toEqual({
      kind: "NOT_PROCESSING",
      reason: "PROVIDER_NEVER_ACCEPTED",
    });
  });

  it.each(["QUEUED", "SUBMITTING", "RECONCILIATION_PENDING"] as const)(
    "refuses an attempt at %s",
    (state) => {
      expect(complete(processing({ orchestrationState: state }), SUCCEEDED)).toEqual({
        kind: "NOT_PROCESSING",
        reason: "ATTEMPT_NOT_PROCESSING",
      });
    },
  );

  it.each([["providerPredictionId"], ["providerAcceptedAt"]] as const)(
    "fails closed when %s is missing",
    (field) => {
      // Phases 2G-1 and 2G-2 both write these with the certainty. A row missing
      // one is incoherent rather than incomplete, and no substitute is invented.
      expect(complete(processing({ [field]: null }), SUCCEEDED)).toEqual({
        kind: "NOT_PROCESSING",
        reason: "ACCEPTANCE_METADATA_MISSING",
      });
    },
  );

  it.each([
    ["DEFINITIVELY_REJECTED", "FAILED_TERMINAL"],
    ["DEFINITIVELY_REJECTED", "FAILED_RETRYABLE"],
    ["PRE_SUBMISSION", "FAILED_RETRYABLE"],
    ["PRE_SUBMISSION", "FAILED_TERMINAL"],
  ] as const)(
    "refuses rather than replays a failure for a %s attempt already at %s",
    (certainty, state) => {
      // The certainty check has to come *before* the replay checks, not merely
      // exist. These rows are already in a failed state, so a replay check
      // consulted first would answer REPLAY — reporting that a provider
      // execution failure is on file for an attempt whose provider either
      // refused the work or never received it. Both of those failures were
      // written by a different phase for a different reason, and this one has
      // no standing to confirm them as its own.
      expect(
        complete(
          processing({
            submissionCertainty: certainty,
            orchestrationState: state,
            // Both certainties forbid a provider reference (ADR: a reference
            // exists only under ACCEPTED), so the row is shaped honestly.
            providerPredictionId: null,
            providerAcceptedAt: null,
          }),
          state === "FAILED_RETRYABLE" ? FAILED_RETRYABLE : FAILED_TERMINAL,
        ),
      ).toEqual({ kind: "NOT_PROCESSING", reason: "PROVIDER_NEVER_ACCEPTED" });
    },
  );

  it("refuses rather than conflicts when an unaccepted attempt is claimed to have succeeded", () => {
    // The mirror image: without the certainty check first, this would be
    // reported as a completion *conflict*, which asserts that a real provider
    // execution disagrees with this evidence. Nothing was executed.
    expect(
      complete(
        processing({
          submissionCertainty: "DEFINITIVELY_REJECTED",
          orchestrationState: "FAILED_TERMINAL",
          providerPredictionId: null,
          providerAcceptedAt: null,
        }),
        SUCCEEDED,
      ),
    ).toEqual({ kind: "NOT_PROCESSING", reason: "PROVIDER_NEVER_ACCEPTED" });
  });
});

describe("completion replay", () => {
  it.each(["PROVIDER_SUCCEEDED", "OUTPUT_INGESTING", "OUTPUT_VERIFIED"] as const)(
    "replays a success at %s",
    (state) => {
      // A provider that finished has finished. Moving on to ingestion and
      // verification does not un-finish it, and a duplicate webhook must not
      // drag a verified attempt backwards.
      expect(complete(processing({ orchestrationState: state }), SUCCEEDED)).toEqual({
        kind: "REPLAY",
      });
    },
  );

  it("replays a retryable failure already on file", () => {
    expect(
      complete(processing({ orchestrationState: "FAILED_RETRYABLE" }), FAILED_RETRYABLE),
    ).toEqual({ kind: "REPLAY" });
  });

  it("replays a terminal failure already on file", () => {
    expect(
      complete(processing({ orchestrationState: "FAILED_TERMINAL" }), FAILED_TERMINAL),
    ).toEqual({ kind: "REPLAY" });
  });

  it("replays a failure whose diagnostic differs but whose outcome does not", () => {
    expect(
      complete(processing({ orchestrationState: "FAILED_RETRYABLE" }), {
        kind: "FAILED",
        retryable: true,
        diagnosticCode: null,
      }),
    ).toEqual({ kind: "REPLAY" });
  });

  it("writes nothing on any replay", () => {
    for (const state of ["PROVIDER_SUCCEEDED", "OUTPUT_VERIFIED"] as const) {
      expect(Object.keys(complete(processing({ orchestrationState: state }), SUCCEEDED))).toEqual(
        ["kind"],
      );
    }
  });
});

describe("completion conflict", () => {
  it.each(["PROVIDER_SUCCEEDED", "OUTPUT_INGESTING", "OUTPUT_VERIFIED"] as const)(
    "refuses a failure against a recorded success at %s",
    (state) => {
      expect(complete(processing({ orchestrationState: state }), FAILED_TERMINAL)).toEqual({
        kind: "CONFLICT",
        reason: "COMPLETION_OUTCOME_MISMATCH",
      });
    },
  );

  it.each(["FAILED_RETRYABLE", "FAILED_TERMINAL"] as const)(
    "refuses a success against a recorded %s",
    (state) => {
      expect(complete(processing({ orchestrationState: state }), SUCCEEDED)).toEqual({
        kind: "CONFLICT",
        reason: "COMPLETION_OUTCOME_MISMATCH",
      });
    },
  );

  it("refuses a retryable failure against a recorded terminal one", () => {
    // Two observers disagreeing about retryability have disagreed about whether
    // the customer's request may be attempted again at all.
    expect(
      complete(processing({ orchestrationState: "FAILED_TERMINAL" }), FAILED_RETRYABLE),
    ).toEqual({ kind: "CONFLICT", reason: "RETRYABLE_MISMATCH" });
  });

  it("refuses a terminal failure against a recorded retryable one", () => {
    expect(
      complete(processing({ orchestrationState: "FAILED_RETRYABLE" }), FAILED_TERMINAL),
    ).toEqual({ kind: "CONFLICT", reason: "RETRYABLE_MISMATCH" });
  });
});

describe("a malformed completion observation is refused first", () => {
  it.each([
    ["an unknown discriminant", { kind: "UNKNOWN" }],
    ["a well-formed body under an unknown kind", { kind: "UNKNOWN", retryable: true, diagnosticCode: null }],
    ["a stringly-typed retryable flag", { kind: "FAILED", retryable: "false", diagnosticCode: null }],
    ["a missing retryable flag", { kind: "FAILED", diagnosticCode: null }],
    ["a hostile diagnostic", { kind: "FAILED", retryable: true, diagnosticCode: "Bearer sk" }],
    ["null", null],
    ["an array", []],
  ])("refuses %s", (_label, hostile) => {
    expect(
      complete(processing(), hostile as unknown as ProviderCompletionObservation),
    ).toEqual({ kind: "MALFORMED_OBSERVATION" });
  });

  it("refuses it before the row is inspected", () => {
    // A caller must not learn from the answer whether its unusable evidence
    // would have replayed or conflicted.
    expect(
      complete(verified(), { kind: "UNKNOWN" } as unknown as ProviderCompletionObservation),
    ).toEqual({ kind: "MALFORMED_OBSERVATION" });
  });
});

describe("an ingestion problem is never recorded as a provider failure", () => {
  /**
   * The committed state machine *does* permit `OUTPUT_INGESTING → FAILED_*`.
   * That edge is not this phase's to use.
   *
   * A copy that fails midway is the platform's own storage problem: the
   * provider rendered the video and will bill for it either way. Recording that
   * as a provider failure would put an internal fault into the provider's
   * reliability record, and — because a failure is terminal for the attempt —
   * would throw away an output that is still sitting there, retrievable, under
   * a key this attempt can re-derive. So the only honest thing an interrupted
   * copy leaves behind is `OUTPUT_INGESTING`, which is what makes it resumable.
   *
   * This sweeps every decision this phase can reach from `OUTPUT_INGESTING`
   * across every observation and receipt shape, and asserts none of them lands
   * on a failed state. It is a whole-surface claim rather than a spot check,
   * because the defect it guards against is a *new* branch being added, and a
   * spot check only sees the branches that already exist.
   */
  it("produces no failed landing from OUTPUT_INGESTING, on any input", () => {
    const ingesting = processing({ orchestrationState: "OUTPUT_INGESTING" });
    const landings: string[] = [];

    for (const observation of [SUCCEEDED, FAILED_RETRYABLE, FAILED_TERMINAL]) {
      const decision = decideProviderCompletion({ facts: ingesting, observation });
      if (decision.kind === "APPLY") landings.push(decision.write.orchestrationState);
    }
    const begun = decideBeginOutputIngestion({ facts: ingesting });
    expect(begun).toEqual({ kind: "ALREADY_INGESTING" });

    for (const receipt of [RECEIPT, { sha256: SHA_B, sizeBytes: SIZE_B }] as const) {
      const decision = finalize(ingesting, receipt);
      if (decision.kind === "APPLY") landings.push(decision.write.orchestrationState);
    }

    expect(landings).not.toContain("FAILED_RETRYABLE");
    expect(landings).not.toContain("FAILED_TERMINAL");
    // The one thing finalization may do from here, and nothing else.
    expect([...new Set(landings)]).toEqual(["OUTPUT_VERIFIED"]);
  });

  it("treats provider evidence arriving mid-copy as a conflict, not a landing", () => {
    // A provider failure message for an attempt whose output is already being
    // copied contradicts the success that authorized the copy. Surfacing the
    // contradiction is right; silently failing the attempt is not.
    for (const observation of [FAILED_RETRYABLE, FAILED_TERMINAL]) {
      expect(complete(processing({ orchestrationState: "OUTPUT_INGESTING" }), observation)).toEqual({
        kind: "CONFLICT",
        reason: "COMPLETION_OUTCOME_MISMATCH",
      });
    }
  });
});

describe("beginning managed output ingestion", () => {
  it("moves PROVIDER_SUCCEEDED to OUTPUT_INGESTING", () => {
    expect(
      decideBeginOutputIngestion({
        facts: processing({ orchestrationState: "PROVIDER_SUCCEEDED" }),
      }),
    ).toEqual({ kind: "APPLY" });
  });

  it("reports an ingestion already under way", () => {
    expect(
      decideBeginOutputIngestion({
        facts: processing({ orchestrationState: "OUTPUT_INGESTING" }),
      }),
    ).toEqual({ kind: "ALREADY_INGESTING" });
  });

  it("reports an output already verified rather than moving backwards", () => {
    expect(decideBeginOutputIngestion({ facts: verified() })).toEqual({
      kind: "ALREADY_VERIFIED",
    });
  });

  it.each(["PROCESSING", "FAILED_RETRYABLE", "FAILED_TERMINAL"] as const)(
    "refuses to ingest an attempt at %s",
    (state) => {
      // A provider-failed attempt has no output to ingest, and a still-running
      // one has none yet.
      expect(
        decideBeginOutputIngestion({ facts: processing({ orchestrationState: state }) }),
      ).toEqual({ kind: "NOT_INGESTIBLE", reason: "PROVIDER_NOT_SUCCEEDED" });
    },
  );

  it("refuses an attempt the provider never accepted", () => {
    expect(
      decideBeginOutputIngestion({
        facts: processing({
          orchestrationState: "PROVIDER_SUCCEEDED",
          submissionCertainty: "SUBMISSION_UNKNOWN",
        }),
      }),
    ).toEqual({ kind: "NOT_INGESTIBLE", reason: "PROVIDER_NEVER_ACCEPTED" });
  });
});

describe("finalizing a managed output", () => {
  const ingesting = processing({ orchestrationState: "OUTPUT_INGESTING" });

  it("verifies with the derived key and the receipt's integrity facts", () => {
    expect(finalize(ingesting)).toEqual({
      kind: "APPLY",
      write: {
        orchestrationState: "OUTPUT_VERIFIED",
        outputStorageKey: KEY,
        outputSha256: SHA_A,
        outputSizeBytes: SIZE_A,
        outputVerifiedAt: VERIFIED_AT,
      },
    });
  });

  it("derives the key rather than accepting one", () => {
    // The receipt has nowhere to put a key. A caller that could name it could
    // point a verification record at an object this attempt does not own.
    expect(Object.keys(RECEIPT).sort()).toEqual(["sha256", "sizeBytes"]);
    const decision = finalize(ingesting);
    if (decision.kind !== "APPLY") throw new Error("expected APPLY");
    expect(decision.write.outputStorageKey).toBe(KEY);
    expect(decision.write.outputStorageKey).toContain("org/org_completion/");
  });

  it("stamps the verification instant it was given", () => {
    const decision = finalize(ingesting, RECEIPT, epochMillis(VERIFIED_AT + 5_000));
    if (decision.kind !== "APPLY") throw new Error("expected APPLY");
    expect(decision.write.outputVerifiedAt).toBe(VERIFIED_AT + 5_000);
  });

  it.each(["PROVIDER_SUCCEEDED", "PROCESSING", "FAILED_TERMINAL"] as const)(
    "refuses to finalize an attempt at %s",
    (state) => {
      expect(finalize(processing({ orchestrationState: state }))).toEqual({
        kind: "NOT_INGESTING",
        reason: "ATTEMPT_NOT_INGESTING",
      });
    },
  );

  it("refuses an attempt the provider never accepted", () => {
    expect(
      finalize(
        processing({
          orchestrationState: "OUTPUT_INGESTING",
          submissionCertainty: "SUBMISSION_UNKNOWN",
        }),
      ),
    ).toEqual({ kind: "NOT_INGESTING", reason: "PROVIDER_NEVER_ACCEPTED" });
  });

  it.each([
    ["a non-canonical digest", { sha256: "A".repeat(64), sizeBytes: SIZE_A }],
    ["a short digest", { sha256: "a".repeat(63), sizeBytes: SIZE_A }],
    ["a non-string digest", { sha256: 123, sizeBytes: SIZE_A }],
    ["a zero size", { sha256: SHA_A, sizeBytes: 0 }],
    ["a negative size", { sha256: SHA_A, sizeBytes: -1 }],
    ["a fractional size", { sha256: SHA_A, sizeBytes: 1.5 }],
    ["an infinite size", { sha256: SHA_A, sizeBytes: Number.POSITIVE_INFINITY }],
    ["an unsafe size", { sha256: SHA_A, sizeBytes: Number.MAX_SAFE_INTEGER + 1 }],
    ["a missing digest", { sizeBytes: SIZE_A }],
    ["a missing size", { sha256: SHA_A }],
    ["an array", []],
    ["null", null],
  ])("refuses %s without writing", (_label, receipt) => {
    expect(
      finalize(ingesting, receipt as unknown as ManagedOutputVerificationReceipt),
    ).toEqual({ kind: "MALFORMED_RECEIPT" });
  });
});

describe("finalization replay and conflict", () => {
  it("replays the exact same receipt", () => {
    expect(finalize(verified())).toEqual({ kind: "REPLAY" });
  });

  it("replays regardless of the replaying caller's instant", () => {
    // `outputVerifiedAt` records when *this platform* verified. Requiring a
    // fresh instant to equal the stored one would make every replay after the
    // first millisecond a conflict.
    expect(finalize(verified(), RECEIPT, epochMillis(VERIFIED_AT + 86_400_000))).toEqual({
      kind: "REPLAY",
    });
  });

  it("refuses a different digest", () => {
    // Verified output is immutable. A receipt describing different bytes is a
    // discrepancy to surface, never a correction to apply.
    expect(finalize(verified(), { sha256: SHA_B, sizeBytes: SIZE_A })).toEqual({
      kind: "CONFLICTING_OUTPUT",
      reason: "SHA256_MISMATCH",
    });
  });

  it("refuses a different size", () => {
    expect(finalize(verified(), { sha256: SHA_A, sizeBytes: SIZE_B })).toEqual({
      kind: "CONFLICTING_OUTPUT",
      reason: "SIZE_MISMATCH",
    });
  });

  it("refuses a row whose stored key is not the one this attempt derives", () => {
    expect(finalize(verified({ outputStorageKey: "org/other/generations/x/output.mp4" }))).toEqual(
      { kind: "CONFLICTING_OUTPUT", reason: "STORAGE_KEY_MISMATCH" },
    );
  });

  it.each([
    ["outputStorageKey"],
    ["outputSha256"],
    ["outputSizeBytes"],
    ["outputVerifiedAt"],
  ] as const)("fails closed on a verified row missing %s", (field) => {
    // The database CHECK forbids this for orchestrated rows, so reaching it
    // means something wrote around the service. Completing the record from a
    // receipt that may describe different bytes would launder that corruption.
    expect(finalize(verified({ [field]: null }))).toEqual({
      kind: "NOT_INGESTING",
      reason: "VERIFIED_OUTPUT_INCOHERENT",
    });
  });

  it("never rewrites verified metadata on any non-APPLY path", () => {
    for (const decision of [
      finalize(verified()),
      finalize(verified(), { sha256: SHA_B, sizeBytes: SIZE_A }),
      finalize(verified({ outputSha256: null })),
    ]) {
      expect(Object.keys(decision)).not.toContain("write");
    }
  });
});

describe("the provider-completion landing state is a closed set", () => {
  it("accepts the three landings this phase owns", () => {
    for (const state of [
      "PROVIDER_SUCCEEDED",
      "FAILED_RETRYABLE",
      "FAILED_TERMINAL",
    ] as const) {
      const write: CompletionWrite = { orchestrationState: state };
      expect(write.orchestrationState).toBe(state);
    }
  });

  it("cannot express a landing outside them", () => {
    // Compile-time evidence, and the point of narrowing the type at all. With
    // the wide `GenerationAttemptState`, a caller holding a session could
    // construct this write and move a PROCESSING attempt straight past
    // PROVIDER_SUCCEEDED — recording that a copy is under way for work nothing
    // says finished. If the type is ever widened again, these stop erroring and
    // this test fails.
    // @ts-expect-error OUTPUT_INGESTING is not a provider-completion landing
    const ingesting: CompletionWrite = { orchestrationState: "OUTPUT_INGESTING" };
    // @ts-expect-error OUTPUT_VERIFIED is not a provider-completion landing
    const verified: CompletionWrite = { orchestrationState: "OUTPUT_VERIFIED" };
    // @ts-expect-error QUEUED is not a provider-completion landing
    const queued: CompletionWrite = { orchestrationState: "QUEUED" };
    expect([ingesting, verified, queued]).toHaveLength(3);
  });

  it("produces only those landings from the evaluator", () => {
    const landings = new Set<string>();
    for (const observation of [SUCCEEDED, FAILED_RETRYABLE, FAILED_TERMINAL]) {
      const decision = complete(processing(), observation);
      if (decision.kind === "APPLY") landings.add(decision.write.orchestrationState);
    }
    expect([...landings].sort()).toEqual([
      "FAILED_RETRYABLE",
      "FAILED_TERMINAL",
      "PROVIDER_SUCCEEDED",
    ]);
  });
});
