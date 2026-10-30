/**
 * The launch commit's decision (GS-7b, ADR-0095): whether the rows a waiting
 * job's launch locked still describe the job its plan was made for.
 *
 * The plan (ADR-0094) was made outside every transaction, from facts read
 * without a lock. The commit locks the job, its reservation, its project and
 * Property, its scenes and their requests, reads them into
 * {@link JobLaunchLockedRows}, and asks this module whether to launch. Only a
 * job still waiting, its Units still held, its Property not deleted, and every
 * scene still exactly as the start wrote it launches.
 *
 * Pure: the persistence layer reads, this decides, the persistence layer
 * writes what it answers.
 */

import { AppError } from "@app/shared";
import { renderPrompt } from "../generation/prompt-render";
import type { JobLaunchCursor, JobLaunchFacts, JobLaunchPlan } from "./ports";

/** One scene of the job as the commit locked it, in position order. */
export interface JobLaunchLockedScene {
  readonly generationSceneId: string;
  readonly state: string;
  readonly durationSeconds: number;
  readonly cameraMotion: string | null;
  readonly compiledPrompt: string | null;
  /** Every request of the scene, with how many attempts each has. */
  readonly requests: readonly {
    readonly id: string;
    readonly kind: string;
    readonly state: string;
    readonly attempts: number;
  }[];
}

/** The rows the commit reads, under its locks. */
export interface JobLaunchLockedRows {
  readonly jobState: string;
  /** `null` when the job has no reservation. */
  readonly reservationState: string | null;
  readonly propertyDeleted: boolean;
  readonly qualityTier: string;
  readonly targetOutputResolution: string;
  readonly aspectRatio: string;
  readonly scenes: readonly JobLaunchLockedScene[];
}

/** Why a waiting job is not launched. Closed and application-owned. */
export type JobLaunchRefusal =
  /** The job is no longer waiting: launched, released, or never started. */
  | "NOT_WAITING"
  /**
   * Its Property was deleted after the start. Its photos await deletion, so
   * nothing is sent from them (ADR-0088's rule for a start, at launch).
   */
  | "PROPERTY_DELETED"
  /** The job, its reservation, its scenes or their requests are not as the start wrote them. */
  | "SHAPE_CONFLICT"
  /** The rows hold other facts than the plan was made from. */
  | "FACTS_CHANGED";

export type JobLaunchDecision =
  | { readonly kind: "LAUNCH" }
  | { readonly kind: "REFUSE"; readonly reason: JobLaunchRefusal };

const refuse = (reason: JobLaunchRefusal): JobLaunchDecision => ({ kind: "REFUSE", reason });

/**
 * Decide whether to launch, from the locked rows, the facts the plan was made
 * from, and the plan.
 *
 * A plan that is not for those facts is the caller's defect, not a refusal: the
 * runner plans exactly the facts it hands the commit.
 *
 * @throws JobLaunchDefect PLAN_NOT_FOR_FACTS
 */
export function decideJobLaunch(input: {
  readonly locked: JobLaunchLockedRows;
  readonly facts: JobLaunchFacts;
  readonly plan: Extract<JobLaunchPlan, { kind: "PLANNED" }>;
}): JobLaunchDecision {
  const { locked, facts, plan } = input;
  assertPlanForFacts(facts, plan);

  if (locked.jobState !== "RESERVED") return refuse("NOT_WAITING");
  if (locked.propertyDeleted) return refuse("PROPERTY_DELETED");

  // The start reserves the Units and copies every scene with one first request
  // in the same commit (ADR-0087). Anything else is a job some other writer
  // touched, and launching it would admit attempts onto rows nobody expects.
  if (locked.reservationState !== "RESERVED") return refuse("SHAPE_CONFLICT");
  if (!scenesOfStartShape(locked.scenes)) return refuse("SHAPE_CONFLICT");

  return sameFacts(locked, facts) ? { kind: "LAUNCH" } : refuse("FACTS_CHANGED");
}

/**
 * Whether the scenes are as the start wrote them: at least one, each
 * `PENDING` with exactly one first request, `PENDING`, with no attempt.
 */
export function scenesOfStartShape(scenes: readonly JobLaunchLockedScene[]): boolean {
  if (scenes.length === 0) return false;
  return scenes.every((scene) => {
    const [request, ...others] = scene.requests;
    return (
      scene.state === "PENDING" &&
      request !== undefined &&
      others.length === 0 &&
      request.kind === "INITIAL" &&
      request.state === "PENDING" &&
      request.attempts === 0
    );
  });
}

/** Field by field, scenes in order: every fact the plan was made from. Only for rows of the start's shape. */
function sameFacts(locked: JobLaunchLockedRows, facts: JobLaunchFacts): boolean {
  return (
    locked.qualityTier === facts.qualityTier &&
    locked.targetOutputResolution === facts.targetOutputResolution &&
    locked.aspectRatio === facts.aspectRatio &&
    locked.scenes.length === facts.scenes.length &&
    locked.scenes.every((scene, index) => {
      const planned = facts.scenes[index]!;
      return (
        scene.generationSceneId === planned.generationSceneId &&
        scene.requests[0]!.id === planned.initialRequestId &&
        scene.durationSeconds === planned.durationSeconds &&
        scene.cameraMotion === planned.cameraMotion &&
        scene.compiledPrompt === planned.compiledPrompt
      );
    })
  );
}

