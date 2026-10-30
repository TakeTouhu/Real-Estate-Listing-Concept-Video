import { AppError } from "@app/shared";
import { PRODUCTION_ROUTE_POLICY, servesQualityTier, type RoutePolicy } from "../authorization/routing";
import { DEFAULT_DISCLOSURE_MODE } from "../disclosure/mode";
import { planUnitAllocation, type PeriodEntitlementBalance } from "../entitlement/allocation";
import { entitlementSnapshotForPlan } from "../entitlement/plan-entitlement";
import type { GenerationReservationAllocation, UnitEntitlementRepository } from "../entitlement/ports";
import {
  isRenewalPeriod,
  renewalPeriodAt,
  renewEntitlementPeriod,
  type SubscriptionRepository,
} from "../entitlement/subscription";
import { MAX_IDEMPOTENCY_KEY_LENGTH } from "../entitlement/unit-purchase";
import type { StoryboardReader } from "../generation/ports";
import { authorizeOrganization } from "../identity/authorization";
import type { IdentityServiceDeps } from "../identity/ports";
import type { PropertyRepository } from "../property/ports";
import { findReachableProperty } from "../property/reach";
import { assertApprovedCameraMotion, isCameraMotion } from "../storyboard/camera-motion";
import type { StoryboardView } from "../storyboard/storyboard-service";
import type { StoryboardScene, VideoProject } from "../storyboard/types";
import { requiredUnitsFor } from "./entitlement";
import type { GenerationJob, GenerationReservation } from "./ports";
import { qualityTierForResolution, type GenerationStartRecord, type GenerationStartRepository } from "./start";
import { sanitizeTransitionMetadata } from "./transition-metadata";
import type { GenerationQualityTier } from "./types";

/**
 * Starting a whole video: the start service (GS-4c, ADR-0088).
 *
 * Decides whether a member may start the video a project's storyboard
 * describes, and builds what the start commit (ADR-0087) records. Its offer
 * (GS-10a, ADR-0109) is what the start screen shows before the customer
 * confirms. Nothing outside tests constructs it until the start route (GS-10).
 */

/** Audit vocabulary for the start. One entry per started job, written in its commit. */
export const GENERATION_START_AUDIT_ACTION = { Started: "generation.started" } as const;

/** The `resourceType` the start's audit entry carries. Table-name form. */
export const GENERATION_JOB_AUDIT_RESOURCE_TYPE = "generation_job";

/** Which qualities a start may be made at: those a verified route serves. */
export interface StartQualityOffer {
  offers(qualityTier: GenerationQualityTier): boolean;
}

/**
 * The qualities a route policy serves: listed, with a route, as the
 * paid-submission gate checks them against the same policy (ADR-0089).
 */
export function routeQualityOffer(policy: RoutePolicy): StartQualityOffer {
  return { offers: (qualityTier) => servesQualityTier(policy, qualityTier) };
}

/**
 * Today's offer: the qualities the production route table authorizes, which is
 * Normal only. An HQ start would reserve Units for attempts the paid-submission
 * gate refuses, so it is refused before anything is reserved.
 */
export const AUTHORIZED_ROUTE_QUALITY_OFFER: StartQualityOffer = routeQualityOffer(PRODUCTION_ROUTE_POLICY);

export interface GenerationStartServiceDeps {
  /** Membership lookup for authorization and reach, the clock and ids. */
  readonly identity: IdentityServiceDeps;
  readonly properties: Pick<PropertyRepository, "findById">;
  readonly storyboard: Pick<StoryboardReader, "getStoryboard">;
  readonly qualities: StartQualityOffer;
  readonly subscriptions: Pick<SubscriptionRepository, "findByOrganization">;
  readonly ledger: Pick<UnitEntitlementRepository, "openPeriod" | "findPeriodAt" | "balance">;
  readonly starts: GenerationStartRepository;
}

