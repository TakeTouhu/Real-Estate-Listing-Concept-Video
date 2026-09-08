import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sanitizeTransitionMetadata } from "../orchestration/transition-metadata";
import type { TransitionContext } from "../orchestration/ports";
import type {
  GenerationReservationState,
  SceneGenerationRequestKind,
} from "../orchestration/types";
import { epochMillis, epochMillisFromDate, type EpochMillis } from "../pricing/units";
import {
  parseSubmissionDiagnosticCode,
  type SubmissionDiagnosticCode,
} from "../submission/diagnostic-code";
import type { ReconcilingAttemptFacts } from "./decide";
import type {
  ApplyReconciliationResult,
  ReconciliationCandidate,
  ReconciliationRepository,
  ReconciliationSession,
} from "./ports";
import type { ReconciliationResolutionObservation } from "./observation";
import {
  RECONCILIATION_EXHAUSTED_EVENT_TYPE,
  RECONCILIATION_HOLD_RELEASED_EVENT_TYPE,
  RECONCILIATION_HOLD_RESTORED_EVENT_TYPE,
  RECONCILIATION_RESOLVED_ACCEPTED_EVENT_TYPE,
  RECONCILIATION_RESOLVED_REJECTED_EVENT_TYPE,
  createReconciliationService,
} from "./service";

/**
 * The service's contract at the seams the database cannot reach: which clock it
 * reads and when, which label it writes, what it puts in the audit record, and
 * what it refuses to touch.
 */

const BOUNDARY = epochMillisFromDate(new Date("2026-09-10T00:00:00.000Z"));
const DEADLINE = epochMillis(BOUNDARY + 24 * 60 * 60 * 1000);
const INSIDE = epochMillis(DEADLINE - 60_000);
const AFTER = epochMillis(DEADLINE + 60_000);

function code(raw: string): SubmissionDiagnosticCode {
  const parsed = parseSubmissionDiagnosticCode(raw);
  if (!parsed.ok || parsed.code === null) throw new Error(`fixture: ${raw}`);
  return parsed.code;
}
const TIMEOUT = code("TIMEOUT");

function uncertain(overrides: Partial<ReconcilingAttemptFacts> = {}): ReconcilingAttemptFacts {
  return {
    attemptId: "sgen_rec",
    orchestrationState: "RECONCILIATION_PENDING",
    submissionCertainty: "SUBMISSION_UNKNOWN",
    stateVersion: 7,
    submissionBoundaryEnteredAt: BOUNDARY,
    providerPredictionId: null,
    reconciliationStartedAt: epochMillis(BOUNDARY + 1_000),
    reconciliationDeadlineAt: DEADLINE,
    reconciliationResolvedAt: null,
    ...overrides,
  };
}

const CONTEXT: TransitionContext = {
  actorType: "SYSTEM",
  actorUserId: null,
  correlationId: "corr_rec",
  causationId: null,
  reasonCode: null,
  eventType: "CALLER_CHOSEN",
  metadata: sanitizeTransitionMetadata({}),
};

const ACCEPTED: ReconciliationResolutionObservation = {
  kind: "ACCEPTED",
  providerPredictionId: "pred_found",
};

interface AppliedCall {
  expectedVersion: number;
  context: TransitionContext;
  reservationEventType: string;
  write: { orchestrationState: string; reservationAction: string };
}

