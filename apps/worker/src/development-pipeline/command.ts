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
  "Runs only with VIDEO_PROVIDER=fake, SHARED_STORAGE_DIR and a database on this machine, never in production.",
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

const PARSE_ERRORS: ReadonlyMap<unknown, string> = new Map([
  ["ERR_PARSE_ARGS_UNKNOWN_OPTION", "An option it does not know was given"],
  ["ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL", "A word that is not an option was given"],
  ["ERR_PARSE_ARGS_INVALID_OPTION_VALUE", "An option was given without its value"],
]);

/** Read and validate the command line. Nothing typed is repeated back. */
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
    // Node's own message quotes what was typed, which may be anything pasted: only its kind is said.
    const code = typeof error === "object" && error !== null && "code" in error ? error.code : null;
    return { ok: false, error: PARSE_ERRORS.get(code) ?? "The arguments could not be read" };
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

const LOCAL_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Refused unless `DATABASE_URL` names a database on this machine (ADR-0108
 * Decision 6). Reads the address and never prints it.
 */
export function refuseRemoteDatabase(databaseUrl: string | undefined): void {
  let local = false;
  if (databaseUrl !== undefined) {
    try {
      const url = new URL(databaseUrl);
      const socket = url.searchParams.get("host");
      local = LOCAL_HOSTS.has(url.hostname) && (socket === null || socket.startsWith("/"));
    } catch {
      local = false;
    }
  }
  if (!local) {
    throw new AppError(
      "CONFIGURATION_ERROR",
      "The development pipeline is refused: DATABASE_URL must name a database on this machine",
    );
  }
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
  /** Cycles that changed nothing read each window from its oldest row to its end. */
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

/**
 * How an item's outcome counts (ADR-0108 Decision 4): a row this pass moved,
 * an item it could not move and will offer again, or neither (still at the
 * provider, already done, held by another worker, not yet due, or waiting
 * for another job to move first).
 */
type Tally = "CHANGED" | "FAILED" | "NEITHER";

/** One pass's report, as the assembly's step returns it. */
type Report<K extends Exclude<keyof DevelopmentPipeline, "providerOutput">> = Awaited<
  ReturnType<DevelopmentPipeline[K]["runOnce"]>
>;
type LaunchOutcome = Report<"launch">["outcomes"][number]["outcome"];
type SubmissionOutcome = Report<"submission">["outcomes"][number]["outcome"];
type ProviderOutputKind = Awaited<
  ReturnType<DevelopmentPipeline["providerOutput"]["runProviderOutputBatchOnce"]>
>["results"][number];
type MediaValidationKind = Report<"mediaValidation">["outcomes"][number]["outcome"]["kind"];
type ResolutionOutcome = Report<"mediaFailureResolution">["outcomes"][number]["result"];
type FinalValidationKind = Report<"deliverableValidation">["outcomes"][number]["outcome"]["kind"];

// Each table names every kind its step can report, so a kind added or renamed
// does not compile until it is counted.
const LAUNCH: Readonly<Record<Exclude<LaunchOutcome["kind"], "NOT_LAUNCHABLE">, Tally>> = {
  LAUNCHED: "CHANGED",
  ENDED: "CHANGED",
  AT_LIMIT: "NEITHER",
  NOT_NEXT: "NEITHER",
  SAME_REQUEST_RUNNING: "NEITHER",
  NO_SUBSCRIPTION: "FAILED",
  NOT_PLANNED: "FAILED",
  NOT_ENDED: "FAILED",
  FAILED: "FAILED",
};
const NOT_LAUNCHABLE: Readonly<Record<Extract<LaunchOutcome, { kind: "NOT_LAUNCHABLE" }>["reason"], Tally>> = {
  // Launched or ended by another writer.
  NOT_WAITING: "NEITHER",
  // The runner ends these two at once; either reaching the command means a job that should have moved.
  PROPERTY_DELETED: "FAILED",
  SHAPE_CONFLICT: "FAILED",
  FACTS_CHANGED: "FAILED",
};
const SUBMISSION: Readonly<Record<Exclude<SubmissionOutcome["kind"], "NOT_SENT">, Tally>> = {
  SENT: "CHANGED",
  ENDED: "CHANGED",
  MOVED: "NEITHER",
  NOT_PREPARED: "FAILED",
  NOT_AUTHORIZED: "FAILED",
  FAILED: "FAILED",
};
const NOT_SENT: Readonly<Record<Extract<SubmissionOutcome, { kind: "NOT_SENT" }>["reason"], Tally>> = {
  JOB_ENDING: "NEITHER",
  PASS_STOPPED: "NEITHER",
  PROPERTY_NOT_DELETED: "NEITHER",
  SOURCE_URL_STALE: "FAILED",
  OTHER_PROVIDER: "FAILED",
};
const PROVIDER_OUTPUT: Readonly<Record<ProviderOutputKind, Tally>> = {
  PROVIDER_COMPLETION_APPLIED: "CHANGED",
  OUTPUT_VERIFIED: "CHANGED",
  STILL_PROCESSING: "NEITHER",
  PROVIDER_COMPLETION_REPLAYED: "NEITHER",
  INGESTION_ALREADY_CLAIMED: "NEITHER",
  OUTPUT_VERIFICATION_REPLAYED: "NEITHER",
  ALREADY_VERIFIED: "NEITHER",
  ATTEMPT_NOT_FOUND: "NEITHER",
  ATTEMPT_NOT_APPLICABLE: "NEITHER",
  LOST_CONCURRENCY: "NEITHER",
  OUTPUT_LOCATOR_UNAVAILABLE: "FAILED",
  TRANSFER_RETRYABLE_FAILURE: "FAILED",
  TRANSFER_SOURCE_FAILED: "FAILED",
  STATUS_SOURCE_FAILED: "FAILED",
  STATUS_OBSERVATION_MALFORMED: "FAILED",
  TRANSFER_OUTCOME_MALFORMED: "FAILED",
  PROVIDER_REALITY_CONFLICT: "FAILED",
  ATTEMPT_CONTEXT_INVALID: "FAILED",
};
const MEDIA_VALIDATION: Readonly<Record<MediaValidationKind, Tally>> = {
  VALID: "CHANGED",
  INVALID_MEDIA: "CHANGED",
  INTEGRITY_MISMATCH: "CHANGED",
  NOT_CLAIMED: "NEITHER",
  ALREADY_TERMINAL: "NEITHER",
  NOT_ELIGIBLE: "NEITHER",
  LOST: "NEITHER",
  // Not read this time; checked again after its delay.
  RELEASED: "FAILED",
};
const FINAL_VALIDATION: Readonly<Record<FinalValidationKind, Tally>> = {
  PUBLISHED_AND_CONSUMED: "CHANGED",
  PUBLISHED_AS_REPLACEMENT: "CHANGED",
  PROPERTY_DELETED: "CHANGED",
  INVALID_MEDIA: "CHANGED",
  INTEGRITY_MISMATCH: "CHANGED",
  NOT_PUBLISHABLE: "NEITHER",
  ALREADY_PUBLISHED: "NEITHER",
  NOT_CLAIMABLE: "NEITHER",
  ALREADY_TERMINAL: "NEITHER",
  NOT_ELIGIBLE: "NEITHER",
  NOT_FOUND: "NEITHER",
  LOST: "NEITHER",
  RELEASED: "FAILED",
  FAILED: "FAILED",
};

function launchTally(outcome: LaunchOutcome): Tally {
  return outcome.kind === "NOT_LAUNCHABLE" ? NOT_LAUNCHABLE[outcome.reason] : LAUNCH[outcome.kind];
}

function submissionTally(outcome: SubmissionOutcome): Tally {
  return outcome.kind === "NOT_SENT" ? NOT_SENT[outcome.reason] : SUBMISSION[outcome.kind];
}

function resolutionTally(result: ResolutionOutcome): Tally {
  switch (result.kind) {
    case "RECOVERY":
      return result.outcome.kind === "ADMITTED" ? "CHANGED" : "NEITHER";
    case "SETTLEMENT":
      return result.outcome.kind === "SETTLED" ? "CHANGED" : "NEITHER";
    case "RECONCILED":
    case "RESOLVED":
      return "CHANGED";
    // No retry could be planned now; offered again after its delay.
    case "DEFERRED":
      return "FAILED";
    case "SKIPPED":
      return "NEITHER";
  }
}

function tally(tallies: readonly Tally[]): PassCount {
  return {
    changed: tallies.filter((entry) => entry === "CHANGED").length,
    failed: tallies.filter((entry) => entry === "FAILED").length,
  };
}

/** The exit status for a run: 0 when it ended quiet with nothing failed, 1 otherwise. */
export function pipelineExitCode(report: PipelineRunReport): 0 | 1 {
  const failed = PIPELINE_ORDER.some((step) => report.totals[step].failed > 0);
  return report.stop.kind === "QUIET" && !failed ? 0 : 1;
}

/** Where one pass of a window began and ended. */
interface WindowPass {
  readonly fromOldest: boolean;
  readonly toEnd: boolean;
}

/**
 * How far a window has been read since the last cycle that changed something:
 * not yet from its oldest row, from its oldest row on, or through to its end.
 */
type Sweep = "NOT_BEGUN" | "BEGUN" | "DONE";

function swept(sweep: Sweep, pass: WindowPass): Sweep {
  if (sweep === "DONE") return "DONE";
  const begun = sweep === "BEGUN" || pass.fromOldest;
  if (!begun) return "NOT_BEGUN";
  return pass.toEnd ? "DONE" : "BEGUN";
}

/**
 * Runs cycles until nothing changes, a step throws, the provider's answer is
 * not recorded, or `maxCycles` have run. Each cycle runs every step once. A
 * run is quiet only after cycles that changed nothing have read each window
 * from its oldest row through to its end, since a change can let a row behind
 * a cursor move.
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
  let launchPass: WindowPass = { fromOldest: false, toEnd: false };
  let submitPass: WindowPass = { fromOldest: false, toEnd: false };
  let launchSweep: Sweep = "NOT_BEGUN";
  let submitSweep: Sweep = "NOT_BEGUN";
  let submissionStopped = false;

  const passes: Record<PipelineStep, () => Promise<PassCount>> = {
    launch: async () => {
      const report = await steps.launch.runOnce(limit, launchFrom);
      launchPass = { fromOldest: launchFrom === null, toEnd: report.next === null };
      launchFrom = report.next;
      return tally(report.outcomes.map(({ outcome }) => launchTally(outcome)));
    },
    submission: async () => {
      const report = await steps.submission.runOnce(limit, submitFrom);
      submitPass = { fromOldest: submitFrom === null, toEnd: report.next === null };
      submitFrom = report.next;
      submissionStopped = report.stopped;
      return tally(report.outcomes.map(({ outcome }) => submissionTally(outcome)));
    },
    provider_output: async () => {
      const { results } = await steps.providerOutput.runProviderOutputBatchOnce({
        limit,
        context: developmentPipelineContext("provider_output"),
      });
      return tally(results.map((kind) => PROVIDER_OUTPUT[kind]));
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
      return tally(outcomes.map(({ outcome }) => MEDIA_VALIDATION[outcome.kind]));
    },
    media_failure_resolution: async () => {
      const { outcomes } = await steps.mediaFailureResolution.runOnce(limit);
      return tally(outcomes.map(({ result }) => resolutionTally(result)));
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
      // A refused composition ends its job and frees its place, so it moved a row too.
      return {
        changed: report.finalized + report.blocked,
        failed: report.deferred + report.leaseLost + report.unsupportedTarget + report.failed,
      };
    },
    deliverable_validation: async () => {
      const { outcomes } = await steps.deliverableValidation.runOnce(
        limit,
        developmentPipelineContext("deliverable_validation"),
      );
      return tally(outcomes.map(({ outcome }) => FINAL_VALIDATION[outcome.kind]));
    },
  };

  for (let cycle = 1; cycle <= options.maxCycles; cycle += 1) {
    const counts: Partial<Record<PipelineStep, PassCount>> = {};
    let changed = 0;
    for (const step of PIPELINE_ORDER) {
      let pass: PassCount;
      try {
        pass = await passes[step]();
      } catch (error) {
        onCycle(cycle, counts);
        const code = error instanceof AppError ? error.code : null;
        return { cycles: cycle, stop: { kind: "STEP_THREW", step, code }, totals };
      }
      counts[step] = pass;
      totals[step].changed += pass.changed;
      totals[step].failed += pass.failed;
      changed += pass.changed;
    }
    onCycle(cycle, counts);
    if (submissionStopped) return { cycles: cycle, stop: { kind: "SUBMISSION_STOPPED" }, totals };
    if (changed > 0) {
      launchSweep = "NOT_BEGUN";
      submitSweep = "NOT_BEGUN";
      continue;
    }
    launchSweep = swept(launchSweep, launchPass);
    submitSweep = swept(submitSweep, submitPass);
    if (launchSweep === "DONE" && submitSweep === "DONE") return { cycles: cycle, stop: { kind: "QUIET" }, totals };
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
  composition: "compositions finished (J)",
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
