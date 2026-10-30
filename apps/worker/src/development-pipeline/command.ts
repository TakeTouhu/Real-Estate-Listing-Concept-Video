import { parseArgs } from "node:util";
import type { PrismaClient } from "@app/database";
import {
  MAX_ATTEMPT_FAILURE_SETTLEMENT_BATCH_SIZE,
  MAX_ATTEMPT_SUBMISSION_BATCH_SIZE,
  MAX_COMPOSITION_BATCH_SIZE,
  MAX_COMPOSITION_PLAN_BATCH_SIZE,
  MAX_DELIVERABLE_VALIDATION_BATCH_SIZE,
  MAX_FAILED_JOB_SCENE_CLOSURE_BATCH_SIZE,
  MAX_JOB_LAUNCH_BATCH_SIZE,
  MAX_MEDIA_FAILURE_RESOLUTION_BATCH_SIZE,
  MAX_MEDIA_VALIDATION_BATCH_SIZE,
  MAX_RECONCILIATION_MAINTENANCE_BATCH_SIZE,
  MAX_SCENE_DELIVERY_BATCH_SIZE,
  type AttemptSubmissionCursor,
  type JobLaunchCursor,
} from "@app/domain";
import { AppError } from "@app/shared";
import type { ProviderName } from "@app/video-providers";
import { developmentPipelineContext, type DevelopmentPipeline, type DevelopmentPipelineStep } from "./assembly";

/**
 * The development pipeline command (GS-9c, ADR-0108).
 *
 * It runs every step the assembly built, in order, once per cycle, and runs
 * cycles until one changes nothing. It runs only when a person or a test
 * starts it: it never waits, sleeps or starts itself, and work handed back to
 * be retried later waits for the next run. It reports counts only.
 */

/**
 * The smallest of the steps' own batch ceilings (25 today: composition and the
 * final validation), so every step accepts the limit. The provider output and
 * the maintenance share the maintenance's ceiling.
 */
export const MAX_PIPELINE_LIMIT = Math.min(
  MAX_JOB_LAUNCH_BATCH_SIZE,
  MAX_ATTEMPT_SUBMISSION_BATCH_SIZE,
  MAX_RECONCILIATION_MAINTENANCE_BATCH_SIZE,
  MAX_ATTEMPT_FAILURE_SETTLEMENT_BATCH_SIZE,
  MAX_FAILED_JOB_SCENE_CLOSURE_BATCH_SIZE,
  MAX_MEDIA_VALIDATION_BATCH_SIZE,
  MAX_MEDIA_FAILURE_RESOLUTION_BATCH_SIZE,
  MAX_SCENE_DELIVERY_BATCH_SIZE,
  MAX_COMPOSITION_PLAN_BATCH_SIZE,
  MAX_COMPOSITION_BATCH_SIZE,
  MAX_DELIVERABLE_VALIDATION_BATCH_SIZE,
);
export const MAX_PIPELINE_CYCLES = 1000;

export const USAGE = [
  "Usage: pnpm --filter @app/worker pipeline \\",
  "  --provider-folder <absolute path: the test provider's own folder, for its clips> \\",
  `  [--limit <1 to ${MAX_PIPELINE_LIMIT}: items each step takes per pass; 10 if omitted>] \\`,
  `  [--max-cycles <1 to ${MAX_PIPELINE_CYCLES}: cycles before it gives up; 50 if omitted>]`,
  "Runs only with VIDEO_PROVIDER=fake and SHARED_STORAGE_DIR, never in production.",
].join("\n");

export interface PipelineArguments {
  readonly providerFolder: string;
  readonly limit: number;
  readonly maxCycles: number;
}

export type ParsedPipelineArguments =
  | { readonly ok: true; readonly value: PipelineArguments }
  | { readonly ok: false; readonly error: string };

function bounded(raw: unknown, name: string, fallback: number, max: number, errors: string[]): number {
  if (raw === undefined) return fallback;
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!/^[0-9]{1,4}$/.test(text) || Number(text) < 1 || Number(text) > max) {
    errors.push(`--${name} must be a whole number from 1 to ${max}`);
    return fallback;
  }
  return Number(text);
}

