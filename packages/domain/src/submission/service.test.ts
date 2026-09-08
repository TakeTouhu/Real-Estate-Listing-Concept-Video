import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sanitizeTransitionMetadata } from "../orchestration/transition-metadata";
import type { TransitionContext } from "../orchestration/ports";
import { epochMillisFromDate, type EpochMillis } from "../pricing/units";
import type { AttemptSubmissionFacts } from "./outcome";
import {
  createFixedSubmissionClock,
  type ApplyOutcomeResult,
  type SubmissionOutcomeFacts,
  type SubmissionOutcomeRepository,
} from "./ports";
import {
  staleSubmittingBoundary,
  validateReconciliationPolicy,
  type ReconciliationPolicy,
  type ReconciliationPolicyConfig,
} from "./reconciliation-window";
import {
  STALE_SUBMISSION_RECOVERY_EVENT_TYPE,
  SUBMISSION_UNCERTAINTY_HOLD_EVENT_TYPE,
  SUBMISSION_OUTCOME_EVENT_TYPE,
  createSubmissionOutcomeService,
} from "./service";
import type { SceneGenerationRequestKind } from "../orchestration/types";
import type { ReservationOutcomeFacts } from "./ports";
import {
  parseSubmissionDiagnosticCode,
  type SubmissionDiagnosticCode,
} from "./diagnostic-code";
import type { ProviderSubmissionObservation } from "./observation";

/**
 * The service's contract at the seams the database cannot reach: which clock it
 * reads, which label it writes, and what it refuses to touch.
 */


/**
 * The only way a test may obtain a policy.
 *
 * Fixtures go through the same validator production callers do, so a test can
 * never exercise the phase against a policy the type system would refuse in
 * production — which is the whole point of the validated type.
 */
function validatedPolicy(config: ReconciliationPolicyConfig): ReconciliationPolicy {
  const result = validateReconciliationPolicy(config);
  if (!result.ok) throw new Error(`invalid test policy: ${result.reason}`);
  return result.policy;
}

const BOUNDARY = epochMillisFromDate(new Date("2026-09-10T00:00:00.000Z"));
/** A fixture. There is deliberately no shipped production stale threshold. */
const POLICY: ReconciliationPolicy = validatedPolicy({
  reconciliationWindowMs: 24 * 60 * 60 * 1000,
  staleSubmittingAfterMs: 15 * 60 * 1000,
});
const STALE_AT = staleSubmittingBoundary(BOUNDARY, POLICY);

function atBoundary(overrides: Partial<AttemptSubmissionFacts> = {}): AttemptSubmissionFacts {
  return {
    attemptId: "sgen_svc",
    orchestrationState: "SUBMITTING",
    submissionCertainty: "PRE_SUBMISSION",
    stateVersion: 3,
    submissionBoundaryEnteredAt: BOUNDARY,
    providerPredictionId: null,
    reconciliationStartedAt: null,
    reconciliationDeadlineAt: null,
    ...overrides,
  };
}

const CONTEXT: TransitionContext = {
  actorType: "SYSTEM",
  actorUserId: null,
  correlationId: "corr_svc",
  causationId: null,
  reasonCode: null,
  eventType: "CALLER_CHOSEN",
  metadata: sanitizeTransitionMetadata({}),
};

function harness(options: {
  facts?: SubmissionOutcomeFacts | null;
  apply?: () => Promise<ApplyOutcomeResult>;
  now?: EpochMillis;
  onLock?: () => void;
  requestKind?: SceneGenerationRequestKind;
  reservation?: ReservationOutcomeFacts | null;
} = {}) {
  const facts =
    options.facts === undefined
      ? {
          attempt: atBoundary(),
          reservation: options.reservation ?? null,
          requestKind: options.requestKind ?? ("INITIAL" as SceneGenerationRequestKind),
        }
      : options.facts;
  const calls = { apply: 0, clock: 0 };
  const applied: {
    expectedVersion: number;
    context: TransitionContext;
    reservationEventType: string;
  }[] = [];
  const base = createFixedSubmissionClock(options.now ?? BOUNDARY);
  const outcomes: SubmissionOutcomeRepository = {
    async withAttemptOutcome(_input, run) {
      options.onLock?.();
      return run({
        async loadFacts() {
          return facts;
        },
        async apply(input) {
          calls.apply += 1;
          applied.push({
            expectedVersion: input.expectedVersion,
            context: input.context,
            reservationEventType: input.reservationEventType,
          });
          return (options.apply ?? (async () => ({ kind: "APPLIED", stateVersion: 4 })))();
        },
      });
    },
  };
  return {
    calls,
    applied,
    service: createSubmissionOutcomeService({
      outcomes,
      clock: {
        now() {
          calls.clock += 1;
          return base.now();
        },
      },
      policy: POLICY,
    }),
  };
}

