/**
 * The dormant attempt sender (GS-7c-2b, ADR-0098).
 *
 * One pass finds the orchestrated attempts waiting to be sent (ADR-0097) and,
 * for each, in this order:
 *
 * ```text
 * provider     this sender reaches the attempt's provider, before anything is signed
 * prepare      sign the photo's URL; a refusal for good ends the attempt, one that may pass leaves it
 * fresh        the URL has time left
 * authorize    the paid-submission gate moves it QUEUED -> SUBMITTING, audited, or refuses
 * send         one POST, only after AUTHORIZED, never retried
 * record       what the provider answered, through the submission outcome
 * ```
 *
 * Everything before the gate writes nothing but the ending; a gate refusal
 * writes nothing, unless the attempt's Property was deleted (below), and the
 * attempt is offered again on a later pass. Once the gate has armed an attempt
 * it is sent exactly once and its answer recorded: a sender that throws, or
 * answers with something that is not an observation, is recorded as
 * `SUBMISSION_UNKNOWN`, because the request may have left. The
 * record is tried up to `RECORD_TRIES` times while it throws or loses a race,
 * since an answer already on file replays. If it still does not land, the
 * answer is lost: the attempt stays `SUBMITTING`, the state the stale
 * submission recovery turns into `SUBMISSION_UNKNOWN` (ADR-0036), and nothing
 * ever sends it again. The pass then sends nothing more, because whatever kept
 * one answer from being recorded would lose the next one too.
 *
 * Before that window, a pass ends a generating job's attempt whose Property
 * was deleted (GS-7d-2, ADR-0100), up to the same bound: discovery never
 * offers one and the gate refuses it for good, so nothing else ever would. A
 * gate that refuses an attempt because its Property was deleted since
 * discovery ends it the same way. Each such ending re-decides under its own
 * locks.
 *
 * Once an attempt of a job has ended in a pass, by preparation's refusal, by
 * its Property's deletion or by the provider's refusal, the job will fail
 * (Transaction K, ADR-0083), so its other attempts are not sent in that pass;
 * Transaction L cancels them (ADR-0084).
 *
 * A pass reads one window of candidates after the caller's cursor and returns
 * where the next should start, so attempts left waiting do not hold the oldest
 * window for every pass after them.
 *
 * ## Dormant
 *
 * Nothing in production constructs this runner, schedules it or calls it. The
 * development pipeline command of the approved plan (GS-9) is what will run it,
 * on the test provider only.
 */

import type { PaidSubmissionAuthorizationService } from "../authorization/paid-submission-service";
import type { PaidSubmissionAuthorizationOutcome } from "../authorization/types";
import {
  prepareQueuedGeneration,
  type ExecutionPreflightDeps,
  type PreparedGeneration,
} from "../generation/execution-preflight";
import { PreflightRefusalError, type PreflightRefusalReason } from "../generation/execution-preflight-errors";
import type { TransitionContext } from "../orchestration/ports";
import { isWellFormedObservation, type ProviderSubmissionObservation } from "../submission/observation";
import type {
  RecordSubmissionObservationInput,
  SubmissionClock,
  SubmissionOutcomeResult,
} from "../submission/ports";
import type { SubmissionOutcomeService } from "../submission/service";
import {
  preparationRefusalEnding,
  validateAttemptSubmissionBatchLimit,
  validateAttemptSubmissionCursor,
} from "./preparation-refusal";
import type {
  AttemptSubmissionCandidate,
  AttemptSubmissionCursor,
  AttemptSubmissionRepository,
  PreparedGenerationSender,
} from "./ports";
import { PROPERTY_DELETED_ATTEMPT_CODE } from "./property-deleted";

/**
 * How long the photo's URL must still work when the gate is asked: the gate's
 * transaction, the POST and the provider's own fetch of the photo. Provisional,
 * as the URL's 600-second life is (`docs/decisions/TODO.md`).
 */
export const MIN_SOURCE_URL_REMAINING_MS = 300_000;

/**
 * How many times an answer is offered to the submission outcome. Each try is
 * its own transaction; one that landed answers `REPLAYED` to the next.
 */
const RECORD_TRIES = 3;

/** The answer recorded for a send whose fate is not known. */
const UNKNOWN: ProviderSubmissionObservation = Object.freeze({
  kind: "SUBMISSION_UNKNOWN",
  normalizedErrorCode: null,
});

type GateRefusal = Exclude<PaidSubmissionAuthorizationOutcome, { readonly kind: "AUTHORIZED" }>;

/** Why an attempt ended before submission: preparation's refusal, or its Property's deletion. */
export type AttemptEndingReason = PreflightRefusalReason | typeof PROPERTY_DELETED_ATTEMPT_CODE;

