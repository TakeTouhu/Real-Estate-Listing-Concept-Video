/**
 * A deterministic in-memory stand-in for the validated-Scene-delivery boundary.
 *
 * **Test support only.** It models the same durable rules Transaction F
 * enforces in SQL — the `VALID`-only gate, byte identity against the attempt's
 * verified receipt, latest-attempt authority by ordinal, the per-kind expected
 * Scene state, the delivered pointer, and Job readiness — so runner behaviour
 * can be proven without a database. The integration suite proves the SQL agrees;
 * this proves the runner does the right thing with whatever the boundary
 * answers.
 *
 * It is deliberately not a second production implementation: it has no locks,
 * no transaction and no concurrency, because the properties it exists to
 * support are the runner's, not the database's.
 */

import type { TransitionContext } from "../../orchestration/ports";
import {
  ValidatedSceneDeliveryDefect,
  validateSceneDeliveryBatchLimit,
  type ValidatedSceneDeliveryOutcome,
} from "../delivery";
import type {
  DeliverValidatedSceneInput,
  ValidatedSceneDeliveryCandidate,
  ValidatedSceneDeliveryQuery,
  ValidatedSceneDeliveryRepository,
} from "../ports";

export interface FakeJobRow {
  id: string;
  organizationId: string;
  state: string;
  version: number;
}

export interface FakeSceneRow {
  id: string;
  jobId: string;
  state: string;
  version: number;
  deliveredRequestId: string | null;
}

export interface FakeRequestRow {
  id: string;
  sceneId: string;
  kind: "INITIAL" | "USER_REGENERATION";
  state: string;
  version: number;
  deliveredAt: Date | null;
}

export interface FakeAttemptRow {
  id: string;
  requestId: string;
  ordinal: number;
  orchestrationState: string;
  outputSha256: string | null;
  outputSizeBytes: number | null;
}

export interface FakeValidationRow {
  id: string;
  attemptId: string;
  status: string;
  validatedAt: Date | null;
  receiptSha256: string;
  receiptSizeBytes: number;
}

/** One complete deliverable chain, with sensible defaults for every level. */
export interface FakeChainSpec {
  readonly suffix: string;
  readonly organizationId?: string;
  readonly jobId?: string;
  readonly jobState?: string;
  readonly sceneState?: string;
  readonly requestKind?: "INITIAL" | "USER_REGENERATION";
  readonly requestState?: string;
  readonly ordinal?: number;
  readonly orchestrationState?: string;
  readonly sha256?: string;
  readonly sizeBytes?: number;
  readonly validationStatus?: string;
  readonly validatedAt?: Date | null;
  readonly receiptSha256?: string;
  readonly receiptSizeBytes?: number;
  readonly deliveredRequestId?: string | null;
}

const SHA = "a".repeat(64);

export class FakeValidatedSceneDeliveryRepository implements ValidatedSceneDeliveryRepository {
  readonly jobs = new Map<string, FakeJobRow>();
  readonly scenes = new Map<string, FakeSceneRow>();
  readonly requests = new Map<string, FakeRequestRow>();
  readonly attempts = new Map<string, FakeAttemptRow>();
  readonly validations = new Map<string, FakeValidationRow>();

  /** Every call, in order, so a test can prove what the runner did and did not do. */
  readonly calls: string[] = [];
  readonly deliveries: DeliverValidatedSceneInput[] = [];
  /** Set to make the listing return the same candidate twice. */
  duplicateCandidates = false;

  /**
   * Build one chain: job, scene, request, attempt, validation.
   *
   * Returns the attempt id, which is what `deliverValidatedScene` addresses.
   */
  seed(spec: FakeChainSpec): string {
    const jobId = spec.jobId ?? `job_${spec.suffix}`;
    const sceneId = `scene_${spec.suffix}`;
    const requestId = `req_${spec.suffix}`;
    const attemptId = `sgen_${spec.suffix}`;
    const size = spec.sizeBytes ?? 4096;

    if (!this.jobs.has(jobId)) {
      this.jobs.set(jobId, {
        id: jobId,
        organizationId: spec.organizationId ?? "org_a",
        state: spec.jobState ?? "GENERATING",
        version: 0,
      });
    }
    this.scenes.set(sceneId, {
      id: sceneId,
      jobId,
      state: spec.sceneState ?? "GENERATING",
      version: 0,
      deliveredRequestId: spec.deliveredRequestId ?? null,
    });
    this.requests.set(requestId, {
      id: requestId,
      sceneId,
      kind: spec.requestKind ?? "INITIAL",
      state: spec.requestState ?? "GENERATING",
      version: 0,
      deliveredAt: null,
    });
    this.attempts.set(attemptId, {
      id: attemptId,
      requestId,
      ordinal: spec.ordinal ?? 1,
      orchestrationState: spec.orchestrationState ?? "OUTPUT_VERIFIED",
      outputSha256: spec.sha256 ?? SHA,
      outputSizeBytes: size,
    });
    this.validations.set(`mval_${spec.suffix}`, {
      id: `mval_${spec.suffix}`,
      attemptId,
      status: spec.validationStatus ?? "VALID",
      validatedAt: spec.validatedAt === undefined ? new Date(1) : spec.validatedAt,
      receiptSha256: spec.receiptSha256 ?? spec.sha256 ?? SHA,
      receiptSizeBytes: spec.receiptSizeBytes ?? size,
    });
    return attemptId;
  }

  /** Add a newer sibling attempt on the same request, without a verdict. */
  seedNewerAttempt(attemptId: string, ordinal: number): void {
    const attempt = required(this.attempts.get(attemptId), "attempt");
    this.attempts.set(`${attemptId}_next`, {
      id: `${attemptId}_next`,
      requestId: attempt.requestId,
      ordinal,
      orchestrationState: "SUBMITTED",
      outputSha256: null,
      outputSizeBytes: null,
    });
  }