/** Read and validate the command line. */
export function parsePipelineArguments(argv: readonly string[]): ParsedPipelineArguments {
  let values: Record<string, unknown>;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      strict: true,
      allowPositionals: false,
      options: {
        "provider-folder": { type: "string" },
        limit: { type: "string" },
        "max-cycles": { type: "string" },
      },
    }));
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Unreadable arguments" };
  }
  const errors: string[] = [];
  const folder = values["provider-folder"];
  const providerFolder = typeof folder === "string" ? folder.trim() : "";
  if (providerFolder === "") errors.push("--provider-folder is required");
  const limit = bounded(values.limit, "limit", 10, MAX_PIPELINE_LIMIT, errors);
  const maxCycles = bounded(values["max-cycles"], "max-cycles", 50, MAX_PIPELINE_CYCLES, errors);
  if (errors.length > 0) return { ok: false, error: errors.join("; ") };
  return { ok: true, value: { providerFolder, limit, maxCycles } };
}

/** The test provider: the only one whose attempts a development database may hold. */
const TEST_PROVIDER: ProviderName = "fake";

/**
 * Refused when the database holds an attempt addressed to any other provider:
 * that database is not one the test provider's pipeline may act on (ADR-0108
 * Decision 6). Reads, and writes nothing.
 */
export async function refuseForeignAttempts(prisma: Pick<PrismaClient, "sceneGeneration">): Promise<void> {
  const foreign = await prisma.sceneGeneration.count({ where: { providerName: { not: TEST_PROVIDER } } });
  if (foreign > 0) {
    throw new AppError(
      "CONFIGURATION_ERROR",
      "The development pipeline is refused: this database holds attempts of another provider",
    );
  }
}

/**
 * Only the methods the command calls, so a test can stand in for each step.
 * Every step is the assembly's: the command builds none of its own.
 */
export type PipelinePasses = {
  readonly [K in Exclude<keyof DevelopmentPipeline, "providerOutput">]: Pick<DevelopmentPipeline[K], "runOnce">;
} & {
  readonly providerOutput: Pick<DevelopmentPipeline["providerOutput"], "runProviderOutputBatchOnce">;
};

/** What one pass did: rows it moved, and items it could not handle. */
export interface PassCount {
  readonly changed: number;
  readonly failed: number;
}

/** The steps of one cycle, in the order they run (ADR-0108 Decision 2). */
export const PIPELINE_ORDER = [
  "launch",
  "submission",
  "provider_output",
  "reconciliation",
  "attempt_failure_settlement",
  "failed_job_scene_closure",
  "media_validation",
  "media_failure_resolution",
  "scene_delivery",
  "composition_plan",
  "composition",
  "deliverable_validation",
] as const satisfies readonly DevelopmentPipelineStep[];

export type PipelineStep = (typeof PIPELINE_ORDER)[number];

export type PipelineStop =
  /** A whole cycle changed nothing, with both windows at their end. */
  | { readonly kind: "QUIET" }
  /** An answer from the provider was not recorded; nothing after it was sent. */
  | { readonly kind: "SUBMISSION_STOPPED" }
  /** A step threw. Only an `AppError`'s code is kept: no other error text. */
  | { readonly kind: "STEP_THREW"; readonly step: PipelineStep; readonly code: string | null }
  | { readonly kind: "CYCLE_LIMIT" };

export interface PipelineRunReport {
  readonly cycles: number;
  readonly stop: PipelineStop;
  readonly totals: Readonly<Record<PipelineStep, PassCount>>;
}