export interface StartGenerationInput {
  readonly organizationId: string;
  readonly videoProjectId: string;
  /** One per start the customer confirms. A retry of that start sends the same key. */
  readonly idempotencyKey: string;
  /** What the start screen showed, and the customer confirmed. */
  readonly confirmed: {
    readonly qualityTier: GenerationQualityTier;
    /** The storyboard's scenes in position order. Each composition gives new ids. */
    readonly storyboardSceneIds: readonly string[];
  };
}

/** How a start ended. Only `STARTED` wrote a job or reserved a Unit. */
export type StartGenerationOutcome =
  | {
      readonly kind: "STARTED";
      readonly job: GenerationJob;
      readonly reservation: GenerationReservation;
      readonly allocations: readonly GenerationReservationAllocation[];
    }
  /** This start key already started this job. */
  | { readonly kind: "ALREADY_STARTED"; readonly job: GenerationJob }
  /** The storyboard is no longer the one the customer confirmed. */
  | { readonly kind: "STORYBOARD_CHANGED" }
  /** The project's resolution no longer gives the quality the customer confirmed. */
  | { readonly kind: "QUALITY_CHANGED" }
  /** No verified route serves the project's quality yet. */
  | { readonly kind: "QUALITY_NOT_OFFERED" }
  /** The storyboard is longer than a video the product sells. */
  | { readonly kind: "LENGTH_NOT_SUPPORTED" }
  /** The organization has no plan, or its plan has not started. */
  | { readonly kind: "NO_PLAN" }
  | { readonly kind: "INSUFFICIENT_UNITS"; readonly eligibleUnits: number };

/**
 * What the start screen shows (GS-10a, ADR-0109). `READY` is the only offer of
 * a start; every other kind is why the start would not happen now.
 */
export type StartOffer =
  | {
      readonly kind: "READY";
      readonly qualityTier: GenerationQualityTier;
      /** The storyboard's scenes in position order: what the customer confirms. */
      readonly scenes: readonly { readonly id: string; readonly durationSeconds: number }[];
      readonly durationSeconds: number;
      readonly requiredUnits: number;
      /**
       * Where the Units would come from if the start were made now: Base Units
       * first, then additional Units of the same quality. A forecast; the start
       * plans again under its locks.
       */
      readonly funding: { readonly baseUnits: number; readonly addOnUnits: number };
    }
  /** The project has no composed storyboard. */
  | { readonly kind: "NOT_COMPOSED" }
  /** The approved photos have changed since the storyboard was composed. */
  | { readonly kind: "STALE" }
  /** A scene was composed before generation could use it: the storyboard must be composed again. */
  | { readonly kind: "RECOMPOSE" }
  /** No verified route serves the project's quality yet. */
  | { readonly kind: "QUALITY_NOT_OFFERED"; readonly qualityTier: GenerationQualityTier }
  /** The storyboard is longer than a video the product sells. */
  | { readonly kind: "LENGTH_NOT_SUPPORTED"; readonly durationSeconds: number }
  /** The organization has no plan, or its plan has not started. */
  | { readonly kind: "NO_PLAN" }
  | {
      readonly kind: "INSUFFICIENT_UNITS";
      readonly qualityTier: GenerationQualityTier;
      readonly requiredUnits: number;
      /** How many of them the Units this video may use could cover now. */
      readonly eligibleUnits: number;
    };

export class GenerationStartService {
  constructor(private readonly deps: GenerationStartServiceDeps) {}