function harness(
  options: {
    attempt?: ReconcilingAttemptFacts;
    facts?: null;
    reservationState?: GenerationReservationState | null;
    requestKind?: SceneGenerationRequestKind;
    now?: EpochMillis;
    apply?: () => Promise<ApplyReconciliationResult>;
    due?: readonly ReconciliationCandidate[];
    stale?: readonly ReconciliationCandidate[];
  } = {},
) {
  const calls = { apply: 0, clock: 0 };
  const applied: AppliedCall[] = [];
  const order: string[] = [];
  const reservationState = options.reservationState ?? null;

  const reconciliation: ReconciliationRepository = {
    async withReconcilingAttempt(_input, run) {
      order.push("lock");
      const session: ReconciliationSession = {
        async loadFacts() {
          order.push("load");
          if (options.facts === null) return null;
          return {
            attempt: options.attempt ?? uncertain(),
            reservation:
              reservationState === null
                ? null
                : { id: "genres_1", state: reservationState, stateVersion: 2 },
            requestKind: options.requestKind ?? "INITIAL",
          };
        },
        async apply(input) {
          calls.apply += 1;
          applied.push({
            expectedVersion: input.expectedVersion,
            context: input.context,
            reservationEventType: input.reservationEventType,
            write: {
              orchestrationState: input.write.orchestrationState,
              reservationAction: input.write.reservationAction,
            },
          });
          return (options.apply ?? (async () => ({ kind: "APPLIED", stateVersion: 8 })))();
        },
      };
      return run(session);
    },
    async findDueReconciliationCandidates() {
      return options.due ?? [];
    },
    async findStaleSubmittingCandidates() {
      return options.stale ?? [];
    },
  };

  return {
    calls,
    applied,
    order,
    service: createReconciliationService({
      reconciliation,
      clock: {
        now(): EpochMillis {
          calls.clock += 1;
          order.push("clock");
          return options.now ?? INSIDE;
        },
      },
    }),
  };
}

function resolveInput(observation: ReconciliationResolutionObservation = ACCEPTED) {
  return {
    organizationId: "org_rec",
    attemptId: "sgen_rec",
    observation,
    context: CONTEXT,
  };
}

const exhaustInput = {
  organizationId: "org_rec",
  attemptId: "sgen_rec",
  context: CONTEXT,
};

describe("resolving uncertainty", () => {
  it("applies and reports the version the database committed", async () => {
    const { service } = harness({ reservationState: "RECONCILIATION_HOLD" });
    expect(await service.resolveReconciliation(resolveInput())).toEqual({
      kind: "APPLIED",
      attemptId: "sgen_rec",
      stateVersion: 8,
      entitlementAnomaly: "NONE",
    });
  });

  it("answers a missing or cross-tenant attempt without writing", async () => {
    // One answer for missing, cross-tenant and legacy-unorchestrated. A
    // distinguishable denial would confirm another tenant's row exists.
    const { service, calls } = harness({ facts: null });
    expect(await service.resolveReconciliation(resolveInput())).toEqual({
      kind: "ATTEMPT_NOT_FOUND",
    });
    expect(calls.apply).toBe(0);
  });

  it("reports a lost compare-and-set as LOST_CONCURRENCY, never as applied", async () => {
    const { service } = harness({ apply: async () => ({ kind: "LOST" }) });
    expect(await service.resolveReconciliation(resolveInput())).toEqual({
      kind: "LOST_CONCURRENCY",
    });
  });

  it("carries the compare-and-set against the version it read under the lock", async () => {
    const { service, applied } = harness();
    await service.resolveReconciliation(resolveInput());
    expect(applied[0]?.expectedVersion).toBe(7);
  });

  it("replays without writing when the record already says this", async () => {
    const { service, calls } = harness({
      attempt: uncertain({
        orchestrationState: "PROCESSING",
        submissionCertainty: "ACCEPTED",
        providerPredictionId: "pred_found",
      }),
    });
    expect(await service.resolveReconciliation(resolveInput())).toEqual({
      kind: "REPLAYED",
      attemptId: "sgen_rec",
    });
    expect(calls.apply).toBe(0);
  });

  it("refuses conflicting evidence without writing", async () => {
    const { service, calls } = harness({
      attempt: uncertain({
        orchestrationState: "PROCESSING",
        submissionCertainty: "ACCEPTED",
        providerPredictionId: "pred_found",
      }),
    });
    expect(
      await service.resolveReconciliation(
        resolveInput({ kind: "ACCEPTED", providerPredictionId: "pred_other" }),
      ),
    ).toEqual({ kind: "CONFLICTING_RESOLUTION", reason: "PROVIDER_REFERENCE_MISMATCH" });
    expect(calls.apply).toBe(0);
  });

  it("refuses evidence that arrives after the window closed", async () => {
    const { service, calls } = harness({ now: AFTER });
    expect(await service.resolveReconciliation(resolveInput())).toEqual({
      kind: "DEADLINE_EXPIRED",
    });
    expect(calls.apply).toBe(0);
  });

  it("refuses to reopen an exhausted attempt", async () => {
    const { service, calls } = harness({
      attempt: uncertain({ orchestrationState: "RECONCILIATION_EXHAUSTED" }),
    });
    expect(await service.resolveReconciliation(resolveInput())).toEqual({
      kind: "RECONCILIATION_CLOSED",
    });
    expect(calls.apply).toBe(0);
  });

  it("refuses a malformed observation before anything is written", async () => {
    const { service, calls } = harness();
    expect(
      await service.resolveReconciliation(
        resolveInput({ kind: "ACCEPTED", providerPredictionId: "   " }),
      ),
    ).toEqual({ kind: "OBSERVATION_MALFORMED" });
    expect(calls.apply).toBe(0);
  });

  it.each([
    ["a non-string provider reference", { kind: "ACCEPTED", providerPredictionId: 123 }],
    ["an unrecognised discriminant", { kind: "UNKNOWN" }],
    ["a Phase 2G-1 arm this phase does not accept", {
      kind: "SUBMISSION_UNKNOWN",
      diagnosticCode: null,
    }],
    ["a stringly-typed retryable flag", {
      kind: "DEFINITIVELY_REJECTED",
      retryable: "false",
      diagnosticCode: null,
    }],
    ["a numeric retryable flag", {
      kind: "DEFINITIVELY_REJECTED",
      retryable: 1,
      diagnosticCode: null,
    }],
    ["a null retryable flag", {
      kind: "DEFINITIVELY_REJECTED",
      retryable: null,
      diagnosticCode: null,
    }],
    ["a bare string", "ACCEPTED"],
    ["null", null],
    ["an array", []],
  ])("refuses %s end to end, writing nothing", async (_label, hostile) => {
    // Cast because that is exactly how it arrives: a producer decodes JSON or a
    // queue payload and asserts the union on the way in. `retryable: "false"`
    // is the expensive member of this list — truthy, so before the fix it
    // recorded FAILED_RETRYABLE and handed the customer's unit back.
    const { service, calls } = harness();
    expect(
      await service.resolveReconciliation(
        resolveInput(hostile as unknown as ReconciliationResolutionObservation),
      ),
    ).toEqual({ kind: "OBSERVATION_MALFORMED" });
    expect(calls.apply).toBe(0);
  });

  it("refuses hostile text smuggled in as a diagnostic code", async () => {
    const { service, calls } = harness();
    expect(
      await service.resolveReconciliation(
        resolveInput({
          kind: "DEFINITIVELY_REJECTED",
          retryable: false,
          diagnosticCode: "Bearer secret-token" as SubmissionDiagnosticCode,
        }),
      ),
    ).toEqual({ kind: "OBSERVATION_MALFORMED" });
    expect(calls.apply).toBe(0);
  });
});

