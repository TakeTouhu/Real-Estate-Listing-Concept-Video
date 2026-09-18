import { describe, expect, it } from "vitest";
import { AppError } from "@app/shared";
import {
  MAX_SCENE_DELIVERY_BATCH_SIZE,
  SCENE_REQUEST_DELIVERED_EVENT_TYPE,
  SCENE_READY_EVENT_TYPE,
  JOB_SCENES_READY_EVENT_TYPE,
  VALIDATED_DELIVERY_REASON_CODE,
  ValidatedSceneDeliveryDefect,
  validateSceneDeliveryBatchLimit,
} from "./delivery";
import { ValidatedSceneDeliveryRunner } from "./runner";
import {
  FakeValidatedSceneDeliveryRepository,
  fakeDeliveryContext,
} from "./testing";

/**
 * The dormant delivery runner against an in-memory boundary that enforces the
 * same durable rules Transaction F enforces in SQL.
 *
 * These tests are about the *runner*: what it claims, how many times it acts on
 * a candidate, what it counts, and what it refuses to do with a bad bound. The
 * database suite proves the SQL agrees about eligibility.
 */

function runner(repository: FakeValidatedSceneDeliveryRepository): {
  runner: ValidatedSceneDeliveryRunner;
  contexts: string[];
} {
  const contexts: string[] = [];
  let n = 0;
  return {
    contexts,
    runner: new ValidatedSceneDeliveryRunner({
      repository,
      context: () => {
        n += 1;
        const id = `corr-${n}`;
        contexts.push(id);
        return fakeDeliveryContext(id);
      },
    }),
  };
}

describe("the batch bound is proved, never clamped", () => {
  it("accepts the frozen maximum and refuses anything past it", () => {
    expect(validateSceneDeliveryBatchLimit(1)).toBe(1);
    expect(validateSceneDeliveryBatchLimit(MAX_SCENE_DELIVERY_BATCH_SIZE)).toBe(
      MAX_SCENE_DELIVERY_BATCH_SIZE,
    );
    expect(MAX_SCENE_DELIVERY_BATCH_SIZE).toBe(100);
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 101, 2 ** 53]) {
      expect(() => validateSceneDeliveryBatchLimit(bad)).toThrow(AppError);
    }
  });

  it("refuses a bad limit before touching the repository", async () => {
    const repository = new FakeValidatedSceneDeliveryRepository();
    const { runner: subject } = runner(repository);
    await expect(subject.runOnce(0)).rejects.toThrow(AppError);
    await expect(subject.runOnce(Number.POSITIVE_INFINITY)).rejects.toThrow(AppError);
    // Nothing was listed and nothing was delivered: an unusable bound must not
    // become a query.
    expect(repository.calls).toEqual([]);
  });
});

describe("one pass over eligible candidates", () => {
  it("delivers every eligible candidate exactly once", async () => {
    const repository = new FakeValidatedSceneDeliveryRepository();
    const first = repository.seed({ suffix: "one", jobId: "job_x", validatedAt: new Date(1) });
    const second = repository.seed({ suffix: "two", jobId: "job_x", validatedAt: new Date(2) });

    const { runner: subject, contexts } = runner(repository);
    const report = await subject.runOnce(10);

    expect(report.delivered).toBe(2);
    expect(repository.calls).toEqual(["find", `deliver:${first}`, `deliver:${second}`]);
    // A fresh context per delivery, so two deliveries never share a correlation.
    expect(contexts).toEqual(["corr-1", "corr-2"]);
    expect(repository.deliveries.map((one) => one.context.correlationId)).toEqual([
      "corr-1",
      "corr-2",
    ]);
  });

  it("counts the Job advance once, on the last Scene of the Job", async () => {
    const repository = new FakeValidatedSceneDeliveryRepository();
    repository.seed({ suffix: "one", jobId: "job_x", validatedAt: new Date(1) });
    repository.seed({ suffix: "two", jobId: "job_x", validatedAt: new Date(2) });

    const { runner: subject } = runner(repository);
    const report = await subject.runOnce(10);

    expect(report.delivered).toBe(2);
    expect(report.jobsAdvanced).toBe(1);
    expect(report.outcomes.map((one) => one.outcome)).toEqual([
      { kind: "DELIVERED", jobAdvanced: false },
      { kind: "DELIVERED", jobAdvanced: true },
    ]);
    expect(repository.jobs.get("job_x")?.state).toBe("SCENES_READY");
  });

  it("acts on a duplicated candidate only once", async () => {
    const repository = new FakeValidatedSceneDeliveryRepository();
    const attempt = repository.seed({ suffix: "one" });
    repository.duplicateCandidates = true;

    const { runner: subject } = runner(repository);
    const report = await subject.runOnce(10);

    expect(report.delivered).toBe(1);
    expect(repository.calls).toEqual(["find", `deliver:${attempt}`]);
  });

  it("passes the organization the listing reported, not a caller's guess", async () => {
    const repository = new FakeValidatedSceneDeliveryRepository();
    repository.seed({ suffix: "one", organizationId: "org_b" });

    const { runner: subject } = runner(repository);
    await subject.runOnce(10);

    expect(repository.deliveries.map((one) => one.organizationId)).toEqual(["org_b"]);
  });
});