  /**
   * What a start of the project's storyboard would be now, for the start
   * screen: its quality, scenes, length and Units, or why it would not happen.
   *
   * **Reads only.** It judges in the start's own order, and reads the Unit
   * period the start would reserve from without opening it: a period nobody
   * has opened is read as opening it would freeze it (ADR-0066 Decision 3).
   *
   * @throws AppError FORBIDDEN when the member lacks `video.generate` or
   *   `unit.consume`, as the start does.
   * @throws AppError NOT_FOUND when the project is not this organization's, its
   *   Property is out of the member's reach, or the Property is deleted.
   * @throws AppError INTERNAL_ERROR when the Unit ledger disagrees with the
   *   subscription, which the start refuses too.
   */
  async offer(actorUserId: string, organizationId: string, videoProjectId: string): Promise<StartOffer> {
    const view = await this.reachableStoryboard(actorUserId, organizationId, videoProjectId);
    const project = view.project;
    if (project.compositionFingerprint === null || view.scenes.length === 0) return { kind: "NOT_COMPOSED" };
    if (!view.fresh) return { kind: "STALE" };

    const qualityTier = qualityTierForResolution(project.targetOutputResolution);
    if (!this.deps.qualities.offers(qualityTier)) return { kind: "QUALITY_NOT_OFFERED", qualityTier };
    const usable = (scene: StoryboardScene) =>
      scene.compiledPrompt !== null && (scene.cameraMotion === null || isCameraMotion(scene.cameraMotion));
    if (!view.scenes.every(usable)) return { kind: "RECOMPOSE" };
    const seconds = view.scenes.reduce((total, scene) => total + scene.durationSeconds, 0);
    const required = requiredUnitsFor(qualityTier, seconds);
    if (!required.ok) return { kind: "LENGTH_NOT_SUPPORTED", durationSeconds: seconds };

    const balance = await this.balanceAt(organizationId, this.deps.identity.clock.now());
    if (balance === null) return { kind: "NO_PLAN" };
    const requiredUnits = required.value.totalVideoUnits;
    const plan = planUnitAllocation({ quality: qualityTier, units: requiredUnits, balance });
    if (!plan.ok) {
      return { kind: "INSUFFICIENT_UNITS", qualityTier, requiredUnits, eligibleUnits: plan.eligibleUnits };
    }
    const baseUnits = plan.allocations
      .filter((allocation) => allocation.sourceType === "BASE")
      .reduce((total, allocation) => total + allocation.quantity, 0);
    return {
      kind: "READY",
      qualityTier,
      scenes: view.scenes.map((scene) => ({ id: scene.id, durationSeconds: scene.durationSeconds })),
      durationSeconds: seconds,
      requiredUnits,
      funding: { baseUnits, addOnUnits: requiredUnits - baseUnits },
    };
  }