const ACCEPTED = {
  kind: "ACCEPTED" as const,
  providerPredictionId: "pred_abc",
};

/** Codes exist only by passing the safe-code boundary. */
const CODE_TIMEOUT = ((): SubmissionDiagnosticCode => {
  const parsed = parseSubmissionDiagnosticCode("TIMEOUT");
  if (!parsed.ok || parsed.code === null) throw new Error("fixture");
  return parsed.code;
})();

describe("recording a directly observed outcome", () => {
  it("applies and reports the version the database committed", async () => {
    const { service } = harness();
    const outcome = await service.recordObservation({
      organizationId: "org_svc",
      attemptId: "sgen_svc",
      observation: ACCEPTED,
      context: CONTEXT,
    });
    expect(outcome).toEqual({
      kind: "APPLIED",
      attemptId: "sgen_svc",
      stateVersion: 4,
      entitlementAnomaly: "RESERVATION_MISSING",
    });
  });

  it("answers a missing or cross-tenant attempt without writing", async () => {
    const { service, calls } = harness({ facts: null });
    expect(
      await service.recordObservation({
        organizationId: "org_svc",
        attemptId: "sgen_svc",
        observation: ACCEPTED,
        context: CONTEXT,
      }),
    ).toEqual({ kind: "ATTEMPT_NOT_FOUND" });
    expect(calls.apply).toBe(0);
  });

  it("reports a lost compare-and-set as LOST_CONCURRENCY, never as applied", async () => {
    // Another writer resolved this attempt first. Reporting success would tell
    // the caller its news is on file when a different outcome is.
    const { service } = harness({ apply: async () => ({ kind: "LOST" }) });
    expect(
      await service.recordObservation({
        organizationId: "org_svc",
        attemptId: "sgen_svc",
        observation: ACCEPTED,
        context: CONTEXT,
      }),
    ).toEqual({ kind: "LOST_CONCURRENCY" });
  });

  it("replays without writing when the record already says this", async () => {
    const { service, calls } = harness({
      facts: {
        attempt: atBoundary({
          orchestrationState: "PROCESSING",
          submissionCertainty: "ACCEPTED",
          providerPredictionId: "pred_abc",
        }),
        reservation: null,
        requestKind: "INITIAL",
      },
    });
    expect(
      await service.recordObservation({
        organizationId: "org_svc",
        attemptId: "sgen_svc",
        observation: ACCEPTED,
        context: CONTEXT,
      }),
    ).toEqual({ kind: "REPLAYED", attemptId: "sgen_svc" });
    // Not called and rolled back — never called.
    expect(calls.apply).toBe(0);
  });

  it("refuses a conflicting observation without writing", async () => {
    const { service, calls } = harness({
      facts: {
        attempt: atBoundary({
          orchestrationState: "PROCESSING",
          submissionCertainty: "ACCEPTED",
          providerPredictionId: "pred_abc",
        }),
        reservation: null,
        requestKind: "INITIAL",
      },
    });
    expect(
      await service.recordObservation({
        organizationId: "org_svc",
        attemptId: "sgen_svc",
        observation: { ...ACCEPTED, providerPredictionId: "pred_other" },
        context: CONTEXT,
      }),
    ).toEqual({
      kind: "CONFLICTING_OBSERVATION",
      reason: "PROVIDER_REFERENCE_MISMATCH",
    });
    expect(calls.apply).toBe(0);
  });

  it("carries the compare-and-set against the version it read", async () => {
    const { service, applied } = harness();
    await service.recordObservation({
      organizationId: "org_svc",
      attemptId: "sgen_svc",
      observation: ACCEPTED,
      context: CONTEXT,
    });
    expect(applied[0]?.expectedVersion).toBe(3);
  });
});