describe("what a pass does not do", () => {
  it("lists nothing that lacks a VALID verdict", async () => {
    const repository = new FakeValidatedSceneDeliveryRepository();
    repository.seed({ suffix: "pending", validationStatus: "PENDING", validatedAt: null });
    repository.seed({ suffix: "running", validationStatus: "RUNNING", validatedAt: null });
    repository.seed({ suffix: "invalid", validationStatus: "INVALID_MEDIA" });
    repository.seed({ suffix: "mismatch", validationStatus: "INTEGRITY_MISMATCH" });

    const { runner: subject } = runner(repository);
    const report = await subject.runOnce(10);

    expect(report.delivered).toBe(0);
    expect(repository.calls).toEqual(["find"]);
    // Every Scene stayed exactly where it was: a terminal bad verdict does
    // nothing at all in this phase.
    expect([...repository.scenes.values()].map((one) => one.state)).toEqual([
      "GENERATING",
      "GENERATING",
      "GENERATING",
      "GENERATING",
    ]);
    expect([...repository.requests.values()].map((one) => one.state)).toEqual([
      "GENERATING",
      "GENERATING",
      "GENERATING",
      "GENERATING",
    ]);
  });

  it("is never offered a superseded attempt, so it cannot be starved by one", async () => {
    const repository = new FakeValidatedSceneDeliveryRepository();
    const stale = repository.seed({ suffix: "stale", validatedAt: new Date(1) });
    repository.seedNewerAttempt(stale, 2);
    const fresh = repository.seed({ suffix: "fresh", validatedAt: new Date(2) });

    const { runner: subject } = runner(repository);
    // A bound of one: the slot must go to work that can actually be delivered,
    // not to the older permanently-ineligible row.
    const report = await subject.runOnce(1);

    expect(report.delivered).toBe(1);
    expect(repository.calls).toEqual(["find", `deliver:${fresh}`]);
  });

  it("still refuses a candidate that was superseded after it was listed", async () => {
    const repository = new FakeValidatedSceneDeliveryRepository();
    const attempt = repository.seed({ suffix: "stale" });

    // The listing is a hint, and this is the window it cannot close: the row
    // was eligible when listed and is superseded by the time it is delivered.
    const listed = await repository.findValidatedDeliveryCandidates({ limit: 10 });
    expect(listed.map((one) => one.sceneGenerationId)).toEqual([attempt]);
    repository.seedNewerAttempt(attempt, 2);

    // Addressed directly, exactly as a runner holding a stale listing would.
    const outcome = await repository.deliverValidatedScene({
      organizationId: "org_a",
      sceneGenerationId: attempt,
      context: fakeDeliveryContext("corr-superseded"),
    });

    expect(outcome).toEqual({ kind: "NOT_ELIGIBLE" });
    expect(repository.requests.get("req_stale")?.state).toBe("GENERATING");
    expect(repository.scenes.get("scene_stale")?.state).toBe("GENERATING");
  });

  it("is never offered a candidate whose Job is not generating", async () => {
    const repository = new FakeValidatedSceneDeliveryRepository();
    repository.seed({ suffix: "revising", jobState: "REVISING" });

    const { runner: subject } = runner(repository);
    const report = await subject.runOnce(10);

    expect(report.delivered).toBe(0);
    expect(repository.calls).toEqual(["find"]);
  });

  it("lets a missing regeneration predecessor out as a defect", async () => {
    const repository = new FakeValidatedSceneDeliveryRepository();
    repository.seed({
      suffix: "orphan",
      requestKind: "USER_REGENERATION",
      sceneState: "REVISING",
    });

    const { runner: subject } = runner(repository);
    await expect(subject.runOnce(10)).rejects.toMatchObject({
      code: "REGENERATION_PREDECESSOR_MISSING",
    });
  });

  it("reports a replay as ALREADY_APPLIED and writes nothing again", async () => {
    const repository = new FakeValidatedSceneDeliveryRepository();
    const attempt = repository.seed({ suffix: "one" });

    const { runner: subject } = runner(repository);
    await subject.runOnce(10);
    const afterFirst = {
      requestVersion: repository.requests.get("req_one")?.version,
      sceneVersion: repository.scenes.get("scene_one")?.version,
      deliveredAt: repository.requests.get("req_one")?.deliveredAt,
    };

    // The listing no longer returns it, so ask the boundary directly — the
    // property under test is that a second apply is inert.
    const replay = await repository.deliverValidatedScene({
      organizationId: "org_a",
      sceneGenerationId: attempt,
      context: fakeDeliveryContext("corr-replay"),
    });

    expect(replay).toEqual({ kind: "ALREADY_APPLIED" });
    expect(repository.requests.get("req_one")?.version).toBe(afterFirst.requestVersion);
    expect(repository.scenes.get("scene_one")?.version).toBe(afterFirst.sceneVersion);
    expect(repository.requests.get("req_one")?.deliveredAt).toBe(afterFirst.deliveredAt);
  });

  it("lets a consistency defect out instead of swallowing it", async () => {
    const repository = new FakeValidatedSceneDeliveryRepository();
    // A verdict bound to different bytes than the attempt's verified receipt.
    repository.seed({ suffix: "bad", receiptSha256: "b".repeat(64) });

    const { runner: subject } = runner(repository);
    await expect(subject.runOnce(10)).rejects.toBeInstanceOf(ValidatedSceneDeliveryDefect);
  });

  it("stops at SCENES_READY and never advances a Job further", async () => {
    const repository = new FakeValidatedSceneDeliveryRepository();
    repository.seed({ suffix: "only" });

    const { runner: subject } = runner(repository);
    await subject.runOnce(10);

    expect(repository.jobs.get("job_only")?.state).toBe("SCENES_READY");
    // A second pass finds nothing and the Job does not move again.
    const second = await subject.runOnce(10);
    expect(second.delivered).toBe(0);
    expect(repository.jobs.get("job_only")?.state).toBe("SCENES_READY");
    expect(repository.jobs.get("job_only")?.version).toBe(1);
  });
});

