import { describe, expect, it, vi } from "vitest";
import {
  MAX_COMPOSITION_BATCH_SIZE,
  MAX_DELIVERABLE_VALIDATION_BATCH_SIZE,
  MAX_JOB_LAUNCH_BATCH_SIZE,
  epochMillis,
  type AttemptSubmissionCursor,
  type AttemptSubmissionReport,
  type DeliverableCompositionReport,
  type DeliverableValidationRunOutcome,
  type JobLaunchCursor,
  type JobLaunchReport,
  type MediaValidationRunOutcome,
  type ProviderOutputRunResult,
  type TransitionContext,
} from "@app/domain";
import { AppError } from "@app/shared";
import {
  MAX_PIPELINE_LIMIT,
  PIPELINE_ORDER,
  formatPipelineCycle,
  formatPipelineReport,
  parsePipelineArguments,
  pipelineExitCode,
  refuseForeignAttempts,
  runDevelopmentPipeline,
  type PipelinePasses,
} from "./command";

const LAUNCH_CURSOR: JobLaunchCursor = { createdAt: new Date(0), generationJobId: "gjob_window" };
const SUBMIT_CURSOR: AttemptSubmissionCursor = { createdAt: new Date(0), id: "gatt_window" };

function launchReport(over: Partial<JobLaunchReport> = {}): JobLaunchReport {
  return { launched: 0, ended: 0, failed: 0, outcomes: [], next: null, ...over };
}

function submissionReport(over: Partial<AttemptSubmissionReport> = {}): AttemptSubmissionReport {
  return { sent: 0, ended: 0, failed: 0, stopped: false, outcomes: [], next: null, ...over };
}

function compositionReport(over: Partial<DeliverableCompositionReport> = {}): DeliverableCompositionReport {
  return {
    considered: 0,
    claimed: 0,
    finalized: 0,
    alreadyFinalized: 0,
    deferred: 0,
    blocked: 0,
    leaseLost: 0,
    notClaimable: 0,
    unsupportedTarget: 0,
    failed: 0,
    ...over,
  };
}

/** Every step, quiet unless a test says otherwise. */
function quiet() {
  return {
    launch: { runOnce: vi.fn(async (_limit: number, _after: JobLaunchCursor | null = null) => launchReport()) },
    submission: {
      runOnce: vi.fn(async (_limit: number, _after: AttemptSubmissionCursor | null = null) => submissionReport()),
    },
    providerOutput: {
      runProviderOutputBatchOnce: vi.fn(async (_input: { limit: number; context: TransitionContext }) => ({
        candidates: 0,
        results: [] as ProviderOutputRunResult["kind"][],
      })),
    },
    reconciliation: {
      runOnce: vi.fn(async (_input: { limit: number; context: TransitionContext }) => ({
        discoveryNow: epochMillis(0),
        staleCandidates: 0,
        staleUncertaintyEntered: 0,
        dueCandidates: 0,
        exhausted: 0,
        unchanged: 0,
      })),
    },
    attemptFailureSettlement: {
      runOnce: vi.fn(async (_limit: number) => ({ settled: 0, unitsReleased: 0, failed: 0, outcomes: [] })),
    },
    failedJobSceneClosure: {
      runOnce: vi.fn(async (_limit: number) => ({ closed: 0, attemptsCancelled: 0, failed: 0, outcomes: [] })),
    },
    mediaValidation: {
      runOnce: vi.fn(async (_limit: number) => ({
        claimed: 0,
        outcomes: [] as { sceneGenerationId: string; outcome: MediaValidationRunOutcome }[],
      })),
    },
    mediaFailureResolution: {
      runOnce: vi.fn(async (_limit: number) => ({ claimed: 0, recovered: 0, settled: 0, deferred: 0, outcomes: [] })),
    },
    sceneDelivery: { runOnce: vi.fn(async (_limit: number) => ({ delivered: 0, jobsAdvanced: 0, outcomes: [] })) },
    compositionPlan: { runOnce: vi.fn(async (_limit: number) => ({ planned: 0, failed: 0, outcomes: [] })) },
    composition: { runOnce: vi.fn(async (_limit: number) => compositionReport()) },
    deliverableValidation: {
      runOnce: vi.fn(async (_limit: number, _context: TransitionContext) => ({
        claimed: 0,
        outcomes: [] as { deliverableVersionId: string; outcome: DeliverableValidationRunOutcome }[],
      })),
    },
  } satisfies PipelinePasses;
}