export type AttemptSubmissionRunOutcome =
  /**
   * Sent once. What the provider answered, and the outcome's last result, or
   * `null` when the last try to record it threw. Anything but `APPLIED` or
   * `REPLAYED` stopped the pass.
   */
  | {
      readonly kind: "SENT";
      readonly observed: ProviderSubmissionObservation["kind"];
      readonly recorded: SubmissionOutcomeResult["kind"] | null;
      readonly safetyGuardWarning: boolean;
    }
  /** Ended before submission: preparation refused for good, or its Property was deleted. */
  | { readonly kind: "ENDED"; readonly reason: AttemptEndingReason }
  /** Preparation refused for a reason that may pass; the attempt waits. */
  | { readonly kind: "NOT_PREPARED"; readonly reason: PreflightRefusalReason }
  /** Refused for good, but no longer `QUEUED` when ended: another writer moved it. */
  | { readonly kind: "MOVED"; readonly reason: AttemptEndingReason }
  /**
   * Not sent, and nothing written: another provider's attempt, a URL with too
   * little time left, a job that will fail, a pass stopped by an answer it
   * could not record, or an attempt whose Property the ending found standing.
   * The last comes from the first step, for an attempt offered as deleted, or
   * from the gate's refusal for a deleted Property; either way the Property
   * reads standing again under its lock. From the first step the attempt is
   * still `QUEUED`, so the window may report it a second time.
   */
  | {
      readonly kind: "NOT_SENT";
      readonly reason:
        | "OTHER_PROVIDER"
        | "SOURCE_URL_STALE"
        | "JOB_ENDING"
        | "PASS_STOPPED"
        | "PROPERTY_NOT_DELETED";
    }
  /** The gate refused and wrote nothing. */
  | { readonly kind: "NOT_AUTHORIZED"; readonly refusal: GateRefusal["kind"]; readonly reason: string | null }
  /** Something threw before any send; nothing about the error is kept. */
  | { readonly kind: "FAILED" };

export interface AttemptSubmissionReport {
  readonly sent: number;
  readonly ended: number;
  readonly failed: number;
  /** An answer was not recorded, and nothing after it was sent. */
  readonly stopped: boolean;
  readonly outcomes: readonly {
    readonly organizationId: string;
    readonly attemptId: string;
    readonly outcome: AttemptSubmissionRunOutcome;
  }[];
  /**
   * Where the next pass starts: after the attempt that stopped the pass, after
   * the last attempt offered when the window was full, or from the oldest
   * (`null`) when it reached the end.
   */
  readonly next: AttemptSubmissionCursor | null;
}

export interface AttemptSubmissionRunnerDeps {
  readonly repository: AttemptSubmissionRepository;
  readonly preflight: ExecutionPreflightDeps;
  readonly gate: Pick<PaidSubmissionAuthorizationService, "authorize">;
  readonly sender: PreparedGenerationSender;
  readonly outcomes: Pick<SubmissionOutcomeService, "recordObservation">;
  /** Read for the URL's time left, just before the gate. */
  readonly clock: SubmissionClock;
  /** Built per attempt, so its ending, arm and outcome share one correlation. */
  readonly context: () => TransitionContext;
}

export class AttemptSubmissionRunner {
  readonly #deps: AttemptSubmissionRunnerDeps;

  constructor(deps: AttemptSubmissionRunnerDeps) {
    this.#deps = deps;
  }

  /**
   * One bounded pass: up to `limit` attempts of deleted Properties are ended,
   * then the window after `after` is sent.
   */
  async runOnce(limit: number, after: AttemptSubmissionCursor | null = null): Promise<AttemptSubmissionReport> {
    const bounded = validateAttemptSubmissionBatchLimit(limit);
    const start = validateAttemptSubmissionCursor(after);

    const outcomes: { organizationId: string; attemptId: string; outcome: AttemptSubmissionRunOutcome }[] = [];
    const ending = new Set<string>();
    let stopped: AttemptSubmissionCandidate | undefined;
    let sent = 0;
    let ended = 0;
    let failed = 0;
    const settle = (
      organizationId: string,
      attemptId: string,
      generationJobId: string,
      outcome: AttemptSubmissionRunOutcome,
    ): void => {
      if (outcome.kind === "SENT") sent += 1;
      if (outcome.kind === "ENDED") ended += 1;
      if (outcome.kind === "FAILED") failed += 1;
      if (outcome.kind === "ENDED" || (outcome.kind === "SENT" && outcome.observed === "DEFINITIVELY_REJECTED")) {
        ending.add(generationJobId);
      }
      outcomes.push({ organizationId, attemptId, outcome });
    };

    const deleted = await this.#deps.repository.findPropertyDeletedAttempts({ limit: bounded });
    for (const attempt of deleted) {
      let outcome: AttemptSubmissionRunOutcome;
      try {
        outcome = await this.#endPropertyDeleted(attempt.organizationId, attempt.attemptId, this.#deps.context());
      } catch {
        outcome = { kind: "FAILED" };
      }
      settle(attempt.organizationId, attempt.attemptId, attempt.generationJobId, outcome);
    }

    const candidates = await this.#deps.repository.findSubmissionCandidates({ limit: bounded, after: start });
    for (const candidate of candidates) {
      let outcome: AttemptSubmissionRunOutcome;
      if (stopped !== undefined) {
        outcome = { kind: "NOT_SENT", reason: "PASS_STOPPED" };
      } else if (ending.has(candidate.generationJobId)) {
        outcome = { kind: "NOT_SENT", reason: "JOB_ENDING" };
      } else {
        try {
          outcome = await this.#submit(candidate);
        } catch {
          outcome = { kind: "FAILED" };
        }
      }
      if (outcome.kind === "SENT" && outcome.recorded !== "APPLIED" && outcome.recorded !== "REPLAYED") {
        stopped = candidate;
      }
      settle(candidate.organizationId, candidate.generation.id, candidate.generationJobId, outcome);
    }

    const resume = stopped ?? (candidates.length === bounded ? candidates.at(-1) : undefined);
    const next = resume === undefined ? null : { createdAt: resume.generation.createdAt, id: resume.generation.id };
    return { sent, ended, failed, stopped: stopped !== undefined, outcomes, next };
  }