describe("exhausting a closed window", () => {
  it("closes the attempt and reports the committed version", async () => {
    const { service } = harness({ now: AFTER, reservationState: "RECONCILIATION_HOLD" });
    expect(await service.exhaustReconciliation(exhaustInput)).toEqual({
      kind: "EXHAUSTED",
      attemptId: "sgen_rec",
      stateVersion: 8,
      entitlementAnomaly: "NONE",
    });
  });

  it("refuses an attempt whose window is still open, writing nothing", async () => {
    const { service, calls } = harness({ now: INSIDE });
    expect(await service.exhaustReconciliation(exhaustInput)).toEqual({
      kind: "NOT_DUE",
      dueAt: DEADLINE,
    });
    expect(calls.apply).toBe(0);
  });

  it("reports an already-exhausted attempt without a second write", async () => {
    const { service, calls } = harness({
      now: AFTER,
      attempt: uncertain({ orchestrationState: "RECONCILIATION_EXHAUSTED" }),
    });
    expect(await service.exhaustReconciliation(exhaustInput)).toEqual({
      kind: "ALREADY_EXHAUSTED",
      attemptId: "sgen_rec",
    });
    expect(calls.apply).toBe(0);
  });

  it("refuses an attempt that regained certainty first", async () => {
    // Provider reality beats the clock. An attempt that turned out to have been
    // accepted is not closed as unknowable just because a sweeper arrived late.
    const { service, calls } = harness({
      now: AFTER,
      attempt: uncertain({
        orchestrationState: "PROCESSING",
        submissionCertainty: "ACCEPTED",
        providerPredictionId: "pred_found",
      }),
    });
    expect(await service.exhaustReconciliation(exhaustInput)).toEqual({
      kind: "NOT_RECONCILING",
      reason: "ATTEMPT_NEVER_BECAME_UNCERTAIN",
    });
    expect(calls.apply).toBe(0);
  });

  it("answers a missing attempt without writing", async () => {
    const { service, calls } = harness({ facts: null, now: AFTER });
    expect(await service.exhaustReconciliation(exhaustInput)).toEqual({
      kind: "ATTEMPT_NOT_FOUND",
    });
    expect(calls.apply).toBe(0);
  });

  it("reports a lost compare-and-set rather than a closure", async () => {
    const { service } = harness({ now: AFTER, apply: async () => ({ kind: "LOST" }) });
    expect(await service.exhaustReconciliation(exhaustInput)).toEqual({
      kind: "LOST_CONCURRENCY",
    });
  });
});

