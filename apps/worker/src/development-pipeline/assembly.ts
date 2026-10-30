import { isAbsolute } from "node:path";
import {
  createAttemptFailureSettlementRepository,
  createAttemptSubmissionRepository,
  createCompletionRepository,
  createFailedJobSceneClosureRepository,
  createJobLaunchRepository,
  createLaunchedJobEndingRepository,
  createPaidSubmissionAuthorizationRepository,
  createPrismaPropertyRepositories,
  createProviderPollingContextReader,
  createReconciliationRepository,
  createSubmissionOutcomeRepository,
  createUnlaunchableJobEndingRepository,
  type PrismaClient,
} from "@app/database";
import {
  AttemptFailureSettlementRunner,
  AttemptSubmissionRunner,
  FailedJobSceneClosureRunner,
  JobLaunchPlanner,
  JobLaunchRunner,
  createPaidSubmissionAuthorizationService,
  createProviderCompletionService,
  createProviderOutputRunner,
  createReconciliationMaintenance,
  createReconciliationService,
  createSubmissionOutcomeService,
  createSystemAuthorizationClock,
  createSystemSubmissionClock,
  epochMillis,
  sanitizeTransitionMetadata,
  validateReconciliationPolicy,
  type FxRateSource,
  type ReconciliationPolicy,
  type TransitionContext,
} from "@app/domain";
import { AppError, randomId, type ServerEnv } from "@app/shared";
import {
  MAX_MANAGED_PROVIDER_OUTPUT_BYTES,
  S3ManagedOutputStagingSink,
  SHARED_FOLDER_STORAGE_BUCKET,
  StreamingManagedOutputTransfer,
  createDefaultProcessRunner,
  createFfmpegFakeClipRenderer,
  createSharedFolderStorage,
} from "@app/storage";
import {
  FakeVideoProvider,
  createFakeClipStudio,
  createFakeRouteKit,
  createPreparedGenerationSender,
  type FakeClipRenderer,
} from "@app/video-providers";
import { createSharedFolderPhotoReader } from "./photo-reader";

/**
 * The development pipeline's assembly (GS-9b, ADR-0106): every generation step,
 * built on the test provider and the shared folder, for the pipeline command
 * to run when a person or a test starts it.
 *
 * It runs nothing. It builds the runners and hands them back; no timer, loop
 * or startup hook calls them, and nothing in the worker's start-up imports
 * this module. It is refused in production, given or ambient, and unless
 * `VIDEO_PROVIDER` is `fake`, before anything is opened.
 *
 * Every runner reads and writes the database it is given and the shared folder
 * the web app stores photos in (ADR-0085). The test provider reads each photo
 * through the URL preparation signed (ADR-0092), and its clips are copied into
 * the same folder.
 */

/**
 * The base the pipeline signs photo URLs under. Preparation refuses a URL that
 * is not `https` with a host; `.invalid` never resolves, so no URL signed under
 * it can be fetched. Only the test provider's photo reader redeems one.
 */
export const DEVELOPMENT_SIGNED_URL_BASE = "https://development.invalid/api/storage";

/**
 * Development values, never production's, which is an activation decision
 * (`docs/decisions/TODO.md`). The test provider answers at once, so an attempt
 * left at the boundary for 15 minutes was abandoned by a stopped run.
 */
export const DEVELOPMENT_RECONCILIATION = {
  reconciliationWindowMs: 60 * 60 * 1000,
  staleSubmittingAfterMs: 15 * 60 * 1000,
} as const;

export type DevelopmentPipelineEnv = Pick<
  ServerEnv,
  "NODE_ENV" | "VIDEO_PROVIDER" | "SHARED_STORAGE_DIR" | "STORAGE_SIGNING_SECRET"
>;

export interface DevelopmentPipelineOptions {
  /** The test provider's own folder, for its clips. Absolute. */
  readonly providerFolder: string;
}

export interface DevelopmentPipelineDeps {
  readonly prisma: PrismaClient;
  /** Makes each clip; FFmpeg's by default. */
  readonly renderer?: FakeClipRenderer;
}

export type DevelopmentPipelineStep =
  | "launch"
  | "submission"
  | "provider_output"
  | "reconciliation"
  | "attempt_failure_settlement"
  | "failed_job_scene_closure";

export interface DevelopmentPipeline {
  readonly launch: JobLaunchRunner;
  readonly submission: AttemptSubmissionRunner;
  readonly providerOutput: ReturnType<typeof createProviderOutputRunner>;
  readonly reconciliation: ReturnType<typeof createReconciliationMaintenance>;
  readonly attemptFailureSettlement: AttemptFailureSettlementRunner;
  readonly failedJobSceneClosure: FailedJobSceneClosureRunner;
}

/** A worker's context for one transition of `step`, with its own correlation. */
export function developmentPipelineContext(step: DevelopmentPipelineStep): TransitionContext {
  return {
    actorType: "WORKER",
    actorUserId: null,
    correlationId: randomId("corr"),
    causationId: null,
    reasonCode: null,
    eventType: `pipeline.${step}`,
    metadata: sanitizeTransitionMetadata({}),
  };
}