describe("the event vocabulary is fixed and application-owned", () => {
  it("names one event per transition and one reason code", () => {
    expect(SCENE_REQUEST_DELIVERED_EVENT_TYPE).toBe("scene_request.delivered");
    expect(SCENE_READY_EVENT_TYPE).toBe("scene.ready");
    expect(JOB_SCENES_READY_EVENT_TYPE).toBe("job.scenes_ready");
    expect(VALIDATED_DELIVERY_REASON_CODE).toBe("VALIDATED_MEDIA_DELIVERY");
  });

  it("gives every defect code a fixed message carrying no external text", () => {
    for (const code of [
      "RECEIPT_BINDING_CONFLICT",
      "SCENE_STATE_CONFLICT",
      "DELIVERY_POINTER_CONFLICT",
      "PARTIAL_DELIVERY_STATE",
      "REGENERATION_PREDECESSOR_MISSING",
    ] as const) {
      const defect = new ValidatedSceneDeliveryDefect(code);
      expect(defect.code).toBe(code);
      expect(defect.name).toBe("ValidatedSceneDeliveryDefect");
      expect(defect.message.length).toBeGreaterThan(0);
      // No identifier, key, URL or provider text ever reaches the message.
      expect(defect.message).not.toMatch(/https?:|sgen_|scene_|req_|job_/);
    }
  });
});