describe("the clock is read inside the lock, exactly once", () => {
  it("locks, loads, then reads the clock — in that order", async () => {
    // A resolver that judged the deadline on a timestamp taken before it queued
    // behind the lock could authorize a resolution for a window that closed
    // while it waited.
    const { service, order } = harness();
    await service.resolveReconciliation(resolveInput());
    expect(order).toEqual(["lock", "load", "clock"]);
  });

  it("locks, loads, then reads the clock on the exhaustion path too", async () => {
    const { service, order } = harness({ now: AFTER });
    await service.exhaustReconciliation(exhaustInput);
    expect(order).toEqual(["lock", "load", "clock"]);
  });

  it("reads the clock once per resolution", async () => {
    // Two reads could put a different instant in `providerAcceptedAt` than in
    // `reconciliationResolvedAt`, implying the platform learned of an
    // acceptance it had already recorded.
    const { service, calls } = harness();
    await service.resolveReconciliation(resolveInput());
    expect(calls.clock).toBe(1);
  });

  it("reads the clock once per exhaustion", async () => {
    const { service, calls } = harness({ now: AFTER });
    await service.exhaustReconciliation(exhaustInput);
    expect(calls.clock).toBe(1);
  });

  it("takes no timestamp from the caller", async () => {
    // The input type is the proof: there is nowhere to put one.
    const keys = Object.keys(resolveInput());
    expect(keys.sort()).toEqual(["attemptId", "context", "observation", "organizationId"]);
    expect(Object.keys(exhaustInput).sort()).toEqual([
      "attemptId",
      "context",
      "organizationId",
    ]);
  });
});