function developmentReconciliationPolicy(): ReconciliationPolicy {
  const validated = validateReconciliationPolicy(DEVELOPMENT_RECONCILIATION);
  if (!validated.ok) throw new AppError("INTERNAL_ERROR", "The development reconciliation policy is invalid");
  return validated.policy;
}

export function assembleDevelopmentPipeline(
  env: DevelopmentPipelineEnv,
  options: DevelopmentPipelineOptions,
  deps: DevelopmentPipelineDeps,
): DevelopmentPipeline {
  // The given value cannot vouch for the ambient one: either says production.
  if (env.NODE_ENV === "production" || process.env.NODE_ENV === "production") {
    throw new AppError("CONFIGURATION_ERROR", "The development pipeline is refused in production");
  }
  if (env.VIDEO_PROVIDER !== "fake") {
    throw new AppError("CONFIGURATION_ERROR", "The development pipeline needs VIDEO_PROVIDER=fake");
  }
  if (env.SHARED_STORAGE_DIR === undefined) {
    throw new AppError("CONFIGURATION_ERROR", "The development pipeline needs SHARED_STORAGE_DIR");
  }
  if (typeof options.providerFolder !== "string" || !isAbsolute(options.providerFolder)) {
    throw new AppError("CONFIGURATION_ERROR", "The test provider's folder must be an absolute path");
  }

  const { prisma } = deps;
  const secret = env.STORAGE_SIGNING_SECRET;
  const storage = createSharedFolderStorage({
    root: env.SHARED_STORAGE_DIR,
    secret,
    basePath: DEVELOPMENT_SIGNED_URL_BASE,
  });
  const kit = createFakeRouteKit(env);
  // One studio serves the provider, the status source and the byte source.
  const studio = createFakeClipStudio(
    env,
    { root: options.providerFolder },
    {
      renderer: deps.renderer ?? createFfmpegFakeClipRenderer({ runner: createDefaultProcessRunner() }),
      photos: createSharedFolderPhotoReader({
        base: DEVELOPMENT_SIGNED_URL_BASE,
        secret,
        storage: storage.objectStorage,
      }),
    },
  );
  // The test route's fixed rate, never a network source.
  const fx: FxRateSource = { current: () => Promise.resolve(kit.fx) };
  const now = (): number => Date.now();
  const at = () => epochMillis(Date.now());
  const clock = createSystemSubmissionClock();
  const policy = developmentReconciliationPolicy();
  const outcomes = createSubmissionOutcomeService({
    outcomes: createSubmissionOutcomeRepository(prisma),
    clock,
    policy,
  });
  const completion = createCompletionRepository(prisma);
  const reconciliation = createReconciliationRepository(prisma);

  return {
    launch: new JobLaunchRunner({
      repository: createJobLaunchRepository(prisma),
      ending: createUnlaunchableJobEndingRepository(prisma),
      launchedEnding: createLaunchedJobEndingRepository(prisma),
      planner: new JobLaunchPlanner({
        routes: kit.routePolicy,
        models: kit.models,
        pricing: kit.pricing,
        fx,
        clock: now,
      }),
      ids: { nextAttemptId: () => randomId("gatt"), nextPricingSnapshotId: () => randomId("gpsn") },
      context: () => developmentPipelineContext("launch"),
      clock: now,
    }),
    submission: new AttemptSubmissionRunner({
      repository: createAttemptSubmissionRepository(prisma),
      preflight: {
        assets: createPrismaPropertyRepositories(prisma).assets,
        storage: storage.objectStorage,
        models: kit.models,
      },
      gate: createPaidSubmissionAuthorizationService({
        authorization: createPaidSubmissionAuthorizationRepository(prisma, { pricing: kit.pricing }),
        clock: createSystemAuthorizationClock(),
        routePolicy: kit.routePolicy,
      }),
      sender: createPreparedGenerationSender(new FakeVideoProvider({ studio })),
      outcomes,
      clock,
      context: () => developmentPipelineContext("submission"),
    }),
    providerOutput: createProviderOutputRunner({
      polling: createProviderPollingContextReader(prisma, completion),
      statusSource: studio.statusSource,
      transfer: new StreamingManagedOutputTransfer(
        { maxBytes: MAX_MANAGED_PROVIDER_OUTPUT_BYTES },
        {
          source: studio.byteSource,
          staging: new S3ManagedOutputStagingSink(
            { bucket: SHARED_FOLDER_STORAGE_BUCKET },
            { client: storage.objectClient },
          ),
        },
      ),
      completion: createProviderCompletionService({ completion, clock }),
    }),
    reconciliation: createReconciliationMaintenance({
      reconciliation,
      clock,
      reconciliationService: createReconciliationService({ reconciliation, clock }),
      submissionOutcomes: outcomes,
      policy,
    }),
    attemptFailureSettlement: new AttemptFailureSettlementRunner({
      repository: createAttemptFailureSettlementRepository(prisma),
      clock: at,
      context: () => developmentPipelineContext("attempt_failure_settlement"),
    }),
    failedJobSceneClosure: new FailedJobSceneClosureRunner({
      repository: createFailedJobSceneClosureRepository(prisma),
      clock: at,
      context: () => developmentPipelineContext("failed_job_scene_closure"),
    }),
  };
}
