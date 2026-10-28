/**
 * Plan a waiting job's launch: one route for the whole job, and for each scene
 * its provider prompt and a fresh price (GS-7a, ADR-0094).
 *
 * ## One route, chosen not guessed
 *
 * Every scene of a job is sent by the same route, so one video is not stitched
 * from two models. A route qualifies when the route policy authorizes it for
 * the job's quality and resolution, the model catalog holds its model as
 * selectable under the same provider and model id, delivers the job's
 * resolution from the route's own native tier, and accepts every scene's
 * length. When more than one qualifies, the catalog's default model decides;
 * when it does not name exactly one of them, nothing is planned. Which provider
 * to prefer is a product decision this planner does not make up.
 *
 * ## Priced now
 *
 * Every scene is priced at one instant, against the one verified contract in
 * force for the route, at the rate the FX source gives now, as a media
 * recovery is (Phase 4C). The paid-submission gate re-derives the cost from the
 * same contract before anything is sent.
 *
 * ## Outside every transaction
 *
 * Planning reads catalogs and a rate source, and a rate is a rate from
 * somewhere. It runs before the launch commit and hands it a finished plan,
 * which the commit binds to its attempts or refuses whole.
 */

import { deepFreeze } from "@app/shared";
import { authorizeRoute, type AuthorizedRoute, type RoutePolicy } from "../authorization/routing";
import { durationPolicyAccepts } from "../generation/capability";
import {
  isSelectableModel,
  isTargetOutputResolution,
  planGenerationResolution,
  type TargetOutputResolution,
  type TargetResolutionDelivery,
  type VerifiedModelEntry,
  type VideoModelCatalog,
} from "../generation/model-catalog";
import { renderPrompt } from "../generation/prompt-render";
import type { FxRateSource } from "../media-recovery/ports";
import { riskProfileKeyForQualityTier } from "../orchestration/entitlement";
import { currentlyEligibleContractsForRoute } from "../pricing/pricing-eligibility";
import { createPricingSnapshot } from "../pricing/pricing-snapshot";
import { validateFxSnapshot } from "../pricing/provider-cost-calculator";
import type { ProviderPricingCatalog } from "../pricing/provider-pricing-catalog";
import type { FxSnapshot, ProviderPricingContract } from "../pricing/provider-pricing-contract";
import { epochMillis } from "../pricing/units";
import type {
  JobLaunchFacts,
  JobLaunchNoPlanCode,
  JobLaunchPlan,
  JobLaunchSceneAdmission,
} from "./ports";

export interface JobLaunchPlannerDeps {
  /** Production's, or the test route's outside production (ADR-0089). The gate's own. */
  readonly routes: RoutePolicy;
  readonly models: VideoModelCatalog;
  readonly pricing: ProviderPricingCatalog;
  readonly fx: FxRateSource;
  /** Injected, so the pricing instant is a decision rather than ambient time. */
  readonly clock: () => number;
}

interface RouteChoice {
  readonly route: AuthorizedRoute;
  readonly entry: VerifiedModelEntry;
  readonly delivery: TargetResolutionDelivery;
}

function noPlan(code: JobLaunchNoPlanCode): JobLaunchPlan {
  return { kind: "NO_PLAN", code };
}

export class JobLaunchPlanner {
  readonly #routes: RoutePolicy;
  readonly #models: VideoModelCatalog;
  readonly #pricing: ProviderPricingCatalog;
  readonly #fx: FxRateSource;
  readonly #clock: () => number;

  constructor(deps: JobLaunchPlannerDeps) {
    this.#routes = deps.routes;
    this.#models = deps.models;
    this.#pricing = deps.pricing;
    this.#fx = deps.fx;
    this.#clock = deps.clock;
  }