  /**
   * Start the video a project's storyboard describes, or answer why not.
   *
   * Every check before the Unit period is opened only reads, and opening it
   * writes only the period this month's first Unit action would open, with
   * that period's own audit entry. So a refusal writes no job, no reservation
   * and no `generation.started` entry.
   *
   * @throws AppError VALIDATION_FAILED for an unusable start key, a project
   *   with no composed storyboard or a stale one, or a scene composed before
   *   generation could use it.
   * @throws AppError FORBIDDEN when the member lacks `video.generate` or
   *   `unit.consume`.
   * @throws AppError NOT_FOUND when the project is not this organization's, its
   *   Property is out of the member's reach (ADR-0064), or the Property is
   *   deleted: all answered alike.
   * @throws AppError INTERNAL_ERROR when the Unit ledger disagrees with the
   *   subscription, or the commit refuses what this service already settled.
   */
  async start(actorUserId: string, input: StartGenerationInput): Promise<StartGenerationOutcome> {
    const { organizationId, idempotencyKey } = input;
    if (idempotencyKey.length === 0 || idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
      throw new AppError("VALIDATION_FAILED", "A start needs a start key of 1 to 200 characters");
    }

    const view = await this.reachableStoryboard(actorUserId, organizationId, input.videoProjectId);
    const project = view.project;

    // A replay is answered before the storyboard is judged, so a retry still
    // finds its job after the customer recomposed or the photos changed.
    const started = await this.deps.starts.findStarted(organizationId, project.id, idempotencyKey);
    if (started !== null) return { kind: "ALREADY_STARTED", job: started };

    if (project.compositionFingerprint === null || view.scenes.length === 0) {
      throw new AppError("VALIDATION_FAILED", "This project has no composed storyboard");
    }
    if (!view.fresh) {
      throw new AppError(
        "VALIDATION_FAILED",
        "The approved photos have changed since this storyboard was composed; compose it again",
      );
    }
    if (!sameScenes(view.scenes, input.confirmed.storyboardSceneIds)) return { kind: "STORYBOARD_CHANGED" };

    const qualityTier = qualityTierForResolution(project.targetOutputResolution);
    if (qualityTier !== input.confirmed.qualityTier) return { kind: "QUALITY_CHANGED" };
    if (!this.deps.qualities.offers(qualityTier)) return { kind: "QUALITY_NOT_OFFERED" };

    // Each scene is copied as composed, so one composed before generation could
    // use it is refused now, before any Unit is reserved for it.
    for (const scene of view.scenes) {
      if (scene.compiledPrompt === null) {
        throw new AppError(
          "VALIDATION_FAILED",
          "A scene has no compiled prompt; compose the storyboard again before starting",
        );
      }
      assertApprovedCameraMotion(scene.cameraMotion);
    }
    const seconds = view.scenes.reduce((total, scene) => total + scene.durationSeconds, 0);
    if (!requiredUnitsFor(qualityTier, seconds).ok) return { kind: "LENGTH_NOT_SUPPORTED" };

    // The commit reserves from the period containing `now`; it is opened here
    // if nothing has opened it yet. Anything but an open period with a plan
    // behind it is the ledger disagreeing with the subscription: surfaced,
    // never started around.
    const now = this.deps.identity.clock.now();
    const renewed = await renewEntitlementPeriod(this.deps, organizationId, now);
    if (renewed.kind === "NO_SUBSCRIPTION" || renewed.kind === "NOT_STARTED") return { kind: "NO_PLAN" };
    if (renewed.kind === "PERIOD_CONFLICT") {
      throw new AppError("INTERNAL_ERROR", "The current Unit period could not be opened", {
        details: { organizationId },
      });
    }

    const outcome = await this.deps.starts.start(
      this.recordFor(actorUserId, input, project, view.scenes, qualityTier, now),
    );
    switch (outcome.kind) {
      case "STARTED":
        return {
          kind: "STARTED",
          job: outcome.job,
          reservation: outcome.reservation,
          allocations: outcome.allocations,
        };
      case "EXISTING":
        return { kind: "ALREADY_STARTED", job: outcome.job };
      case "PROJECT_NOT_FOUND":
      case "PROPERTY_DELETED":
        throw new AppError("NOT_FOUND", "Video project not found");
      case "STORYBOARD_CHANGED":
      case "QUALITY_CHANGED":
        return { kind: outcome.kind };
      case "DURATION_NOT_SUPPORTED":
        return { kind: "LENGTH_NOT_SUPPORTED" };
      case "INSUFFICIENT_ENTITLEMENT":
        return { kind: "INSUFFICIENT_UNITS", eligibleUnits: outcome.eligibleUnits };
      case "DISCLOSURE_MODE_NOT_SUPPORTED":
      case "NO_ENTITLEMENT_PERIOD":
        // Mode A and the period opened above are this service's own facts.
        throw new AppError("INTERNAL_ERROR", "The video could not be started", {
          details: { organizationId, refusal: outcome.kind },
        });
    }
  }

  /**
   * The project's storyboard, for a member who may generate and spend the
   * organization's Units (`unit.consume` is its own permission); nothing is
   * read for anyone else.
   *
   * The storyboard read answers a project out of reach as not found. A deleted
   * Property's photos await deletion and could not be generated from, so its
   * project is answered the same way rather than started; the commit checks it
   * again under its lock.
   */
  private async reachableStoryboard(
    actorUserId: string,
    organizationId: string,
    videoProjectId: string,
  ): Promise<StoryboardView> {
    const actor = await authorizeOrganization(this.deps.identity, actorUserId, organizationId, [
      "video.generate",
      "unit.consume",
    ]);
    const view = await this.deps.storyboard.getStoryboard(actorUserId, organizationId, videoProjectId);
    const property = await findReachableProperty(
      this.deps.identity,
      this.deps.properties,
      actor,
      view.project.propertyId,
    );
    if (property === null || property.status === "DELETED") {
      throw new AppError("NOT_FOUND", "Video project not found");
    }
    return view;
  }