/**
 * The plan names exactly the facts' scenes and first requests, in order, and
 * each rendered prompt is what the renderer makes of that scene's compiled
 * prompt. Admission stores the rendered prompt as given and nothing later
 * renders it again, so this is where a provider prompt from anywhere else is
 * stopped.
 *
 * @throws JobLaunchDefect PLAN_NOT_FOR_FACTS
 */
export function assertPlanForFacts(
  facts: JobLaunchFacts,
  plan: Extract<JobLaunchPlan, { kind: "PLANNED" }>,
): void {
  const matches =
    plan.scenes.length === facts.scenes.length &&
    plan.scenes.every((admission, index) => {
      const scene = facts.scenes[index]!;
      return (
        admission.generationSceneId === scene.generationSceneId &&
        admission.generationSceneRequestId === scene.initialRequestId &&
        admission.compiledPrompt === scene.compiledPrompt &&
        rendersTo(admission.compiledPrompt, admission.requestRenderedPrompt)
      );
    });
  if (!matches) throw new JobLaunchDefect("PLAN_NOT_FOR_FACTS");
}

/** The renderer's own answer for a compiled prompt, compared; one it refuses matches nothing. */
function rendersTo(compiledPrompt: string, renderedPrompt: string): boolean {
  try {
    return renderPrompt(compiledPrompt) === renderedPrompt;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Batch bound
// ---------------------------------------------------------------------------

/** The most organizations one pass may launch for, matching the other sweeps' bound. */
export const MAX_JOB_LAUNCH_BATCH_SIZE = 100;

/** Prove a candidate-query limit is usable, or refuse. Never clamped. */
export function validateJobLaunchBatchLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_JOB_LAUNCH_BATCH_SIZE) {
    throw new AppError(
      "VALIDATION_FAILED",
      `Job launch batch limit must be an integer between 1 and ${MAX_JOB_LAUNCH_BATCH_SIZE}`,
    );
  }
  return value;
}

/** Prove a window's cursor names an instant and a job, or refuse (ADR-0105). */
export function validateJobLaunchCursor(value: JobLaunchCursor | null): JobLaunchCursor | null {
  if (value === null) return null;
  if (
    typeof value !== "object" ||
    !(value.createdAt instanceof Date) ||
    !Number.isFinite(value.createdAt.getTime()) ||
    typeof value.generationJobId !== "string" ||
    value.generationJobId.length === 0
  ) {
    throw new AppError("VALIDATION_FAILED", "Job launch cursor must name an instant and a job");
  }
  return value;
}

// ---------------------------------------------------------------------------
// Defects
// ---------------------------------------------------------------------------

export type JobLaunchDefectCode =
  /** The plan handed to the commit was not made from the facts handed with it. */
  | "PLAN_NOT_FOR_FACTS"
  /** The commit was handed attempt ids for another number of scenes than the plan's. */
  | "ATTEMPT_IDS_NOT_FOR_PLAN"
  /** Admission refused an attempt the commit had already checked it would admit. */
  | "ADMISSION_REFUSED"
  /** The organization's subscription names a plan the catalog does not hold. */
  | "PLAN_NOT_IN_CATALOG"
  /** An ending's write matched no row while holding that row's lock (GS-7d-1). */
  | "ENDING_LOST_UNDER_LOCK";

const DEFECT_MESSAGES: Record<JobLaunchDefectCode, string> = {
  PLAN_NOT_FOR_FACTS: "A job launch was handed a plan made from other facts",
  ATTEMPT_IDS_NOT_FOR_PLAN: "A job launch was handed attempt ids for another plan",
  ADMISSION_REFUSED: "A job launch's attempt admission refused a plan the launch had checked",
  PLAN_NOT_IN_CATALOG: "A job launch read a subscription whose plan the catalog does not hold",
  ENDING_LOST_UNDER_LOCK: "A waiting job's ending matched no row while holding that row's lock",
};

export class JobLaunchDefect extends Error {
  readonly code: JobLaunchDefectCode;

  constructor(code: JobLaunchDefectCode) {
    super(DEFECT_MESSAGES[code]);
    this.name = "JobLaunchDefect";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Event vocabulary
// ---------------------------------------------------------------------------

/** Fixed application-owned event types. Nothing external reaches these. */
export const JOB_LAUNCHED_EVENT_TYPE = "job.launched";
export const SCENE_LAUNCHED_EVENT_TYPE = "scene.launched";
/** The first attempt's admission and its request's start, written by the launch. */
export const ATTEMPT_ADMITTED_AT_LAUNCH_EVENT_TYPE = "attempt.admitted_at_launch";

/** The reason code recorded on every launch transition. */
export const JOB_LAUNCH_REASON_CODE = "JOB_LAUNCH";
