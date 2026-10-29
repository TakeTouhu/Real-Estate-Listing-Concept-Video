/**
 * Plan a waiting job's launch: one route for the whole job, and for each scene
 * its provider prompt and a fresh price (GS-7a, ADR-0094).
 *
 * ## One route, chosen not guessed
 *
 * Every scene of a job is sent by the same route, so one video is not stitched
 * from two models. A route qualifies when the route policy authorizes it for
 * the job's quality and resolution, it is of the one generation and audio mode
 * admission prices, the model catalog holds its model as selectable under the
 * same provider and model id, delivers the job's resolution from the route's
 * own native tier, and accepts every scene's settings as admission's own check
 * does. When more than one qualifies, nothing is planned: which provider to
 * prefer is a product decision not made yet, and this planner does not make it
 * up.
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
import { assertSettingsSupported } from "../generation/capability";
import {
  isSelectableModel,
  isTargetOutputResolution,
  planGenerationResolution,
  type TargetOutputResolution,
  type TargetResolutionDelivery,
  type VideoModelCatalog,
} from "../generation/model-catalog";
import { renderPrompt } from "../generation/prompt-render";
import type { FxRateSource } from "../media-recovery/ports";
import {
  AUTHORIZED_AUDIO_MODE,
  AUTHORIZED_GENERATION_MODE,
  riskProfileKeyForQualityTier,
} from "../orchestration/entitlement";
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
  readonly delivery: TargetResolutionDelivery;
}

function noPlan(code: JobLaunchNoPlanCode): JobLaunchPlan {
  return { kind: "NO_PLAN", code };
}

/** The codes for a job's own frozen facts: no configuration ever makes such a job plannable. */
export type FrozenFactsCode = Extract<
  JobLaunchNoPlanCode,
  "TARGET_RESOLUTION_UNKNOWN" | "NO_SCENES" | "SCENE_PROMPT_MISSING" | "SCENE_PROMPT_UNRENDERABLE"
>;

const FROZEN_FACTS_CODES: readonly JobLaunchNoPlanCode[] = deepFreeze([
  "TARGET_RESOLUTION_UNKNOWN",
  "NO_SCENES",
  "SCENE_PROMPT_MISSING",
  "SCENE_PROMPT_UNRENDERABLE",
]);

/** Whether the planner refused a job for its own facts, rather than for a catalog, a price or a rate. */
export function isFrozenFactsCode(code: JobLaunchNoPlanCode): code is FrozenFactsCode {
  return FROZEN_FACTS_CODES.includes(code);
}

export type FrozenFactsCheck =
  | {
      readonly ok: true;
      readonly target: TargetOutputResolution;
      /** Each scene's compiled prompt and what it renders to, in the scenes' order. */
      readonly prompts: readonly { readonly compiled: string; readonly rendered: string }[];
    }
  | { readonly ok: false; readonly code: FrozenFactsCode };

/**
 * The job's own facts, before any catalog is consulted: the planner's first
 * step, and the ending's check that a job can never launch (GS-7d-1). The
 * facts were copied at the start and nothing writes them again, so a job that
 * fails here fails on every pass.
 */
export function checkFrozenFacts(facts: {
  readonly targetOutputResolution: string;
  readonly scenes: readonly { readonly compiledPrompt: string | null }[];
}): FrozenFactsCheck {
  const target = facts.targetOutputResolution;
  if (!isTargetOutputResolution(target)) return { ok: false, code: "TARGET_RESOLUTION_UNKNOWN" };
  if (facts.scenes.length === 0) return { ok: false, code: "NO_SCENES" };

  // Rendered once, here, as for every new attempt (ADR-0023): the renderer
  // refuses a corrupt or old-shaped prompt rather than sending a plausible one.
  const prompts: { readonly compiled: string; readonly rendered: string }[] = [];
  for (const scene of facts.scenes) {
    if (scene.compiledPrompt === null) return { ok: false, code: "SCENE_PROMPT_MISSING" };
    try {
      prompts.push({ compiled: scene.compiledPrompt, rendered: renderPrompt(scene.compiledPrompt) });
    } catch {
      return { ok: false, code: "SCENE_PROMPT_UNRENDERABLE" };
    }
  }
  return { ok: true, target, prompts };
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
    const frozen = checkFrozenFacts(facts);
    if (!frozen.ok) return noPlan(frozen.code);
    const { target, prompts } = frozen;

    // ---- 2. One route for the whole job. ----------------------------------
    const choices = this.#qualifyingRoutes(facts, target);
    if (choices.length === 0) return noPlan("NO_ROUTE");
    // Not the catalog's default, nor the policy's order: neither was decided as
    // the answer to which of two sellable routes a job takes.
    if (choices.length > 1) return noPlan("AMBIGUOUS_ROUTE");
    const { route, delivery } = choices[0] as RouteChoice;

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
    // A copy, so freezing the plan never freezes an object the source keeps.
    const fx: FxSnapshot = { ...rate };

    // ---- 5. Each scene priced for its own length, at the same instant. ---
    const scenes: JobLaunchSceneAdmission[] = [];
    for (const [index, scene] of facts.scenes.entries()) {
      const snapshot = createPricingSnapshot({
        contract,
        // From the job, so an HQ job is never priced at the Normal buffer.
        riskProfileKey: riskProfileKeyForQualityTier(facts.qualityTier),
        requestedSeconds: scene.durationSeconds,
        pricingEffectiveAt: at,
        fx,
      });
      if (!snapshot.ok) return noPlan("NO_CURRENT_PRICING");
      const prompt = prompts[index] as { readonly compiled: string; readonly rendered: string };
      scenes.push({
        generationSceneId: scene.generationSceneId,
        generationSceneRequestId: scene.initialRequestId,
        compiledPrompt: prompt.compiled,
        requestRenderedPrompt: prompt.rendered,
        pricingSnapshot: snapshot.value,
        fxSnapshot: fx,
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
      // Admission refuses a price of any other mode (`PRICING_BINDING_INVALID`),
      // though a policy outside production may list one.
      if (route.generationMode !== AUTHORIZED_GENERATION_MODE) continue;
      if (route.audioMode !== AUTHORIZED_AUDIO_MODE) continue;

      const entry = this.#models.find(route.requestModelKey);
      if (entry === undefined || !isSelectableModel(entry)) continue;
      if (entry.providerName !== route.providerName) continue;
      if (entry.providerModelId !== route.providerModelId) continue;

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

      // Every scene's settings, by the check a single-scene admission makes:
      // nothing later checks them all before the provider is sent them (the
      // preflight repeats only the native tier's). A rendered prompt never
      // carries a customer negative prompt (`renderPrompt` refuses one).
      const native = delivery.nativeGenerationResolution.providerValue;
      const settingsAccepted = facts.scenes.every((scene) => {
        try {
          assertSettingsSupported(
            {
              durationSeconds: scene.durationSeconds,
              nativeGenerationResolution: native,
              aspectRatio: facts.aspectRatio,
              cameraMotion: scene.cameraMotion,
              negativePrompt: null,
            },
            entry.capability,
          );
          return true;
        } catch {
          return false;
        }
      });
      if (!settingsAccepted) continue;

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
      choices.push({ route, delivery });
    }
    return choices;
  }
}
