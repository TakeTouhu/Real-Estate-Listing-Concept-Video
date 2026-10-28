/**
 * The launch planner's ports (GS-7a, ADR-0094).
 *
 * The planner turns a waiting job's frozen facts into one admission per scene:
 * the route every scene is sent by, the provider prompt, and a fresh price. It
 * decides nothing about capacity and writes nothing. The launch commit (GS-7b)
 * re-reads everything under its own locks and admits these plans or nothing.
 */

import type { ResolutionNormalization } from "../generation/model-catalog";
import type { GenerationQualityTier } from "../orchestration/types";
import type { FxSnapshot } from "../pricing/provider-pricing-contract";
import type { PricingSnapshot } from "../pricing/pricing-snapshot";
import type { EpochMillis } from "../pricing/units";

/** One scene of the waiting job, as the start copied it (ADR-0087). */
export interface JobLaunchSceneFacts {
  readonly generationSceneId: string;
  /** The scene's first request, which the start made with it. */
  readonly initialRequestId: string;
  readonly durationSeconds: number;
  /** The frozen compiled prompt, or `null` when the scene has none. Never logged. */
  readonly compiledPrompt: string | null;
}

/** The waiting job's frozen facts. Read without locks: a hint, re-checked at commit. */
export interface JobLaunchFacts {
  readonly generationJobId: string;
  readonly qualityTier: GenerationQualityTier;
  /** The job's snapshot of the project's resolution, as stored. */
  readonly targetOutputResolution: string;
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
  /** No authorized route serves the job's quality and resolution and every scene's length. */
  | "NO_ROUTE"
  /** More than one does, and the model catalog's default is not exactly one of them. */
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