describe("stale-submitting recovery", () => {
  it("refuses an attempt that has not sat there long enough", async () => {
    const { service, calls } = harness({ now: (STALE_AT - 1) as EpochMillis });
    expect(
      await service.enterUncertaintyForStaleSubmitting({
        organizationId: "org_svc",
        attemptId: "sgen_svc",
        normalizedErrorCode: null,
        context: CONTEXT,
      }),
    ).toEqual({ kind: "NOT_STALE_YET", staleAt: STALE_AT });
    expect(calls.apply).toBe(0);
  });

  it("enters uncertainty exactly at the threshold", async () => {
    const { service } = harness({ now: STALE_AT });
    expect(
      (
        await service.enterUncertaintyForStaleSubmitting({
          organizationId: "org_svc",
          attemptId: "sgen_svc",
          normalizedErrorCode: null,
          context: CONTEXT,
        })
      ).kind,
    ).toBe("APPLIED");
  });

  it("replays against an attempt another route already made uncertain", async () => {
    // The benign half of the direct-versus-stale race: both routes compute the
    // same durable state, so the loser sees its own intended write already made.
    const { service, calls } = harness({
      now: (STALE_AT + 60_000) as EpochMillis,
      facts: {
        attempt: atBoundary({
          orchestrationState: "RECONCILIATION_PENDING",
          submissionCertainty: "SUBMISSION_UNKNOWN",
        }),
        reservation: null,
        requestKind: "INITIAL",
      },
    });
    expect(
      await service.enterUncertaintyForStaleSubmitting({
        organizationId: "org_svc",
        attemptId: "sgen_svc",
        normalizedErrorCode: null,
        context: CONTEXT,
      }),
    ).toEqual({ kind: "REPLAYED", attemptId: "sgen_svc" });
    expect(calls.apply).toBe(0);
  });

  it("refuses to overwrite an acceptance that landed while it swept", async () => {
    // The other half. A worker finished after the sweeper decided to look, and
    // provider reality wins over a presumption of loss.
    const { service, calls } = harness({
      now: (STALE_AT + 60_000) as EpochMillis,
      facts: {
        attempt: atBoundary({
          orchestrationState: "PROCESSING",
          submissionCertainty: "ACCEPTED",
          providerPredictionId: "pred_abc",
        }),
        reservation: null,
        requestKind: "INITIAL",
      },
    });
    expect(
      await service.enterUncertaintyForStaleSubmitting({
        organizationId: "org_svc",
        attemptId: "sgen_svc",
        normalizedErrorCode: null,
        context: CONTEXT,
      }),
    ).toEqual({ kind: "CONFLICTING_OBSERVATION", reason: "CERTAINTY_MISMATCH" });
    expect(calls.apply).toBe(0);
  });
});