const OPTIONS = { limit: 7, maxCycles: 5 };

describe("reading the command line", () => {
  it("needs the test provider's folder, and defaults the rest", () => {
    expect(parsePipelineArguments(["--provider-folder", "/tmp/provider"])).toEqual({
      ok: true,
      value: { providerFolder: "/tmp/provider", limit: 10, maxCycles: 50 },
    });
    expect(parsePipelineArguments(["--provider-folder", "/p", "--limit", "25", "--max-cycles", "1000"])).toEqual({
      ok: true,
      value: { providerFolder: "/p", limit: 25, maxCycles: 1000 },
    });
    expect(parsePipelineArguments([])).toEqual({ ok: false, error: "--provider-folder is required" });
    expect(parsePipelineArguments(["--provider-folder", " ", "--limit", "0", "--max-cycles", "0"])).toEqual({
      ok: false,
      error:
        "--provider-folder is required; --limit must be a whole number from 1 to 25; " +
        "--max-cycles must be a whole number from 1 to 1000",
    });
  });

  it.each([
    [["--limit", "0"], "--limit must be a whole number from 1 to 25"],
    [["--limit", "26"], "--limit must be a whole number from 1 to 25"],
    [["--limit", "1.5"], "--limit must be a whole number from 1 to 25"],
    [["--max-cycles", "1001"], "--max-cycles must be a whole number from 1 to 1000"],
    [["--max-cycles", "ten"], "--max-cycles must be a whole number from 1 to 1000"],
  ])("refuses %j", (extra, error) => {
    expect(parsePipelineArguments(["--provider-folder", "/p", ...extra])).toEqual({ ok: false, error });
  });

  it("takes no limit a step would refuse", () => {
    // The usage text and the setup guide say 25: the composition's and the final validation's ceiling.
    const ceilings = [MAX_PIPELINE_LIMIT, MAX_COMPOSITION_BATCH_SIZE, MAX_DELIVERABLE_VALIDATION_BATCH_SIZE];
    expect(ceilings).toEqual([25, 25, 25]);
    expect(MAX_JOB_LAUNCH_BATCH_SIZE).toBeGreaterThan(MAX_PIPELINE_LIMIT);
  });

  it("refuses an option or a word it does not know", () => {
    expect(parsePipelineArguments(["--provider-folder", "/p", "--confirm"]).ok).toBe(false);
    expect(parsePipelineArguments(["--provider-folder", "/p", "now"]).ok).toBe(false);
  });
});