  /**
   * What remains of the Unit period the start would reserve from at `at`, or
   * `null` when there is no plan or it has not started. Reads only: a period
   * nobody has opened holds the plan's whole allowance and no block.
   */
  private async balanceAt(organizationId: string, at: Date): Promise<PeriodEntitlementBalance | null> {
    const subscription = await this.deps.subscriptions.findByOrganization(organizationId);
    if (subscription === null) return null;
    const bounds = renewalPeriodAt(subscription.anchorAt, at);
    if (bounds === null) return null;
    const period = await this.deps.ledger.findPeriodAt(organizationId, at);
    if (period === null) {
      const snapshot = entitlementSnapshotForPlan(subscription.planKey);
      return {
        baseRemainingUnits: snapshot.baseUnits,
        includedHighQualityRemainingUnits: snapshot.includedHighQualityUnits,
        blocks: [],
      };
    }
    // Any other period there is one the start refuses to reserve around.
    const balance = isRenewalPeriod(period, subscription, bounds)
      ? await this.deps.ledger.balance(organizationId, period.id)
      : null;
    if (balance === null) {
      throw new AppError("INTERNAL_ERROR", "The current Unit period could not be read", {
        details: { organizationId },
      });
    }
    return balance;
  }

  /** The commit's record: new ids, the server clock, Mode A, and the audit entry. */
  private recordFor(
    actorUserId: string,
    input: StartGenerationInput,
    project: VideoProject,
    scenes: readonly StoryboardScene[],
    qualityTier: GenerationQualityTier,
    startedAt: Date,
  ): GenerationStartRecord {
    const { ids } = this.deps.identity;
    const { organizationId } = input;
    return {
      organizationId,
      videoProjectId: project.id,
      idempotencyKey: input.idempotencyKey,
      jobId: ids.generate("gjob"),
      reservationId: ids.generate("gres"),
      requestedByUserId: actorUserId,
      qualityTier,
      // The only mode today, and ADR-0052's default when there is a choice.
      disclosureMode: DEFAULT_DISCLOSURE_MODE,
      startedAt,
      storyboard: {
        // Non-null: a storyboard with no fingerprint was refused above.
        compositionFingerprint: project.compositionFingerprint!,
        scenes: scenes.map((scene) => ({
          storyboardSceneId: scene.id,
          generationSceneId: ids.generate("gscn"),
          initialRequestId: ids.generate("greq"),
        })),
      },
      context: {
        actorType: "USER",
        actorUserId,
        correlationId: ids.generate("corr"),
        causationId: null,
        reasonCode: null,
        metadata: sanitizeTransitionMetadata({}),
        eventType: "GENERATION_STARTED",
      },
      // An explicit allowlist: no prompt, provider, model or storage key.
      audit: (started) => ({
        organizationId,
        actorUserId,
        action: GENERATION_START_AUDIT_ACTION.Started,
        resourceType: GENERATION_JOB_AUDIT_RESOURCE_TYPE,
        resourceId: started.job.id,
        metadata: {
          videoProjectId: project.id,
          reservationId: started.reservation.id,
          qualityTier: started.job.qualityTier,
          durationSeconds: started.job.requestedDurationSeconds,
          requiredVideoUnits: started.job.requiredVideoUnits,
          disclosureMode: started.job.disclosureMode,
          sceneCount: started.sceneCount,
          allocations: started.allocations.map((allocation) => ({
            sourceType: allocation.sourceType,
            addOnBlockId: allocation.addOnBlockId,
            quality: allocation.quality,
            quantity: allocation.quantity,
          })),
        },
      }),
    };
  }
}

/** Whether the storyboard holds exactly the confirmed scenes, in that order. */
function sameScenes(scenes: readonly StoryboardScene[], confirmed: readonly string[]): boolean {
  return scenes.length === confirmed.length && scenes.every((scene, index) => scene.id === confirmed[index]);
}
