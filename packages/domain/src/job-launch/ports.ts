/**
 * The job launch's ports: the planner's (GS-7a, ADR-0094) and the launch
 * commit's (GS-7b, ADR-0095).
 *
 * The planner turns a waiting job's frozen facts into one admission per scene:
 * the route every scene is sent by, the provider prompt, and a fresh price. It
 * decides nothing about capacity and writes nothing. The launch commit (GS-7b)
 * re-reads everything under its own locks and admits these plans or nothing.
 */

import type { ResolutionNormalization } from "../generation/model-catalog";
import type { TransitionContext } from "../orchestration/ports";
import type { GenerationQualityTier } from "../orchestration/types";
import type { FxSnapshot } from "../pricing/provider-pricing-contract";
import type { PricingSnapshot } from "../pricing/pricing-snapshot";
import type { EpochMillis } from "../pricing/units";
import type { UnlaunchableJobCause, UnlaunchableJobEndingRefusal } from "./ending";
import type { JobLaunchRefusal } from "./launch";

/** One scene of the waiting job, as the start copied it (ADR-0087). */
export interface JobLaunchSceneFacts {
  readonly generationSceneId: string;
  /** The scene's first request, which the start made with it. */
  readonly initialRequestId: string;
  readonly durationSeconds: number;
  /** As frozen on the scene; admission binds it into the request. */
  readonly cameraMotion: string | null;
  /** The frozen compiled prompt, or `null` when the scene has none. Never logged. */
  readonly compiledPrompt: string | null;
}

/** The waiting job's frozen facts. Read without locks: a hint, re-checked at commit. */
export interface JobLaunchFacts {
  readonly qualityTier: GenerationQualityTier;
  /** The job's snapshot of the project's resolution, as stored. */
  readonly targetOutputResolution: string;
  /** The job's snapshot of the project's aspect ratio; admission binds it into the request. */
  readonly aspectRatio: string;
  /** In position order. */
  readonly scenes: readonly JobLaunchSceneFacts[];
}

/** Where every scene of the job is sent, and how its output reaches the target. */
export interface JobLaunchRoute {
  readonly providerName: string;
  readonly providerModelId: string;
  readonly requestModelKey: string;
  readonly requestNativeGenerationResolution: string;
  readonly requestResolutionNormalization: ResolutionNormalization;
  readonly requestNativeMeetsTarget: boolean;
}

/** What one scene's first attempt is admitted with. Ids are the commit's to give. */
export interface JobLaunchSceneAdmission {
  readonly generationSceneId: string;
  readonly generationSceneRequestId: string;
  /**
   * The compiled prompt the rendered one came from. Admission stores the
   * rendered prompt as given, so the launch commit compares this with the
   * scene it locks before admitting. Never logged.
   */
  readonly compiledPrompt: string;
  /** Rendered once, here; the provider is sent exactly this. */
  readonly requestRenderedPrompt: string;
  readonly pricingSnapshot: PricingSnapshot;
  readonly fxSnapshot: FxSnapshot;
}

/**
 * Why a waiting job cannot be planned now.
 *
 * A fixed code and nothing else: no prompt, no provider text, no identifier.
 * Some can pass (a rate that cannot be read now), others never will (a scene
 * with no prompt). Which a job that can never launch is released for is GS-7d's
 * decision, not this planner's.
 */
export type JobLaunchNoPlanCode =
  /** The stored resolution is outside the product's vocabulary. */
  | "TARGET_RESOLUTION_UNKNOWN"
  | "NO_SCENES"
  | "SCENE_PROMPT_MISSING"
  /** The stored compiled prompt does not render: it is corrupt or of an old shape. */
  | "SCENE_PROMPT_UNRENDERABLE"
  /**
   * No authorized route serves the job's quality and resolution, every scene's
   * settings, and the generation and audio mode admission prices.
   */
  | "NO_ROUTE"
  /** More than one does. Which to prefer is not decided (`docs/decisions/TODO.md`). */
  | "AMBIGUOUS_ROUTE"
  /** No verified price is in force for the route, or one scene's length cannot be priced. */
  | "NO_CURRENT_PRICING"
  | "AMBIGUOUS_CURRENT_PRICING"
  /** No usable exchange rate, or the source could not be read. */
  | "NO_FX_RATE";

export type JobLaunchPlan =
  | {
      readonly kind: "PLANNED";
      readonly route: JobLaunchRoute;
      /** One per scene, in the facts' order. */
      readonly scenes: readonly JobLaunchSceneAdmission[];
      /** The instant every scene was priced at. */
      readonly plannedAt: EpochMillis;
    }
  | { readonly kind: "NO_PLAN"; readonly code: JobLaunchNoPlanCode };