describe("the clock and the event label", () => {
  it("reads the clock inside the lock, not before it", async () => {
    // A stale judgement made before waiting for the lock could declare an
    // attempt lost that a worker finished while this transaction queued.
    const order: string[] = [];
    const { service } = harness({ onLock: () => order.push("lock") });
    const wrapped = createSubmissionOutcomeService({
      outcomes: {
        async withAttemptOutcome(_input, run) {
          order.push("lock");
          return run({
            async loadFacts() {
              return { attempt: atBoundary(), reservation: null, requestKind: "INITIAL" };
            },
            async apply() {
              return { kind: "APPLIED", stateVersion: 4 };
            },
          });
        },
      },
      clock: {
        now(): EpochMillis {
          order.push("clock");
          return BOUNDARY;
        },
      },
      policy: POLICY,
    });
    await wrapped.recordObservation({
      organizationId: "org_svc",
      attemptId: "sgen_svc",
      observation: ACCEPTED,
      context: CONTEXT,
    });
    expect(order).toEqual(["lock", "clock"]);
    void service;
  });

  it("reads the clock exactly once per decision", async () => {
    const { service, calls } = harness();
    await service.recordObservation({
      organizationId: "org_svc",
      attemptId: "sgen_svc",
      observation: ACCEPTED,
      context: CONTEXT,
    });
    expect(calls.clock).toBe(1);
  });

  it("labels the event itself rather than trusting the caller", async () => {
    const { service, applied } = harness();
    await service.recordObservation({
      organizationId: "org_svc",
      attemptId: "sgen_svc",
      observation: ACCEPTED,
      context: CONTEXT,
    });
    expect(applied[0]?.context.eventType).toBe(SUBMISSION_OUTCOME_EVENT_TYPE);
    expect(applied[0]?.context.eventType).not.toBe("CALLER_CHOSEN");
  });

  it("labels stale recovery distinctly from a direct observation", async () => {
    // They record the same durable state by design; the label is how an
    // operator tells which route produced it.
    const { service, applied } = harness({ now: STALE_AT });
    await service.enterUncertaintyForStaleSubmitting({
      organizationId: "org_svc",
      attemptId: "sgen_svc",
      normalizedErrorCode: null,
      context: CONTEXT,
    });
    expect(applied[0]?.context.eventType).toBe(STALE_SUBMISSION_RECOVERY_EVENT_TYPE);
    expect(STALE_SUBMISSION_RECOVERY_EVENT_TYPE).not.toBe(SUBMISSION_OUTCOME_EVENT_TYPE);
  });

  it("keeps the caller's actor, correlation and causation", async () => {
    const { service, applied } = harness();
    await service.recordObservation({
      organizationId: "org_svc",
      attemptId: "sgen_svc",
      observation: ACCEPTED,
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
      correlationId: "corr_svc",
      causationId: "evt_parent",
    });
  });

  it("records the certainty and deadline in the event's safe metadata", async () => {
    const { service, applied } = harness();
    await service.recordObservation({
      organizationId: "org_svc",
      attemptId: "sgen_svc",
      observation: { kind: "SUBMISSION_UNKNOWN", normalizedErrorCode: CODE_TIMEOUT },
      context: CONTEXT,
    });
    expect(applied[0]?.context.metadata).toMatchObject({
      attemptId: "sgen_svc",
      submissionCertainty: "SUBMISSION_UNKNOWN",
      reconciliationDeadlineAt: BOUNDARY + POLICY.reconciliationWindowMs,
    });
  });

  it("writes no prompt, provider payload or credential into the record", async () => {
    const { service, applied } = harness();
    await service.recordObservation({
      organizationId: "org_svc",
      attemptId: "sgen_svc",
      observation: ACCEPTED,
      context: CONTEXT,
    });
    const keys = Object.keys(applied[0]?.context.metadata ?? {});
    for (const forbidden of [
      "compiledPrompt",
      "renderedPrompt",
      "prompt",
      "providerRequest",
      "providerResponse",
      "providerPredictionId",
      "apiKey",
    ]) {
      expect(keys).not.toContain(forbidden);
    }
  });
});

describe("the submission module has no provider or network dependency", () => {
  const HERE = join(__dirname);

  function sources(): { name: string; text: string }[] {
    return readdirSync(HERE)
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
      .map((name) => ({ name, text: readFileSync(join(HERE, name), "utf8") }));
  }

  it("imports no provider package and no transport", () => {
    // This phase records reality that has already been observed. A worker that
    // *asks* a provider is a later phase and a different dependency set.
    for (const { name, text } of sources()) {
      for (const pattern of [
        "@app/video-providers",
        "node:http",
        "node:https",
        "undici",
        "axios",
        "node-fetch",
        "@app/storage",
      ]) {
        expect(`${name}: ${text.includes(`"${pattern}"`)}`).toBe(`${name}: false`);
      }
    }
  });

  it("names no transport call anywhere in its source", () => {
    for (const { name, text } of sources()) {
      for (const call of ["fetch(", "createGeneration(", "XMLHttpRequest", "new WebSocket"]) {
        expect(`${name}: ${text.includes(call)}`).toBe(`${name}: false`);
      }
    }
  });

  it("reads wall time only through the injected clock", () => {
    // `Date.now()` scattered through the decision path makes a stale judgement
    // untestable and lets two parts of one decision disagree about now.
    for (const { name, text } of sources()) {
      if (name === "ports.ts") continue;
      expect(`${name}: ${text.includes("Date.now(")}`).toBe(`${name}: false`);
      expect(`${name}: ${text.includes("new Date(")}`).toBe(`${name}: false`);
    }
  });
});