const PROVIDER_OUTPUT_CHANGED = new Set(["PROVIDER_COMPLETION_APPLIED", "OUTPUT_VERIFIED"]);
/** An attempt the provider output could not take further this pass. */
const PROVIDER_OUTPUT_FAILED = new Set([
  "OUTPUT_LOCATOR_UNAVAILABLE",
  "TRANSFER_RETRYABLE_FAILURE",
  "TRANSFER_SOURCE_FAILED",
  "STATUS_SOURCE_FAILED",
  "STATUS_OBSERVATION_MALFORMED",
  "TRANSFER_OUTCOME_MALFORMED",
  "PROVIDER_REALITY_CONFLICT",
  "ATTEMPT_CONTEXT_INVALID",
]);
/** Media validation's verdicts, and a claim handed back to be retried later. */
const VERDICTS = new Set(["VALID", "INVALID_MEDIA", "INTEGRITY_MISMATCH", "RELEASED"]);
/** What the final validation reports when it wrote nothing. */
const NOT_CHANGED_BY_VALIDATION = new Set([
  "ALREADY_PUBLISHED",
  "NOT_CLAIMABLE",
  "ALREADY_TERMINAL",
  "NOT_ELIGIBLE",
  "NOT_FOUND",
  "LOST",
  "FAILED",
]);

function count<T>(items: readonly T[], test: (item: T) => boolean): number {
  return items.filter(test).length;
}

/** The exit status for a run: 0 when it ended quiet with nothing failed, 1 otherwise. */
export function pipelineExitCode(report: PipelineRunReport): 0 | 1 {
  const failed = PIPELINE_ORDER.some((step) => report.totals[step].failed > 0);
  return report.stop.kind === "QUIET" && !failed ? 0 : 1;
}

/**
 * Runs cycles until one changes nothing, a step throws, the provider's answer
 * is not recorded, or `maxCycles` have run. Each cycle runs every step once.
 */
export async function runDevelopmentPipeline(
  steps: PipelinePasses,
  options: Pick<PipelineArguments, "limit" | "maxCycles">,
  onCycle: (cycle: number, counts: Readonly<Partial<Record<PipelineStep, PassCount>>>) => void = () => undefined,
): Promise<PipelineRunReport> {
  const { limit } = options;
  const totals = Object.fromEntries(PIPELINE_ORDER.map((step) => [step, { changed: 0, failed: 0 }])) as Record<
    PipelineStep,
    { changed: number; failed: number }
  >;
  // Each window's cursor is carried from one cycle to the next; a run starts from the oldest.
  let launchFrom: JobLaunchCursor | null = null;
  let submitFrom: AttemptSubmissionCursor | null = null;
  let submissionStopped = false;

  const passes: Record<PipelineStep, () => Promise<PassCount & { readonly moreWaiting?: boolean }>> = {
    launch: async () => {
      const report = await steps.launch.runOnce(limit, launchFrom);
      launchFrom = report.next;
      return { changed: report.launched + report.ended, failed: report.failed, moreWaiting: report.next !== null };
    },
    submission: async () => {
      const report = await steps.submission.runOnce(limit, submitFrom);
      submitFrom = report.next;
      submissionStopped = report.stopped;
      return { changed: report.sent + report.ended, failed: report.failed, moreWaiting: report.next !== null };
    },
    provider_output: async () => {
      const { results } = await steps.providerOutput.runProviderOutputBatchOnce({
        limit,
        context: developmentPipelineContext("provider_output"),
      });
      return {
        changed: count(results, (kind) => PROVIDER_OUTPUT_CHANGED.has(kind)),
        failed: count(results, (kind) => PROVIDER_OUTPUT_FAILED.has(kind)),
      };
    },
    reconciliation: async () => {
      const report = await steps.reconciliation.runOnce({
        limit,
        context: developmentPipelineContext("reconciliation"),
      });
      return { changed: report.staleUncertaintyEntered + report.exhausted, failed: 0 };
    },
    attempt_failure_settlement: async () => {
      const report = await steps.attemptFailureSettlement.runOnce(limit);
      return { changed: report.settled, failed: report.failed };
    },
    failed_job_scene_closure: async () => {
      const report = await steps.failedJobSceneClosure.runOnce(limit);
      return { changed: report.closed, failed: report.failed };
    },
    media_validation: async () => {
      const { outcomes } = await steps.mediaValidation.runOnce(limit);
      return { changed: count(outcomes, ({ outcome }) => VERDICTS.has(outcome.kind)), failed: 0 };
    },
    media_failure_resolution: async () => {
      const report = await steps.mediaFailureResolution.runOnce(limit);
      return { changed: report.claimed, failed: 0 };
    },
    scene_delivery: async () => {
      const report = await steps.sceneDelivery.runOnce(limit);
      return { changed: report.delivered, failed: 0 };
    },
    composition_plan: async () => {
      const report = await steps.compositionPlan.runOnce(limit);
      return { changed: report.planned, failed: report.failed };
    },
    composition: async () => {
      const report = await steps.composition.runOnce(limit);
      return { changed: report.claimed, failed: report.failed };
    },
    deliverable_validation: async () => {
      const { outcomes } = await steps.deliverableValidation.runOnce(
        limit,
        developmentPipelineContext("deliverable_validation"),
      );
      return {
        changed: count(outcomes, ({ outcome }) => !NOT_CHANGED_BY_VALIDATION.has(outcome.kind)),
        failed: count(outcomes, ({ outcome }) => outcome.kind === "FAILED"),
      };
    },
  };

  for (let cycle = 1; cycle <= options.maxCycles; cycle += 1) {
    const counts: Partial<Record<PipelineStep, PassCount>> = {};
    let changed = 0;
    let moreWaiting = false;
    for (const step of PIPELINE_ORDER) {
      let pass: PassCount & { readonly moreWaiting?: boolean };
      try {
        pass = await passes[step]();
      } catch (error) {
        onCycle(cycle, counts);
        const code = error instanceof AppError ? error.code : null;
        return { cycles: cycle, stop: { kind: "STEP_THREW", step, code }, totals };
      }
      counts[step] = { changed: pass.changed, failed: pass.failed };
      totals[step].changed += pass.changed;
      totals[step].failed += pass.failed;
      changed += pass.changed;
      moreWaiting ||= pass.moreWaiting === true;
    }
    onCycle(cycle, counts);
    if (submissionStopped) return { cycles: cycle, stop: { kind: "SUBMISSION_STOPPED" }, totals };
    if (changed === 0 && !moreWaiting) return { cycles: cycle, stop: { kind: "QUIET" }, totals };
  }
  return { cycles: options.maxCycles, stop: { kind: "CYCLE_LIMIT" }, totals };
}