// ---------------------------------------------------------------------------
// The launch commit (GS-7b, ADR-0095)
// ---------------------------------------------------------------------------

/**
 * An organization's next waiting job, while a place looks free. A hint: the
 * commit re-decides all of it under its own locks.
 */
export interface JobLaunchCandidate {
  readonly organizationId: string;
  readonly generationJobId: string;
  /**
   * Read without a lock, for the planner. `null` when a scene does not have
   * exactly one first request, a shape only another writer could have made;
   * the commit would refuse it as `SHAPE_CONFLICT`.
   */
  readonly facts: JobLaunchFacts | null;
}

export interface JobLaunchCandidateQuery {
  /** At most this many organizations, one candidate each. */
  readonly limit: number;
}

/** Ids for one scene's first attempt. Opaque and fresh, never derived. */
export interface JobLaunchAttemptIds {
  readonly attemptId: string;
  readonly pricingSnapshotId: string;
}

export interface LaunchJobInput {
  /**
   * The tenant the caller believes owns the job. Never trusted on its own:
   * every read and lock proves it through the job's project.
   */
  readonly organizationId: string;
  readonly generationJobId: string;
  /** The facts the plan was made from; the commit compares them with the rows it locks. */
  readonly facts: JobLaunchFacts;
  readonly plan: Extract<JobLaunchPlan, { kind: "PLANNED" }>;
  /** One per planned scene, in the plan's order. */
  readonly attemptIds: readonly JobLaunchAttemptIds[];
  readonly context: TransitionContext;
}

/** How a launch commit ended. Only `LAUNCHED` wrote anything. */
export type LaunchJobOutcome =
  | {
      readonly kind: "LAUNCHED";
      readonly generationJobId: string;
      /** The first attempts admitted, one per scene, in position order. */
      readonly attemptIds: readonly string[];
    }
  /** The organization has no subscription, so no limit to launch under. The job waits. */
  | { readonly kind: "NO_SUBSCRIPTION" }
  /** Every place is taken. The job waits. */
  | { readonly kind: "AT_LIMIT" }
  /** An older waiting job of the organization launches first. */
  | { readonly kind: "NOT_NEXT" }
  /**
   * An identical request of the same project is still at work: the same video
   * started twice. One project never has two identical requests at the provider
   * at once (the active-request index), so the job waits until it ends.
   */
  | { readonly kind: "SAME_REQUEST_RUNNING" }
  | { readonly kind: "NOT_LAUNCHABLE"; readonly reason: JobLaunchRefusal };

export interface JobLaunchRepository {
  /** Bounded, deterministic, one per organization, oldest waiting job first. A hint only. */
  findJobLaunchCandidates(query: JobLaunchCandidateQuery): Promise<readonly JobLaunchCandidate[]>;

  /**
   * Launch the job, in one short database transaction with no external I/O:
   * the job and its scenes start and each scene's first attempt is admitted,
   * or nothing is written.
   */
  launchJob(input: LaunchJobInput): Promise<LaunchJobOutcome>;
}

// ---------------------------------------------------------------------------
// The ending of a waiting job that can never launch (GS-7d-1, ADR-0099)
// ---------------------------------------------------------------------------

/** A waiting job of a deleted Property. A hint: the ending decides again under its own locks. */
export interface PropertyDeletedWaitingJob {
  readonly organizationId: string;
  readonly generationJobId: string;
}

export interface EndUnlaunchableJobInput {
  /** As for a launch: never trusted on its own, proved through the job's project. */
  readonly organizationId: string;
  readonly generationJobId: string;
  /** The release instant, stamped on the reservation. */
  readonly endedAt: EpochMillis;
  readonly context: TransitionContext;
}

/** How an ending commit ended. Only `ENDED` wrote anything. */
export type EndUnlaunchableJobOutcome =
  /** The job failed and its Units were released, for this cause. */
  | { readonly kind: "ENDED"; readonly cause: UnlaunchableJobCause }
  | { readonly kind: "NOT_ENDED"; readonly reason: UnlaunchableJobEndingRefusal };

export interface UnlaunchableJobEndingRepository {
  /**
   * Bounded, oldest first: waiting jobs whose Property is deleted, which the
   * launch's candidates pass over. Mirrors every refusal of the ending.
   */
  findPropertyDeletedWaitingJobs(query: JobLaunchCandidateQuery): Promise<readonly PropertyDeletedWaitingJob[]>;

  /**
   * End the job, in one short database transaction with no external I/O: it
   * fails and its reservation is released, or nothing is written.
   */
  endUnlaunchableJob(input: EndUnlaunchableJobInput): Promise<EndUnlaunchableJobOutcome>;
}