describe("entitlement anomalies are recorded, never a refusal", () => {
  const HELD: ReservationOutcomeFacts = { id: "genres_1", state: "RESERVED", stateVersion: 0 };
  const SPENT: ReservationOutcomeFacts = { id: "genres_1", state: "CONSUMED", stateVersion: 2 };
  const GONE: ReservationOutcomeFacts = { id: "genres_1", state: "RELEASED", stateVersion: 3 };

  async function landUnknown(options: {
    requestKind: SceneGenerationRequestKind;
    reservation: ReservationOutcomeFacts | null;
  }) {
    const h = harness(options);
    const outcome = await h.service.recordObservation({
      organizationId: "org_svc",
      attemptId: "sgen_svc",
      observation: { kind: "SUBMISSION_UNKNOWN", normalizedErrorCode: CODE_TIMEOUT },
      context: CONTEXT,
    });
    return { outcome, applied: h.applied, calls: h.calls };
  }

  it("calls a held reservation under an INITIAL request normal", async () => {
    const { outcome, applied } = await landUnknown({
      requestKind: "INITIAL",
      reservation: HELD,
    });
    expect(outcome).toMatchObject({ kind: "APPLIED", entitlementAnomaly: "NONE" });
    expect(applied[0]?.context.metadata).toMatchObject({ entitlementAnomaly: "NONE" });
  });

  it("calls a CONSUMED reservation under a user regeneration normal", async () => {
    // Correct by contract: the regeneration right is sold with the original
    // video and exercised after delivery, when the unit is already spent.
    const { outcome, applied } = await landUnknown({
      requestKind: "USER_REGENERATION",
      reservation: SPENT,
    });
    expect(outcome).toMatchObject({ kind: "APPLIED", entitlementAnomaly: "NONE" });
    expect(applied[0]?.context.metadata).toMatchObject({
      entitlementAnomaly: "NONE",
      requestKind: "USER_REGENERATION",
    });
  });

  it("records a CONSUMED reservation under an INITIAL request, and still writes", async () => {
    const { outcome, applied, calls } = await landUnknown({
      requestKind: "INITIAL",
      reservation: SPENT,
    });
    expect(outcome).toMatchObject({
      kind: "APPLIED",
      entitlementAnomaly: "INITIAL_RESERVATION_ALREADY_CONSUMED",
    });
    // Recorded, not refused. Provider reality after the paid boundary is
    // persisted whether or not the bookkeeping adds up.
    expect(calls.apply).toBe(1);
    expect(applied[0]?.context.metadata).toMatchObject({
      entitlementAnomaly: "INITIAL_RESERVATION_ALREADY_CONSUMED",
    });
  });

  it("records a missing reservation and still writes", async () => {
    const { outcome, calls, applied } = await landUnknown({
      requestKind: "INITIAL",
      reservation: null,
    });
    expect(outcome).toMatchObject({
      kind: "APPLIED",
      entitlementAnomaly: "RESERVATION_MISSING",
    });
    expect(calls.apply).toBe(1);
    expect(applied[0]?.context.metadata).toMatchObject({
      entitlementAnomaly: "RESERVATION_MISSING",
    });
  });

  it("records a released reservation and still writes", async () => {
    const { outcome, applied } = await landUnknown({
      requestKind: "INITIAL",
      reservation: GONE,
    });
    expect(outcome).toMatchObject({
      kind: "APPLIED",
      entitlementAnomaly: "RESERVATION_RELEASED",
    });
    expect(applied[0]?.context.metadata).toMatchObject({
      entitlementAnomaly: "RESERVATION_RELEASED",
    });
  });

  it("writes the anomaly into metadata even when the caller supplied none", async () => {
    // The point of putting it in the transition event: a crash between commit
    // and the caller reading the return value must not erase the only record
    // that an anomaly existed.
    const { applied } = await landUnknown({ requestKind: "INITIAL", reservation: null });
    expect(Object.keys(applied[0]?.context.metadata ?? {})).toContain("entitlementAnomaly");
  });
});

