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
import { defaultReconciliationPolicy, staleSubmittingBoundary } from "./reconciliation-window";
import {
  STALE_SUBMISSION_RECOVERY_EVENT_TYPE,
  SUBMISSION_OUTCOME_EVENT_TYPE,
  createSubmissionOutcomeService,
} from "./service";

/**
 * The service's contract at the seams the database cannot reach: which clock it
 * reads, which label it writes, and what it refuses to touch.
 */

const BOUNDARY = epochMillisFromDate(new Date("2026-09-10T00:00:00.000Z"));
const POLICY = defaultReconciliationPolicy();
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
} = {}) {
  const facts =
    options.facts === undefined ? { attempt: atBoundary(), reservation: null } : options.facts;
  const calls = { apply: 0, clock: 0 };
  const applied: { expectedVersion: number; context: TransitionContext }[] = [];
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
          applied.push({ expectedVersion: input.expectedVersion, context: input.context });
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
  providerAcceptedAt: BOUNDARY,
};

describe("recording a directly observed outcome", () => {
  it("applies and reports the version the database committed", async () => {
    const { service } = harness();
    const outcome = await service.recordObservation({
      organizationId: "org_svc",
      attemptId: "sgen_svc",
      observation: ACCEPTED,
      context: CONTEXT,
    });
    expect(outcome).toEqual({ kind: "APPLIED", attemptId: "sgen_svc", stateVersion: 4 });
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
              return { attempt: atBoundary(), reservation: null };
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
      observation: { kind: "SUBMISSION_UNKNOWN", normalizedErrorCode: "TIMEOUT" },
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