/** What a person reads for each step. */
const LABELS: Readonly<Record<PipelineStep, string>> = {
  launch: "launch",
  submission: "submission",
  provider_output: "provider output",
  reconciliation: "maintenance",
  attempt_failure_settlement: "provider failures settled (K)",
  failed_job_scene_closure: "failed jobs' scenes closed (L)",
  media_validation: "clips checked",
  media_failure_resolution: "unusable clips resolved",
  scene_delivery: "scenes delivered (F)",
  composition_plan: "videos planned (I)",
  composition: "videos composed (J)",
  deliverable_validation: "videos validated (G)",
};

function counted(counts: Readonly<Partial<Record<PipelineStep, PassCount>>>): string {
  const parts = PIPELINE_ORDER.flatMap((step) => {
    const pass = counts[step];
    if (pass === undefined || (pass.changed === 0 && pass.failed === 0)) return [];
    return [`${LABELS[step]} ${pass.changed}${pass.failed > 0 ? ` (${pass.failed} failed)` : ""}`];
  });
  return parts.length === 0 ? "nothing changed" : parts.join(", ");
}

/** One line for a cycle: what each step changed. Counts only. */
export function formatPipelineCycle(cycle: number, counts: Readonly<Partial<Record<PipelineStep, PassCount>>>): string {
  return `cycle ${cycle}: ${counted(counts)}`;
}

/** The run's last line: why it stopped, and what it changed in all. */
export function formatPipelineReport(report: PipelineRunReport): string {
  const why = ((stop: PipelineStop): string => {
    switch (stop.kind) {
      case "QUIET":
        return "nothing more to do now";
      case "SUBMISSION_STOPPED":
        return "stopped: an answer from the test provider was not recorded";
      case "STEP_THREW":
        return `stopped: ${LABELS[stop.step]} threw${stop.code === null ? "" : ` ${stop.code}`}`;
      case "CYCLE_LIMIT":
        return "stopped: the cycle limit was reached with work still moving";
    }
  })(report.stop);
  return `${why} after ${report.cycles} cycle${report.cycles === 1 ? "" : "s"}; in all: ${counted(report.totals)}`;
}
