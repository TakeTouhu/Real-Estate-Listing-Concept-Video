/**
 * Which routes can make a whole job (GS-7a, ADR-0094), shared by the launch
 * planner and the start (GS-13c-1, ADR-0123).
 *
 * The planner asks it of a waiting job's frozen facts; the start asks it of the
 * storyboard it would copy into one, before any Unit is reserved, so a video
 * the launch could never route is not started (ADR-0052 Decision 19). One
 * function, so the two never disagree about what a route can make.
 */

import { authorizeRoute, type AuthorizedRoute, type RoutePolicy } from "../authorization/routing";
import { assertSettingsSupported, durationPolicyAccepts, type DurationPolicy } from "../generation/capability";
import {
  isSelectableModel,
  isTargetOutputResolution,
  planGenerationResolution,
  type TargetOutputResolution,
  type TargetResolutionDelivery,
  type VerifiedModelEntry,
  type VideoModelCatalog,
} from "../generation/model-catalog";
import { AUTHORIZED_AUDIO_MODE, AUTHORIZED_GENERATION_MODE } from "../orchestration/entitlement";
import type { GenerationQualityTier } from "../orchestration/types";

/** What route qualification reads: a waiting job's facts, or a storyboard a start would copy. */
export interface RouteQualificationFacts {
  readonly qualityTier: GenerationQualityTier;
  readonly aspectRatio: string;
  /** In position order. */
  readonly scenes: readonly { readonly durationSeconds: number; readonly cameraMotion: string | null }[];
}

/** A route that can make the whole job, and how its output reaches the target. */
export interface RouteChoice {
  readonly route: AuthorizedRoute;
  readonly delivery: TargetResolutionDelivery;
}

interface RouteCandidate extends RouteChoice {
  readonly entry: VerifiedModelEntry;
}

/**
 * Every authorized route the catalog can run at the job's quality and
 * resolution, in policy order, before any scene is looked at.
 */
function candidateRoutes(
  facts: RouteQualificationFacts,
  target: TargetOutputResolution,
  routes: RoutePolicy,
  models: VideoModelCatalog,
): RouteCandidate[] {
  const candidates: RouteCandidate[] = [];
  for (const route of routes.routes) {
    // Whether the route sells the job's resolution is the gate's check below.
    if (route.qualityTier !== facts.qualityTier) continue;
    // Admission refuses a price of any other mode (`PRICING_BINDING_INVALID`),
    // though a policy outside production may list one.
    if (route.generationMode !== AUTHORIZED_GENERATION_MODE) continue;
    if (route.audioMode !== AUTHORIZED_AUDIO_MODE) continue;

    const entry = models.find(route.requestModelKey);
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
      routes,
    );
    if (!authorized.ok) continue;
    candidates.push({ route, delivery, entry });
  }
  return candidates;
}

/**
 * Every scene's settings, by the check a single-scene admission makes: nothing
 * later checks them all before the provider is sent them (the preflight
 * repeats only the native tier's). A rendered prompt never carries a customer
 * negative prompt (`renderPrompt` refuses one).
 */
function scenesAccepted(facts: RouteQualificationFacts, candidate: RouteCandidate): boolean {
  const native = candidate.delivery.nativeGenerationResolution.providerValue;
  return facts.scenes.every((scene) => {
    try {
      assertSettingsSupported(
        {
          durationSeconds: scene.durationSeconds,
          nativeGenerationResolution: native,
          aspectRatio: facts.aspectRatio,
          cameraMotion: scene.cameraMotion,
          negativePrompt: null,
        },
        candidate.entry.capability,
      );
      return true;
    } catch {
      return false;
    }
  });
}

/** Every authorized route the catalog can run for this whole job, in policy order. */
export function qualifyingRoutes(
  facts: RouteQualificationFacts,
  target: TargetOutputResolution,
  routes: RoutePolicy,
  models: VideoModelCatalog,
): RouteChoice[] {
  return candidateRoutes(facts, target, routes, models)
    .filter((candidate) => scenesAccepted(facts, candidate))
    .map(({ route, delivery }) => ({ route, delivery }));
}

/** Whether the launch would find one route for a storyboard, or why it would not. */
export type StartRouteVerdict =
  /** Exactly one route can make it, as the planner requires. */
  | { readonly kind: "ONE_ROUTE" }
  /**
   * The one route that serves the project's quality cannot make some scenes
   * at their length: the lengths it accepts, and those scenes' positions in
   * the storyboard (from 0), in order.
   */
  | { readonly kind: "SCENE_LENGTHS"; readonly durations: DurationPolicy; readonly scenes: readonly number[] }
  /** No route, or more than one: the planner would refuse it (`NO_ROUTE`, `AMBIGUOUS_ROUTE`). */
  | { readonly kind: "NO_ROUTE" };

/**
 * The start's question (ADR-0123): would the launch find exactly one route for
 * this storyboard, as the planner does for the job copied from it?
 *
 * A length is the one setting a member chooses per scene, so when the only
 * route at the project's quality and resolution refuses some scenes for their
 * length, it names them and the lengths it accepts. Any other answer is a
 * project, a route table or a catalog the member cannot fix from the
 * storyboard.
 */
export function judgeStartRoute(
  facts: RouteQualificationFacts & { readonly targetOutputResolution: string },
  routes: RoutePolicy,
  models: VideoModelCatalog,
): StartRouteVerdict {
  const target = facts.targetOutputResolution;
  if (!isTargetOutputResolution(target)) return { kind: "NO_ROUTE" };
  const candidates = candidateRoutes(facts, target, routes, models);
  const accepting = candidates.filter((candidate) => scenesAccepted(facts, candidate));
  if (accepting.length === 1) return { kind: "ONE_ROUTE" };
  if (accepting.length > 1 || candidates.length !== 1) return { kind: "NO_ROUTE" };

  const durations = (candidates[0] as RouteCandidate).entry.capability.durationSeconds;
  const scenes = facts.scenes.flatMap((scene, index) =>
    durationPolicyAccepts(scene.durationSeconds, durations) ? [] : [index],
  );
  return scenes.length === 0 ? { kind: "NO_ROUTE" } : { kind: "SCENE_LENGTHS", durations, scenes };
}