describe("event labels are service-owned", () => {
  it("labels a resolved acceptance", async () => {
    const { service, applied } = harness();
    await service.resolveReconciliation(resolveInput());
    expect(applied[0]?.context.eventType).toBe(RECONCILIATION_RESOLVED_ACCEPTED_EVENT_TYPE);
    expect(applied[0]?.context.eventType).not.toBe("CALLER_CHOSEN");
  });

  it("labels a resolved rejection distinctly", async () => {
    const { service, applied } = harness();
    await service.resolveReconciliation(
      resolveInput({ kind: "DEFINITIVELY_REJECTED", retryable: true, diagnosticCode: TIMEOUT }),
    );
    expect(applied[0]?.context.eventType).toBe(RECONCILIATION_RESOLVED_REJECTED_EVENT_TYPE);
  });

  it("labels an exhaustion distinctly from either resolution", async () => {
    const { service, applied } = harness({ now: AFTER });
    await service.exhaustReconciliation(exhaustInput);
    expect(applied[0]?.context.eventType).toBe(RECONCILIATION_EXHAUSTED_EVENT_TYPE);
  });

  it("uses five distinct labels across the two aggregates", async () => {
    // An operator asking "which units were handed back, and which were freed
    // because we gave up?" should not have to know which attempt-side route
    // caused each one.
    const labels = [
      RECONCILIATION_RESOLVED_ACCEPTED_EVENT_TYPE,
      RECONCILIATION_RESOLVED_REJECTED_EVENT_TYPE,
      RECONCILIATION_EXHAUSTED_EVENT_TYPE,
      RECONCILIATION_HOLD_RESTORED_EVENT_TYPE,
      RECONCILIATION_HOLD_RELEASED_EVENT_TYPE,
    ];
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("restores under an acceptance and releases under exhaustion", async () => {
    const accepted = harness({ reservationState: "RECONCILIATION_HOLD" });
    await accepted.service.resolveReconciliation(resolveInput());
    expect(accepted.applied[0]?.reservationEventType).toBe(
      RECONCILIATION_HOLD_RESTORED_EVENT_TYPE,
    );

    const gone = harness({ now: AFTER, reservationState: "RECONCILIATION_HOLD" });
    await gone.service.exhaustReconciliation(exhaustInput);
    expect(gone.applied[0]?.reservationEventType).toBe(
      RECONCILIATION_HOLD_RELEASED_EVENT_TYPE,
    );
  });

  it("restores on a retryable rejection and releases on a terminal one", async () => {
    const retryable = harness({ reservationState: "RECONCILIATION_HOLD" });
    await retryable.service.resolveReconciliation(
      resolveInput({ kind: "DEFINITIVELY_REJECTED", retryable: true, diagnosticCode: null }),
    );
    expect(retryable.applied[0]?.write.reservationAction).toBe("RESTORE");
    expect(retryable.applied[0]?.reservationEventType).toBe(
      RECONCILIATION_HOLD_RESTORED_EVENT_TYPE,
    );

    const terminal = harness({ reservationState: "RECONCILIATION_HOLD" });
    await terminal.service.resolveReconciliation(
      resolveInput({ kind: "DEFINITIVELY_REJECTED", retryable: false, diagnosticCode: null }),
    );
    expect(terminal.applied[0]?.write.reservationAction).toBe("RELEASE");
    expect(terminal.applied[0]?.reservationEventType).toBe(
      RECONCILIATION_HOLD_RELEASED_EVENT_TYPE,
    );
  });

  it("asks for no reservation move when nothing should move", async () => {
    const { service, applied } = harness({ reservationState: "CONSUMED" });
    await service.resolveReconciliation(resolveInput());
    expect(applied[0]?.write.reservationAction).toBe("NONE");
  });
});

describe("the audit record reconstructs the decision", () => {
  it("records the conclusion, deadline, resolution instant and entitlement", async () => {
    const { service, applied } = harness({ reservationState: "RECONCILIATION_HOLD" });
    await service.resolveReconciliation(resolveInput());
    expect(applied[0]?.context.metadata).toMatchObject({
      attemptId: "sgen_rec",
      submissionCertainty: "ACCEPTED",
      requestKind: "INITIAL",
      entitlementAnomaly: "NONE",
      reconciliationDeadlineAt: DEADLINE,
      reconciliationResolvedAt: INSIDE,
    });
  });

  it("records retryability and the safe diagnostic on a rejection", async () => {
    const { service, applied } = harness();
    await service.resolveReconciliation(
      resolveInput({ kind: "DEFINITIVELY_REJECTED", retryable: true, diagnosticCode: TIMEOUT }),
    );
    expect(applied[0]?.context.metadata).toMatchObject({
      submissionCertainty: "DEFINITIVELY_REJECTED",
      retryable: true,
      diagnosticCode: "TIMEOUT",
    });
  });

  it("records no resolution instant on an exhaustion", async () => {
    // The negative that matters most: a timestamp here is what an auditor reads
    // to find out when certainty was regained. It never was.
    const { service, applied } = harness({ now: AFTER });
    await service.exhaustReconciliation(exhaustInput);
    expect(applied[0]?.context.metadata).toMatchObject({
      submissionCertainty: "SUBMISSION_UNKNOWN",
      reconciliationResolvedAt: null,
      retryable: null,
      diagnosticCode: null,
    });
  });

  it("records an entitlement anomaly durably, and still writes", async () => {
    // A crash between commit and the caller reading the return value must not
    // erase the only record that an anomaly existed.
    const { service, applied, calls } = harness({ reservationState: null });
    const outcome = await service.resolveReconciliation(resolveInput());
    expect(outcome).toMatchObject({
      kind: "APPLIED",
      entitlementAnomaly: "RESERVATION_MISSING",
    });
    expect(calls.apply).toBe(1);
    expect(applied[0]?.context.metadata).toMatchObject({
      entitlementAnomaly: "RESERVATION_MISSING",
    });
  });

  it("records a spent INITIAL unit as an anomaly without refusing the write", async () => {
    // Provider reality after the paid boundary is persisted whether or not the
    // entitlement bookkeeping adds up.
    const { service, calls, applied } = harness({
      reservationState: "CONSUMED",
      requestKind: "INITIAL",
    });
    expect(await service.resolveReconciliation(resolveInput())).toMatchObject({
      kind: "APPLIED",
      entitlementAnomaly: "INITIAL_RESERVATION_ALREADY_CONSUMED",
    });
    expect(calls.apply).toBe(1);
    expect(applied[0]?.context.metadata).toMatchObject({
      entitlementAnomaly: "INITIAL_RESERVATION_ALREADY_CONSUMED",
    });
  });

  it("calls a spent unit under a post-delivery regeneration normal", async () => {
    const { service } = harness({
      reservationState: "CONSUMED",
      requestKind: "USER_REGENERATION",
    });
    expect(await service.resolveReconciliation(resolveInput())).toMatchObject({
      kind: "APPLIED",
      entitlementAnomaly: "NONE",
    });
  });

  it("records an anomaly on the exhaustion path too", async () => {
    const { service, applied, calls } = harness({ now: AFTER, reservationState: "RELEASED" });
    expect(await service.exhaustReconciliation(exhaustInput)).toMatchObject({
      kind: "EXHAUSTED",
      entitlementAnomaly: "RESERVATION_RELEASED",
    });
    expect(calls.apply).toBe(1);
    expect(applied[0]?.context.metadata).toMatchObject({
      entitlementAnomaly: "RESERVATION_RELEASED",
    });
  });

  it("keeps the caller's actor, correlation and causation", async () => {
    const { service, applied } = harness();
    await service.resolveReconciliation({
      ...resolveInput(),
      context: {
        ...CONTEXT,
        actorType: "USER",
        actorUserId: "usr_1",
        causationId: "evt_parent",
      },
    });
    expect(applied[0]?.context).toMatchObject({
      actorType: "USER",
      actorUserId: "usr_1",
      correlationId: "corr_rec",
      causationId: "evt_parent",
    });
  });

  it("writes no prompt, provider payload, reference or credential into the record", async () => {
    const { service, applied } = harness();
    await service.resolveReconciliation(resolveInput());
    const keys = Object.keys(applied[0]?.context.metadata ?? {});
    for (const forbidden of [
      "compiledPrompt",
      "renderedPrompt",
      "prompt",
      "providerRequest",
      "providerResponse",
      "providerPredictionId",
      "providerJobId",
      "apiKey",
      "authorization",
      "signedUrl",
    ]) {
      expect(keys).not.toContain(forbidden);
    }
  });
});

describe("the reconciliation module has no provider or network dependency", () => {
  const HERE = join(__dirname);

  function sources(): { name: string; text: string }[] {
    return readdirSync(HERE)
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
      .map((name) => ({ name, text: readFileSync(join(HERE, name), "utf8") }));
  }

  it("imports no provider package and no transport", () => {
    // This phase writes down conclusions reached elsewhere. A worker that
    // *asks* a provider is a later phase with a different dependency set.
    for (const { name, text } of sources()) {
      for (const pattern of [
        "@app/video-providers",
        "@app/ai-providers",
        "@app/storage",
        "node:http",
        "node:https",
        "node:net",
        "undici",
        "axios",
        "node-fetch",
      ]) {
        expect(`${name}: ${text.includes(`"${pattern}"`)}`).toBe(`${name}: false`);
      }
    }
  });

  it("names no transport call anywhere in its source", () => {
    for (const { name, text } of sources()) {
      for (const call of [
        "fetch(",
        "createGeneration(",
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

  it("holds no process-local mutex or scheduler", () => {
    // Serialization is the database's, once, in one lock order. A second
    // in-memory discipline would be correct on one replica and useless across
    // two, which is the shape of failure that survives every local test.
    for (const { name, text } of sources()) {
      for (const banned of [
        "setTimeout(",
        "setInterval(",
        "Mutex",
        "AsyncLock",
        "process.on(",
        "while (true)",
      ]) {
        expect(`${name}: ${text.includes(banned)}`).toBe(`${name}: false`);
      }
    }
  });
});