  async plan(facts: JobLaunchFacts): Promise<JobLaunchPlan> {
    // ---- 1. The job's own facts, before any catalog is consulted. --------
    const target = facts.targetOutputResolution;
    if (!isTargetOutputResolution(target)) return noPlan("TARGET_RESOLUTION_UNKNOWN");
    if (facts.scenes.length === 0) return noPlan("NO_SCENES");

    // Rendered once, here, as for every new attempt (ADR-0023): the renderer
    // refuses a corrupt or old-shaped prompt rather than sending a plausible one.
    const prompts: string[] = [];
    for (const scene of facts.scenes) {
      if (scene.compiledPrompt === null) return noPlan("SCENE_PROMPT_MISSING");
      try {
        prompts.push(renderPrompt(scene.compiledPrompt));
      } catch {
        return noPlan("SCENE_PROMPT_UNRENDERABLE");
      }
    }

    // ---- 2. One route for the whole job. ----------------------------------
    const choices = this.#qualifyingRoutes(facts, target);
    if (choices.length === 0) return noPlan("NO_ROUTE");
    const defaultKey = this.#models.default().key;
    const chosen = choices.length === 1 ? choices : choices.filter((c) => c.entry.key === defaultKey);
    if (chosen.length !== 1) return noPlan("AMBIGUOUS_ROUTE");
    const { route, delivery } = chosen[0] as RouteChoice;

    // ---- 3. The one verified contract in force for it. --------------------
    const at = epochMillis(this.#clock());
    const contracts = currentlyEligibleContractsForRoute(
      this.#pricing,
      {
        provider: route.providerName,
        pricingModelKey: route.requestModelKey,
        generationMode: route.generationMode,
        nativeTier: route.nativeGenerationResolution,
        audioMode: route.audioMode,
      },
      at,
    );
    if (contracts.length === 0) return noPlan("NO_CURRENT_PRICING");
    // Two in force for one route is a catalog nothing can bill against
    // unambiguously. Taking the first would silently pick a price.
    if (contracts.length > 1) return noPlan("AMBIGUOUS_CURRENT_PRICING");
    const contract = contracts[0] as ProviderPricingContract;

    // ---- 4. A usable rate, read last, and only once there is a price. ----
    // A source that throws is a rate that cannot be read now; nothing it said
    // travels further.
    let rate: FxSnapshot | null;
    try {
      rate = await this.#fx.current();
    } catch {
      return noPlan("NO_FX_RATE");
    }
    if (rate === null || !validateFxSnapshot(rate).ok) return noPlan("NO_FX_RATE");

    // ---- 5. Each scene priced for its own length, at the same instant. ---
    const scenes: JobLaunchSceneAdmission[] = [];
    for (const [index, scene] of facts.scenes.entries()) {
      const snapshot = createPricingSnapshot({
        contract,
        // From the job, so an HQ job is never priced at the Normal buffer.
        riskProfileKey: riskProfileKeyForQualityTier(facts.qualityTier),
        requestedSeconds: scene.durationSeconds,
        pricingEffectiveAt: at,
        fx: rate,
      });
      if (!snapshot.ok) return noPlan("NO_CURRENT_PRICING");
      scenes.push({
        generationSceneId: scene.generationSceneId,
        generationSceneRequestId: scene.initialRequestId,
        requestRenderedPrompt: prompts[index] as string,
        pricingSnapshot: snapshot.value,
        fxSnapshot: rate,
      });
    }

    return deepFreeze({
      kind: "PLANNED",
      route: {
        providerName: route.providerName,
        providerModelId: route.providerModelId,
        requestModelKey: route.requestModelKey,
        requestNativeGenerationResolution: route.nativeGenerationResolution,
        requestResolutionNormalization: delivery.normalization,
        requestNativeMeetsTarget: delivery.nativeMeetsTarget,
      },
      scenes,
      plannedAt: at,
    } satisfies JobLaunchPlan);
  }

  /** Every authorized route the catalog can run for this whole job, in policy order. */
  #qualifyingRoutes(facts: JobLaunchFacts, target: TargetOutputResolution): RouteChoice[] {
    const choices: RouteChoice[] = [];
    for (const route of this.#routes.routes) {
      // Whether the route sells the job's resolution is the gate's check below.
      if (route.qualityTier !== facts.qualityTier) continue;

      const entry = this.#models.find(route.requestModelKey);
      if (entry === undefined || !isSelectableModel(entry)) continue;
      if (entry.providerName !== route.providerName) continue;
      if (entry.providerModelId !== route.providerModelId) continue;
      const lengths = entry.capability.durationSeconds;
      if (!facts.scenes.every((scene) => durationPolicyAccepts(scene.durationSeconds, lengths))) continue;

      // An unsupported target is an ordinary reason to skip a route here,
      // though `planGenerationResolution` throws for it at its own boundary.
      let delivery: TargetResolutionDelivery;
      try {
        delivery = planGenerationResolution(entry, target);
      } catch {
        continue;
      }
      // The catalog must reach the target from the tier the route is sold at.
      if (delivery.nativeGenerationResolution.providerValue !== route.nativeGenerationResolution) continue;

      // The gate's own check, so a plan never admits what it would refuse: it
      // matches a route by model id first, and a second route for the same
      // model at another tier is not one it can authorize.
      const authorized = authorizeRoute(
        {
          qualityTier: facts.qualityTier,
          providerName: route.providerName,
          providerModelId: route.providerModelId,
          requestModelKey: route.requestModelKey,
          nativeGenerationResolution: route.nativeGenerationResolution,
          targetOutputResolution: target,
          generationMode: route.generationMode,
          audioMode: route.audioMode,
        },
        this.#routes,
      );
      if (!authorized.ok) continue;
      choices.push({ route, entry, delivery });
    }
    return choices;
  }
}