describe("the reservation event has its own label", () => {
  it("passes a reservation-specific event type, distinct from either attempt label", async () => {
    // The attempt event says what a provider did; the reservation event says a
    // customer's entitlement was suspended because nobody could say what the
    // provider did. An operator querying for entitlement suspensions should not
    // have to know which attempt-side route caused each one.
    const { service, applied } = harness({
      requestKind: "INITIAL",
      reservation: { id: "genres_1", state: "RESERVED", stateVersion: 0 },
    });
    await service.recordObservation({
      organizationId: "org_svc",
      attemptId: "sgen_svc",
      observation: { kind: "SUBMISSION_UNKNOWN", normalizedErrorCode: null },
      context: CONTEXT,
    });
    expect(applied[0]?.reservationEventType).toBe(SUBMISSION_UNCERTAINTY_HOLD_EVENT_TYPE);
    expect(applied[0]?.reservationEventType).not.toBe(SUBMISSION_OUTCOME_EVENT_TYPE);
    expect(applied[0]?.reservationEventType).not.toBe(STALE_SUBMISSION_RECOVERY_EVENT_TYPE);
    expect(applied[0]?.reservationEventType).not.toBe("CALLER_CHOSEN");
  });

  it("uses the same reservation label from the stale-recovery route", async () => {
    const { service, applied } = harness({
      now: STALE_AT,
      requestKind: "INITIAL",
      reservation: { id: "genres_1", state: "RESERVED", stateVersion: 0 },
    });
    await service.enterUncertaintyForStaleSubmitting({
      organizationId: "org_svc",
      attemptId: "sgen_svc",
      normalizedErrorCode: null,
      context: CONTEXT,
    });
    expect(applied[0]?.reservationEventType).toBe(SUBMISSION_UNCERTAINTY_HOLD_EVENT_TYPE);
    // While the attempt-side label still distinguishes the two routes.
    expect(applied[0]?.context.eventType).toBe(STALE_SUBMISSION_RECOVERY_EVENT_TYPE);
  });
});

describe("a malformed diagnostic code refuses before anything is written", () => {
  it.each([
    "https://signed.example/path?token=SECRET",
    "Bearer secret-token",
    "a sunlit living room, cinematic",
    "Provider returned 429: too many requests",
  ])("refuses %s and writes nothing", async (hostile) => {
    const { service, calls } = harness();
    expect(
      await service.recordObservation({
        organizationId: "org_svc",
        attemptId: "sgen_svc",
        observation: {
          kind: "SUBMISSION_UNKNOWN",
          normalizedErrorCode: hostile as SubmissionDiagnosticCode,
        },
        context: CONTEXT,
      }),
    ).toEqual({ kind: "OBSERVATION_MALFORMED" });
    expect(calls.apply).toBe(0);
  });

  it.each([
    ["a non-string provider reference", { kind: "ACCEPTED", providerPredictionId: 123 }],
    ["a null provider reference", { kind: "ACCEPTED", providerPredictionId: null }],
    ["an unrecognised discriminant", { kind: "UNKNOWN" }],
    ["a stringly-typed retryable flag", {
      kind: "DEFINITIVELY_REJECTED",
      retryable: "false",
      normalizedErrorCode: null,
    }],
    ["a numeric retryable flag", {
      kind: "DEFINITIVELY_REJECTED",
      retryable: 1,
      normalizedErrorCode: null,
    }],
    ["a null retryable flag", {
      kind: "DEFINITIVELY_REJECTED",
      retryable: null,
      normalizedErrorCode: null,
    }],
    ["a bare string", "ACCEPTED"],
    ["null", null],
    ["an array", []],
    ["an empty object", {}],
  ])("refuses %s end to end, writing nothing", async (_label, hostile) => {
    // Cast because that is how it arrives: an adapter decodes a provider
    // response and asserts the union on the way in. Two of these used to get
    // through — `retryable: "false"` was truthy and recorded FAILED_RETRYABLE
    // while restoring the customer's unit, and a non-string reference threw out
    // of the validator rather than being refused.
    const { service, calls } = harness();
    expect(
      await service.recordObservation({
        organizationId: "org_svc",
        attemptId: "sgen_svc",
        observation: hostile as unknown as ProviderSubmissionObservation,
        context: CONTEXT,
      }),
    ).toEqual({ kind: "OBSERVATION_MALFORMED" });
    expect(calls.apply).toBe(0);
  });

  it("refuses hostile text on the stale-recovery route too", async () => {
    const { service, calls } = harness({ now: STALE_AT });
    expect(
      await service.enterUncertaintyForStaleSubmitting({
        organizationId: "org_svc",
        attemptId: "sgen_svc",
        normalizedErrorCode: "Bearer secret-token" as SubmissionDiagnosticCode,
        context: CONTEXT,
      }),
    ).toEqual({ kind: "OBSERVATION_MALFORMED" });
    expect(calls.apply).toBe(0);
  });
});
