export { getPrismaClient, type PrismaClient } from "./client";
export { createPrismaIdentityRepositories } from "./repositories";
export { createPrismaPropertyRepositories } from "./property-repositories";
export { createPrismaAnalysisRepository } from "./analysis-repositories";
export { createPrismaReviewTransaction } from "./review-transaction";
export { createPrismaStoryboardRepositories } from "./storyboard-repositories";
export { createPrismaSceneGenerationRepository } from "./generation-repositories";
export { createPrismaSceneGenerationExecutionRepository } from "./generation-execution-repository";
// Explicit, not `export *`.
//
// `admitAttemptWithin` is a within-transaction helper that assumes a lock it
// does not take, exactly like `armProviderBoundaryWithin`. Re-exporting the
// module wholesale published it from the package root, which contradicted its
// own contract: a caller reaching it through `@app/database` would be admitting
// an attempt with no request lock held. It is reachable only through a relative
// path inside this package, and a static regression proves it is absent here.
export {
  appendGenerationEvent,
  armProviderBoundaryWithin,
  createGenerationJobRepository,
  createGenerationPricingSnapshotRepository,
  createGenerationReservationRepository,
  createGenerationSceneRepository,
  createGenerationTransitionEventRepository,
  createSceneGenerationAttemptRepository,
  createSceneGenerationRequestRepository,
} from "./orchestration-repositories";
export { createPaidSubmissionAuthorizationRepository } from "./paid-submission-authorization-repository";
export { createSubmissionOutcomeRepository } from "./submission-outcome-repository";
export { createReconciliationRepository } from "./reconciliation-repository";
export { createCompletionRepository } from "./completion-repository";
export { createProviderPollingContextReader } from "./provider-output-repository";
export { createMediaValidationLifecycleRepository } from "./media-validation-lifecycle-repository";
export { createValidatedSceneDeliveryRepository } from "./validated-scene-delivery-repository";
export { createAutomaticMediaRecoveryRepository } from "./media-recovery-repository";
export { createMediaFailureResolutionRepository } from "./media-failure-resolution-repository";
export { createDeliverableCompositionPlanRepository } from "./deliverable-composition-repository";
// `cost-admission-lock` is deliberately absent. A caller outside this package
// holding that lock would hold it without the transaction that makes it mean
// anything, and one key formula is worth nothing if it can be taken from
// somewhere this package cannot see.