  async #submit(candidate: AttemptSubmissionCandidate): Promise<AttemptSubmissionRunOutcome> {
    const { organizationId, generation } = candidate;
    // Before anything is signed: an attempt admitted for another provider is
    // that provider's sender's to send.
    if (generation.providerName !== this.#deps.sender.providerName) {
      return { kind: "NOT_SENT", reason: "OTHER_PROVIDER" };
    }
    const context = this.#deps.context();

    let prepared: PreparedGeneration;
    try {
      prepared = await prepareQueuedGeneration(this.#deps.preflight, candidate);
    } catch (error: unknown) {
      if (!(error instanceof PreflightRefusalError)) throw error;
      return this.#refused(organizationId, generation.id, error.reason, context);
    }

    const remaining = prepared.sourceUrlExpiresAt.getTime() - this.#deps.clock.now();
    if (!(remaining >= MIN_SOURCE_URL_REMAINING_MS)) return { kind: "NOT_SENT", reason: "SOURCE_URL_STALE" };

    const authorized = await this.#deps.gate.authorize({
      organizationId,
      attemptId: generation.id,
      source: prepared.sourceIdentity,
      context,
    });
    if (authorized.kind !== "AUTHORIZED") {
      // Deleted since discovery: refused for good, so ended now rather than
      // by the next pass.
      if (authorized.kind === "SOURCE_INVALID" && authorized.reason === PROPERTY_DELETED_ATTEMPT_CODE) {
        return this.#endPropertyDeleted(organizationId, generation.id, context);
      }
      return {
        kind: "NOT_AUTHORIZED",
        refusal: authorized.kind,
        reason: "reason" in authorized ? authorized.reason : null,
      };
    }

    // Armed and audited: from here the attempt is sent once, and its answer
    // is recorded whatever happens.
    const observation = await this.#send(prepared);
    const recorded = await this.#record({ organizationId, attemptId: generation.id, observation, context });
    return {
      kind: "SENT",
      observed: observation.kind,
      recorded,
      safetyGuardWarning: authorized.safetyGuardWarning !== null,
    };
  }

  async #refused(
    organizationId: string,
    attemptId: string,
    reason: PreflightRefusalReason,
    context: TransitionContext,
  ): Promise<AttemptSubmissionRunOutcome> {
    if (preparationRefusalEnding(reason) === null) return { kind: "NOT_PREPARED", reason };
    const ended = await this.#deps.repository.endPreparationRefusal({ organizationId, attemptId, reason, context });
    return ended.kind === "ENDED" ? { kind: "ENDED", reason } : { kind: "MOVED", reason };
  }

  async #endPropertyDeleted(
    organizationId: string,
    attemptId: string,
    context: TransitionContext,
  ): Promise<AttemptSubmissionRunOutcome> {
    const ended = await this.#deps.repository.endPropertyDeletedAttempt({ organizationId, attemptId, context });
    if (ended.kind === "ENDED") return { kind: "ENDED", reason: PROPERTY_DELETED_ATTEMPT_CODE };
    if (ended.kind === "NOT_QUEUED") return { kind: "MOVED", reason: PROPERTY_DELETED_ATTEMPT_CODE };
    return { kind: "NOT_SENT", reason: "PROPERTY_NOT_DELETED" };
  }

  /** The one POST. A throw or a malformed answer says nothing about whether the request left. */
  async #send(prepared: PreparedGeneration): Promise<ProviderSubmissionObservation> {
    try {
      const answer: unknown = await this.#deps.sender.send(prepared);
      return isWellFormedObservation(answer) ? answer : UNKNOWN;
    } catch {
      return UNKNOWN;
    }
  }

  /** The answer, offered again only while recording it throws or loses a race. */
  async #record(input: RecordSubmissionObservationInput): Promise<SubmissionOutcomeResult["kind"] | null> {
    let recorded: SubmissionOutcomeResult["kind"] | null = null;
    for (let tries = 0; tries < RECORD_TRIES; tries += 1) {
      try {
        recorded = (await this.#deps.outcomes.recordObservation(input)).kind;
      } catch {
        recorded = null;
      }
      if (recorded !== null && recorded !== "LOST_CONCURRENCY") return recorded;
    }
    return recorded;
  }
}
