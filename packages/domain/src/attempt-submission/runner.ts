/**
 * The dormant attempt sender (GS-7c-2b, ADR-0098).
 *
 * One pass finds the orchestrated attempts waiting to be sent (ADR-0097) and,
 * for each, in this order:
 *
 * ```text
 * prepare      sign the photo's URL; a refusal for good ends the attempt, one that may pass leaves it
 * check        this sender reaches the attempt's provider, and the URL has time left
 * authorize    the paid-submission gate moves it QUEUED -> SUBMITTING, audited, or refuses
 * send         one POST, only after AUTHORIZED, never retried
 * record       what the provider answered, through the submission outcome
 * ```
 *
 * Everything before the gate writes nothing but the ending; a gate refusal
 * writes nothing, and the attempt is offered again on a later pass. Once the
 * gate has armed an attempt it is sent exactly once and its answer recorded:
 * a sender that throws, or answers with something that is not an observation,
 * is recorded as `SUBMISSION_UNKNOWN`, because the request may have left. A
 * record that throws leaves the attempt `SUBMITTING`, the state the stale
 * submission recovery turns into `SUBMISSION_UNKNOWN` (ADR-0036); nothing ever
 * sends it again.
 *
 * Once an attempt of a job has ended in a pass, by preparation's refusal or by
 * the provider's, the job will fail (Transaction K, ADR-0083), so its other
 * attempts are not sent in that pass; Transaction L cancels them (ADR-0084).
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
import type { SubmissionClock, SubmissionOutcomeResult } from "../submission/ports";
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

/**
 * How long the photo's URL must still work when the gate is asked: the gate's
 * transaction, the POST and the provider's own fetch of the photo. Provisional,
 * as the URL's 600-second life is (`docs/decisions/TODO.md`).
 */
export const MIN_SOURCE_URL_REMAINING_MS = 300_000;

/** The answer recorded for a send whose fate is not known. */
const UNKNOWN: ProviderSubmissionObservation = Object.freeze({
  kind: "SUBMISSION_UNKNOWN",
  normalizedErrorCode: null,
});

type GateRefusal = Exclude<PaidSubmissionAuthorizationOutcome, { readonly kind: "AUTHORIZED" }>;

export type AttemptSubmissionRunOutcome =
  /**
   * Sent once. What the provider answered, and the outcome's result, or `null`
   * when recording it threw and the attempt stays `SUBMITTING`.
   */
  | {
      readonly kind: "SENT";
      readonly observed: ProviderSubmissionObservation["kind"];
      readonly recorded: SubmissionOutcomeResult["kind"] | null;
      readonly safetyGuardWarning: boolean;
    }
  /** Preparation refused for good, and the attempt ended before submission. */
  | { readonly kind: "ENDED"; readonly reason: PreflightRefusalReason }
  /** Preparation refused for a reason that may pass; the attempt waits. */
  | { readonly kind: "NOT_PREPARED"; readonly reason: PreflightRefusalReason }
  /** Refused for good, but no longer `QUEUED` when ended: another writer moved it. */
  | { readonly kind: "MOVED"; readonly reason: PreflightRefusalReason }
  /**
   * Not asked of the gate, and nothing written: another provider's attempt, a
   * URL with too little time left, or a job that will fail.
   */
  | { readonly kind: "NOT_SENT"; readonly reason: "OTHER_PROVIDER" | "SOURCE_URL_STALE" | "JOB_ENDING" }
  /** The gate refused and wrote nothing. */
  | { readonly kind: "NOT_AUTHORIZED"; readonly refusal: GateRefusal["kind"]; readonly reason: string | null }
  /** Something threw before any send; nothing about the error is kept. */
  | { readonly kind: "FAILED" };

export interface AttemptSubmissionReport {
  readonly sent: number;
  readonly ended: number;
  readonly failed: number;
  readonly outcomes: readonly {
    readonly organizationId: string;
    readonly attemptId: string;
    readonly outcome: AttemptSubmissionRunOutcome;
  }[];
  /**
   * Where the next pass starts: after the last attempt offered when the window
   * was full, or from the oldest (`null`) when it reached the end.
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

  /** One bounded pass over the window after `after`. */
  async runOnce(limit: number, after: AttemptSubmissionCursor | null = null): Promise<AttemptSubmissionReport> {
    const bounded = validateAttemptSubmissionBatchLimit(limit);
    const start = validateAttemptSubmissionCursor(after);
    const candidates = await this.#deps.repository.findSubmissionCandidates({ limit: bounded, after: start });

    const outcomes: { organizationId: string; attemptId: string; outcome: AttemptSubmissionRunOutcome }[] = [];
    const ending = new Set<string>();
    let sent = 0;
    let ended = 0;
    let failed = 0;

    for (const candidate of candidates) {
      let outcome: AttemptSubmissionRunOutcome;
      if (ending.has(candidate.generationJobId)) {
        outcome = { kind: "NOT_SENT", reason: "JOB_ENDING" };
      } else {
        try {
          outcome = await this.#submit(candidate);
        } catch {
          outcome = { kind: "FAILED" };
        }
      }
      if (outcome.kind === "SENT") sent += 1;
      if (outcome.kind === "ENDED") ended += 1;
      if (outcome.kind === "FAILED") failed += 1;
      if (outcome.kind === "ENDED" || (outcome.kind === "SENT" && outcome.observed === "DEFINITIVELY_REJECTED")) {
        ending.add(candidate.generationJobId);
      }
      outcomes.push({ organizationId: candidate.organizationId, attemptId: candidate.generation.id, outcome });
    }

    const last = candidates.at(-1);
    const next =
      candidates.length === bounded && last !== undefined
        ? { createdAt: last.generation.createdAt, id: last.generation.id }
        : null;
    return { sent, ended, failed, outcomes, next };
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
      return {
        kind: "NOT_AUTHORIZED",
        refusal: authorized.kind,
        reason: "reason" in authorized ? authorized.reason : null,
      };
    }

    // Armed and audited: from here the attempt is sent once, and its answer
    // is recorded whatever happens.
    const observation = await this.#send(prepared);
    let recorded: SubmissionOutcomeResult["kind"] | null;
    try {
      recorded = (
        await this.#deps.outcomes.recordObservation({ organizationId, attemptId: generation.id, observation, context })
      ).kind;
    } catch {
      recorded = null;
    }
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

  /** The one POST. A throw or a malformed answer says nothing about whether the request left. */
  async #send(prepared: PreparedGeneration): Promise<ProviderSubmissionObservation> {
    try {
      const answer: unknown = await this.#deps.sender.send(prepared);
      return isWellFormedObservation(answer) ? answer : UNKNOWN;
    } catch {
      return UNKNOWN;
    }
  }
}