describe("running the steps", () => {
  it("runs every step once, in order, with the limit and each step's context, and stops when quiet", async () => {
    const steps = quiet();
    const order: string[] = [];
    for (const [name, step] of Object.entries(steps)) {
      for (const method of Object.values(step)) method.mockImplementationOnce(() => (order.push(name), method()));
    }
    const report = await runDevelopmentPipeline(steps, OPTIONS);

    expect(report.stop).toEqual({ kind: "QUIET" });
    expect([report.cycles, pipelineExitCode(report)]).toEqual([1, 0]);
    expect(order).toEqual([
      "launch",
      "submission",
      "providerOutput",
      "reconciliation",
      "attemptFailureSettlement",
      "failedJobSceneClosure",
      "mediaValidation",
      "mediaFailureResolution",
      "sceneDelivery",
      "compositionPlan",
      "composition",
      "deliverableValidation",
    ]);
    expect(steps.launch.runOnce).toHaveBeenCalledWith(7, null);
    expect(steps.submission.runOnce).toHaveBeenCalledWith(7, null);
    expect(steps.composition.runOnce).toHaveBeenCalledWith(7);
    const output = steps.providerOutput.runProviderOutputBatchOnce.mock.calls[0]?.[0];
    const maintenance = steps.reconciliation.runOnce.mock.calls[0]?.[0];
    const validation = steps.deliverableValidation.runOnce.mock.calls[0];
    expect([output?.limit, output?.context.eventType]).toEqual([7, "pipeline.provider_output"]);
    expect([maintenance?.limit, maintenance?.context.eventType]).toEqual([7, "pipeline.reconciliation"]);
    expect([validation?.[0], validation?.[1].eventType]).toEqual([7, "pipeline.deliverable_validation"]);
  });

  it("carries each window's cursor, and is not quiet while a window has more", async () => {
    const steps = quiet();
    steps.launch.runOnce.mockResolvedValueOnce(launchReport({ next: LAUNCH_CURSOR }));
    steps.submission.runOnce
      .mockResolvedValueOnce(submissionReport({ next: SUBMIT_CURSOR }))
      .mockResolvedValueOnce(submissionReport({ next: SUBMIT_CURSOR }));
    const report = await runDevelopmentPipeline(steps, OPTIONS);

    expect([report.stop, report.cycles]).toEqual([{ kind: "QUIET" }, 3]);
    expect(steps.launch.runOnce.mock.calls).toEqual([
      [7, null],
      [7, LAUNCH_CURSOR],
      [7, null],
    ]);
    expect(steps.submission.runOnce.mock.calls).toEqual([
      [7, null],
      [7, SUBMIT_CURSOR],
      [7, SUBMIT_CURSOR],
    ]);
  });

  it("runs another cycle after one that changed something", async () => {
    const steps = quiet();
    steps.deliverableValidation.runOnce.mockResolvedValueOnce({
      claimed: 1,
      outcomes: [{ deliverableVersionId: "gdv_1", outcome: { kind: "PUBLISHED_AND_CONSUMED" } }],
    });
    const cycles: string[] = [];
    const report = await runDevelopmentPipeline(steps, OPTIONS, (cycle, counts) =>
      cycles.push(formatPipelineCycle(cycle, counts)),
    );

    expect([report.stop, report.cycles, report.totals.deliverable_validation]).toEqual([
      { kind: "QUIET" },
      2,
      { changed: 1, failed: 0 },
    ]);
    expect(cycles).toEqual(["cycle 1: videos validated (G) 1", "cycle 2: nothing changed"]);
    expect(formatPipelineReport(report)).toBe("nothing more to do now after 2 cycles; in all: videos validated (G) 1");
  });

  it("counts only what each step changed, and what it could not handle", async () => {
    const steps = quiet();
    steps.launch.runOnce.mockResolvedValueOnce(launchReport({ launched: 2, ended: 1, failed: 1 }));
    steps.submission.runOnce.mockResolvedValueOnce(submissionReport({ sent: 3, ended: 1, failed: 2 }));
    steps.providerOutput.runProviderOutputBatchOnce.mockResolvedValueOnce({
      candidates: 5,
      results: [
        "OUTPUT_VERIFIED",
        "PROVIDER_COMPLETION_APPLIED",
        "STILL_PROCESSING",
        "PROVIDER_COMPLETION_REPLAYED",
        "INGESTION_ALREADY_CLAIMED",
        "OUTPUT_VERIFICATION_REPLAYED",
        "ALREADY_VERIFIED",
        "ATTEMPT_NOT_FOUND",
        "ATTEMPT_NOT_APPLICABLE",
        "OUTPUT_LOCATOR_UNAVAILABLE",
        "TRANSFER_RETRYABLE_FAILURE",
        "TRANSFER_SOURCE_FAILED",
        "STATUS_SOURCE_FAILED",
        "STATUS_OBSERVATION_MALFORMED",
        "TRANSFER_OUTCOME_MALFORMED",
        "PROVIDER_REALITY_CONFLICT",
        "ATTEMPT_CONTEXT_INVALID",
      ],
    });
    steps.mediaValidation.runOnce.mockResolvedValueOnce({
      claimed: 4,
      outcomes: (
        [
          "VALID",
          "INVALID_MEDIA",
          "INTEGRITY_MISMATCH",
          "RELEASED",
          "NOT_CLAIMED",
          "ALREADY_TERMINAL",
          "NOT_ELIGIBLE",
          "LOST",
        ] as const
      ).map((kind) => ({
        sceneGenerationId: kind,
        outcome: { kind },
      })),
    });
    steps.reconciliation.runOnce.mockResolvedValueOnce({
      discoveryNow: epochMillis(0),
      staleCandidates: 9,
      staleUncertaintyEntered: 1,
      dueCandidates: 9,
      exhausted: 2,
      unchanged: 9,
    });
    steps.attemptFailureSettlement.runOnce.mockResolvedValueOnce({
      settled: 2,
      unitsReleased: 9,
      failed: 1,
      outcomes: [],
    });
    steps.failedJobSceneClosure.runOnce.mockResolvedValueOnce({
      closed: 3,
      attemptsCancelled: 9,
      failed: 2,
      outcomes: [],
    });
    steps.mediaFailureResolution.runOnce.mockResolvedValueOnce({
      claimed: 2,
      recovered: 9,
      settled: 9,
      deferred: 9,
      outcomes: [],
    });
    steps.sceneDelivery.runOnce.mockResolvedValueOnce({ delivered: 4, jobsAdvanced: 9, outcomes: [] });
    steps.compositionPlan.runOnce.mockResolvedValueOnce({ planned: 0, failed: 3, outcomes: [] });
    steps.composition.runOnce.mockResolvedValueOnce(compositionReport({ considered: 3, claimed: 2, failed: 1 }));
    steps.deliverableValidation.runOnce.mockResolvedValueOnce({
      claimed: 3,
      outcomes: (
        [
          { kind: "PUBLISHED_AND_CONSUMED" },
          { kind: "PUBLISHED_AS_REPLACEMENT" },
          { kind: "NOT_PUBLISHABLE" },
          { kind: "PROPERTY_DELETED" },
          { kind: "INVALID_MEDIA" },
          { kind: "INTEGRITY_MISMATCH" },
          { kind: "RELEASED" },
          { kind: "ALREADY_PUBLISHED" },
          { kind: "NOT_CLAIMABLE" },
          { kind: "ALREADY_TERMINAL" },
          { kind: "NOT_ELIGIBLE" },
          { kind: "NOT_FOUND" },
          { kind: "LOST" },
          { kind: "FAILED", code: null },
        ] as const
      ).map((outcome, index) => ({ deliverableVersionId: `gdv_${index}`, outcome })),
    });
    const report = await runDevelopmentPipeline(steps, OPTIONS);

    expect(report.totals).toEqual({
      launch: { changed: 3, failed: 1 },
      submission: { changed: 4, failed: 2 },
      provider_output: { changed: 2, failed: 8 },
      reconciliation: { changed: 3, failed: 0 },
      attempt_failure_settlement: { changed: 2, failed: 1 },
      failed_job_scene_closure: { changed: 3, failed: 2 },
      media_validation: { changed: 4, failed: 0 },
      media_failure_resolution: { changed: 2, failed: 0 },
      scene_delivery: { changed: 4, failed: 0 },
      composition_plan: { changed: 0, failed: 3 },
      composition: { changed: 2, failed: 1 },
      deliverable_validation: { changed: 7, failed: 1 },
    });
    // It ended quiet, but something failed on the way.
    expect([report.stop, pipelineExitCode(report)]).toEqual([{ kind: "QUIET" }, 1]);
    expect(formatPipelineReport(report)).toBe(
      "nothing more to do now after 2 cycles; in all: launch 3 (1 failed), submission 4 (2 failed), " +
        "provider output 2 (8 failed), maintenance 3, provider failures settled (K) 2 (1 failed), " +
        "failed jobs' scenes closed (L) 3 (2 failed), clips checked 4, unusable clips resolved 2, " +
        "scenes delivered (F) 4, videos planned (I) 0 (3 failed), videos composed (J) 2 (1 failed), " +
        "videos validated (G) 7 (1 failed)",
    );
  });

  it("finishes the cycle, then stops, when an answer was not recorded", async () => {
    const steps = quiet();
    steps.submission.runOnce.mockResolvedValueOnce(submissionReport({ sent: 1, stopped: true, next: SUBMIT_CURSOR }));
    const report = await runDevelopmentPipeline(steps, OPTIONS);

    expect([report.stop, report.cycles, pipelineExitCode(report)]).toEqual([{ kind: "SUBMISSION_STOPPED" }, 1, 1]);
    expect(steps.deliverableValidation.runOnce).toHaveBeenCalledTimes(1);
    expect(formatPipelineReport(report)).toBe(
      "stopped: an answer from the test provider was not recorded after 1 cycle; in all: submission 1",
    );
  });

  it("stops at once when a step throws, keeping only an application error's code", async () => {
    const steps = quiet();
    steps.launch.runOnce.mockResolvedValueOnce(launchReport({ launched: 1 }));
    steps.sceneDelivery.runOnce.mockRejectedValueOnce(new AppError("INTERNAL_ERROR", "a secret-looking message"));
    const cycles: string[] = [];
    const report = await runDevelopmentPipeline(steps, OPTIONS, (cycle, counts) =>
      cycles.push(formatPipelineCycle(cycle, counts)),
    );

    expect(report.stop).toEqual({ kind: "STEP_THREW", step: "scene_delivery", code: "INTERNAL_ERROR" });
    expect([report.cycles, pipelineExitCode(report)]).toEqual([1, 1]);
    expect(steps.compositionPlan.runOnce).not.toHaveBeenCalled();
    // What the cycle changed before the throw is still printed.
    expect(cycles).toEqual(["cycle 1: launch 1"]);
    expect(formatPipelineReport(report)).toBe(
      "stopped: scenes delivered (F) threw INTERNAL_ERROR after 1 cycle; in all: launch 1",
    );

    const other = quiet();
    other.launch.runOnce.mockRejectedValueOnce(new Error("connection string here"));
    const thrown = await runDevelopmentPipeline(other, OPTIONS);
    expect(thrown.stop).toEqual({ kind: "STEP_THREW", step: "launch", code: null });
    expect(formatPipelineReport(thrown)).toBe("stopped: launch threw after 1 cycle; in all: nothing changed");
  });

  it("gives up after the cycle limit while work keeps moving", async () => {
    const steps = quiet();
    steps.sceneDelivery.runOnce.mockResolvedValue({ delivered: 1, jobsAdvanced: 0, outcomes: [] });
    const report = await runDevelopmentPipeline(steps, { limit: 1, maxCycles: 3 });

    expect([report.stop, report.cycles, pipelineExitCode(report)]).toEqual([{ kind: "CYCLE_LIMIT" }, 3, 1]);
    expect(report.totals.scene_delivery).toEqual({ changed: 3, failed: 0 });
    expect(formatPipelineReport(report)).toBe(
      "stopped: the cycle limit was reached with work still moving after 3 cycles; in all: scenes delivered (F) 3",
    );
  });

  it("names the steps in the order they run", () => {
    expect(PIPELINE_ORDER).toHaveLength(12);
    expect(new Set(PIPELINE_ORDER).size).toBe(12);
  });
});

describe("the database guard", () => {
  it("counts the attempts of any provider but the test provider, and refuses when there is one", async () => {
    const count = vi.fn(async (_args: unknown) => 0);
    const prisma = { sceneGeneration: { count } } as unknown as Parameters<typeof refuseForeignAttempts>[0];
    await expect(refuseForeignAttempts(prisma)).resolves.toBeUndefined();
    expect(count).toHaveBeenCalledWith({ where: { providerName: { not: "fake" } } });

    count.mockResolvedValueOnce(1);
    await expect(refuseForeignAttempts(prisma)).rejects.toMatchObject({ code: "CONFIGURATION_ERROR" });
  });
});