  async findValidatedDeliveryCandidates(
    query: ValidatedSceneDeliveryQuery,
  ): Promise<readonly ValidatedSceneDeliveryCandidate[]> {
    this.calls.push("find");
    const limit = validateSceneDeliveryBatchLimit(query.limit);
    const found: { candidate: ValidatedSceneDeliveryCandidate; at: number }[] = [];
    for (const validation of this.validations.values()) {
      if (validation.status !== "VALID" || validation.validatedAt === null) continue;
      const attempt = this.attempts.get(validation.attemptId);
      if (attempt === undefined || attempt.orchestrationState !== "OUTPUT_VERIFIED") continue;
      const request = this.requests.get(attempt.requestId);
      if (request === undefined || request.state !== "GENERATING") continue;
      const scene = this.scenes.get(request.sceneId);
      if (scene === undefined) continue;
      const job = this.jobs.get(scene.jobId);
      if (job === undefined) continue;
      found.push({
        at: validation.validatedAt.getTime(),
        candidate: {
          validationId: validation.id,
          sceneGenerationId: attempt.id,
          generationSceneRequestId: request.id,
          organizationId: job.organizationId,
        },
      });
    }
    found.sort(
      (left, right) =>
        left.at - right.at || left.candidate.validationId.localeCompare(right.candidate.validationId),
    );
    const listed = found.map((entry) => entry.candidate);
    const withDuplicates = this.duplicateCandidates ? listed.flatMap((one) => [one, one]) : listed;
    return withDuplicates.slice(0, limit);
  }

  async deliverValidatedScene(
    input: DeliverValidatedSceneInput,
  ): Promise<ValidatedSceneDeliveryOutcome> {
    this.calls.push(`deliver:${input.sceneGenerationId}`);
    this.deliveries.push(input);

    const attempt = this.attempts.get(input.sceneGenerationId);
    if (attempt === undefined) return { kind: "NOT_FOUND" };
    const request = this.requests.get(attempt.requestId);
    if (request === undefined) return { kind: "NOT_FOUND" };
    const scene = this.scenes.get(request.sceneId);
    if (scene === undefined) return { kind: "NOT_FOUND" };
    const job = this.jobs.get(scene.jobId);
    if (job === undefined || job.organizationId !== input.organizationId) {
      return { kind: "NOT_FOUND" };
    }

    // Idempotent replay first, exactly as the SQL does.
    const pointsHere = scene.deliveredRequestId === request.id;
    const delivered = request.state === "DELIVERED";
    if (delivered && pointsHere && scene.state === "READY") return { kind: "ALREADY_APPLIED" };
    if (delivered || pointsHere) throw new ValidatedSceneDeliveryDefect("PARTIAL_DELIVERY_STATE");

    const validation = [...this.validations.values()].find(
      (row) => row.attemptId === attempt.id,
    );
    if (validation === undefined) return { kind: "NOT_ELIGIBLE" };
    if (validation.status !== "VALID" || validation.validatedAt === null) {
      return { kind: "NOT_ELIGIBLE" };
    }
    if (attempt.orchestrationState !== "OUTPUT_VERIFIED") return { kind: "NOT_ELIGIBLE" };
    if (request.state !== "GENERATING") return { kind: "NOT_ELIGIBLE" };

    if (
      attempt.outputSha256 === null ||
      attempt.outputSizeBytes === null ||
      validation.receiptSha256 !== attempt.outputSha256 ||
      validation.receiptSizeBytes !== attempt.outputSizeBytes
    ) {
      throw new ValidatedSceneDeliveryDefect("RECEIPT_BINDING_CONFLICT");
    }

    const highest = Math.max(
      ...[...this.attempts.values()]
        .filter((row) => row.requestId === request.id)
        .map((row) => row.ordinal),
    );
    if (attempt.ordinal !== highest) return { kind: "NOT_ELIGIBLE" };

    const expected = request.kind === "USER_REGENERATION" ? "REVISING" : "GENERATING";
    if (scene.state !== expected) throw new ValidatedSceneDeliveryDefect("SCENE_STATE_CONFLICT");

    if (scene.deliveredRequestId !== null) {
      const previous = this.requests.get(scene.deliveredRequestId);
      if (previous === undefined || previous.sceneId !== scene.id) {
        throw new ValidatedSceneDeliveryDefect("DELIVERY_POINTER_CONFLICT");
      }
      if (previous.state !== "DELIVERED") {
        throw new ValidatedSceneDeliveryDefect("PARTIAL_DELIVERY_STATE");
      }
    }

    request.state = "DELIVERED";
    request.version += 1;
    request.deliveredAt = new Date();
    scene.state = "READY";
    scene.version += 1;
    scene.deliveredRequestId = request.id;

    const remaining = [...this.scenes.values()].filter(
      (row) => row.jobId === job.id && row.state !== "READY",
    ).length;
    let jobAdvanced = false;
    if (remaining === 0 && job.state === "GENERATING") {
      job.state = "SCENES_READY";
      job.version += 1;
      jobAdvanced = true;
    }
    return { kind: "DELIVERED", jobAdvanced };
  }
}

function required<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`fake world is missing a ${what}`);
  return value;
}

/** A fresh transition context, with a caller-chosen correlation id. */
export function fakeDeliveryContext(correlationId: string): TransitionContext {
  return {
    actorType: "SYSTEM",
    actorUserId: null,
    correlationId,
    causationId: null,
    reasonCode: null,
    metadata: {},
    eventType: "scene_request.delivered",
  };
}
