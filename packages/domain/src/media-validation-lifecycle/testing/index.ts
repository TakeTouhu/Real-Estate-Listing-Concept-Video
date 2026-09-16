/**
 * Deterministic stand-ins for the media-validation lifecycle boundary.
 *
 * **Test support only.** The repository fake models the durable rules the real
 * one enforces in SQL — lease token, version and receipt guards, terminal rows
 * that cannot be overwritten — so runner behaviour can be proven without a
 * database, while the integration suite proves the SQL agrees.
 */

import { managedGenerationOutputKey, type ManagedOutputVerificationReceipt } from "../../completion/output";
import type {
  ManagedOutputMediaFacts,
  ManagedOutputMediaInvalidReason,
} from "../../provider-output/media-validation";
import type { DurableMediaValidationRecord, ManagedOutputMediaValidationStatus } from "../durable";
import type {
  MediaValidationCandidate,
  MediaValidationCandidateQuery,
  MediaValidationClaim,
  MediaValidationClaimInput,
  MediaValidationClaimOutcome,
  MediaValidationFinalizeInvalidInput,
  MediaValidationFinalizeMismatchInput,
  MediaValidationFinalizeValidInput,
  MediaValidationLeaseTokenFactory,
  MediaValidationLifecycleRepository,
  MediaValidationReleaseInput,
  MediaValidationWriteOutcome,
} from "../ports";

/** A lease-token factory that counts, so tests can assert exact tokens. */
export class FakeLeaseTokens implements MediaValidationLeaseTokenFactory {
  readonly issued: string[] = [];
  #n = 0;

  constructor(private readonly prefix = "lease") {}

  next(): string {
    this.#n += 1;
    const token = `${this.prefix}-${this.#n}`;
    this.issued.push(token);
    return token;
  }
}

/** One durable row inside the fake. */
export interface FakeValidationRow {
  status: ManagedOutputMediaValidationStatus;
  receiptSha256: string;
  receiptSizeBytes: number;
  leaseToken: string | null;
  leaseExpiresAt: number | null;
  nextAttemptAt: number | null;
  attemptCount: number;
  version: number;
  invalidReason: ManagedOutputMediaInvalidReason | null;
  facts: ManagedOutputMediaFacts | null;
  validatedAt: number | null;
}

/** One eligible attempt inside the fake. */
export interface FakeEligibleAttempt {
  readonly sceneGenerationId: string;
  readonly organizationId: string;
  readonly receipt: ManagedOutputVerificationReceipt;
  readonly outputVerifiedAt: number;
  /** Anything other than OUTPUT_VERIFIED makes the attempt ineligible. */
  readonly orchestrationState?: string;
}

export interface FakeMediaValidationRepositoryOptions {
  /** Called at the start of every method, so ordering can be recorded. */
  readonly onCall?: (method: string) => void;
}

/**
 * An in-memory repository enforcing the same durable rules as the SQL one.
 */
export class FakeMediaValidationRepository implements MediaValidationLifecycleRepository {
  readonly attempts = new Map<string, FakeEligibleAttempt>();
  readonly rows = new Map<string, FakeValidationRow>();
  readonly calls: string[] = [];
  readonly #options: FakeMediaValidationRepositoryOptions;

  constructor(options: FakeMediaValidationRepositoryOptions = {}) {
    this.#options = options;
  }

  #note(method: string): void {
    this.calls.push(method);
    this.#options.onCall?.(method);
  }

  addAttempt(attempt: FakeEligibleAttempt): void {
    this.attempts.set(attempt.sceneGenerationId, attempt);
  }

  async findCandidates(query: MediaValidationCandidateQuery): Promise<readonly MediaValidationCandidate[]> {
    this.#note("findCandidates");
    const eligible = [...this.attempts.values()]
      .filter((a) => (a.orchestrationState ?? "OUTPUT_VERIFIED") === "OUTPUT_VERIFIED")
      .filter((a) => {
        const row = this.rows.get(a.sceneGenerationId);
        if (row === undefined) return true;
        if (row.status === "PENDING") {
          return row.nextAttemptAt === null || row.nextAttemptAt <= query.now;
        }
        if (row.status === "RUNNING") {
          return row.leaseExpiresAt !== null && row.leaseExpiresAt <= query.now;
        }
        return false;
      })
      .sort(
        (a, b) =>
          a.outputVerifiedAt - b.outputVerifiedAt ||
          a.sceneGenerationId.localeCompare(b.sceneGenerationId),
      )
      .slice(0, query.limit);
    return eligible.map((a) => ({ sceneGenerationId: a.sceneGenerationId }));
  }

  async claim(input: MediaValidationClaimInput): Promise<MediaValidationClaimOutcome> {
    this.#note("claim");
    const attempt = this.attempts.get(input.sceneGenerationId);
    if (attempt === undefined) return { kind: "NOT_ELIGIBLE" };
    if ((attempt.orchestrationState ?? "OUTPUT_VERIFIED") !== "OUTPUT_VERIFIED") {
      return { kind: "NOT_ELIGIBLE" };
    }

    const destinationKey = managedGenerationOutputKey({
      organizationId: attempt.organizationId,
      attemptId: attempt.sceneGenerationId,
    });
    const existing = this.rows.get(input.sceneGenerationId);

    if (existing === undefined) {
      this.rows.set(input.sceneGenerationId, {
        status: "RUNNING",
        receiptSha256: attempt.receipt.sha256,
        receiptSizeBytes: attempt.receipt.sizeBytes,
        leaseToken: input.leaseToken,
        leaseExpiresAt: input.leaseExpiresAt,
        nextAttemptAt: null,
        attemptCount: 1,
        version: 1,
        invalidReason: null,
        facts: null,
        validatedAt: null,
      });
      return {
        kind: "CLAIMED",
        claim: {
          validationId: `momv_${input.sceneGenerationId}`,
          sceneGenerationId: input.sceneGenerationId,
          version: 1,
          leaseToken: input.leaseToken,
          destinationKey,
          expectedReceipt: attempt.receipt,
        },
      };
    }

    if (
      existing.status === "VALID" ||
      existing.status === "INVALID_MEDIA" ||
      existing.status === "INTEGRITY_MISMATCH"
    ) {
      return { kind: "ALREADY_TERMINAL" };
    }

    const claimable =
      existing.status === "PENDING"
        ? existing.nextAttemptAt === null || existing.nextAttemptAt <= input.now
        : existing.leaseExpiresAt !== null && existing.leaseExpiresAt <= input.now;
    if (!claimable) return { kind: "NOT_CLAIMED" };

    existing.status = "RUNNING";
    existing.leaseToken = input.leaseToken;
    existing.leaseExpiresAt = input.leaseExpiresAt;
    existing.nextAttemptAt = null;
    existing.attemptCount += 1;
    existing.version += 1;
    return {
      kind: "CLAIMED",
      claim: {
        validationId: `momv_${input.sceneGenerationId}`,
        sceneGenerationId: input.sceneGenerationId,
        version: existing.version,
        leaseToken: input.leaseToken,
        destinationKey,
        expectedReceipt: attempt.receipt,
      },
    };
  }

  /** The three guards the SQL `WHERE` clause applies, in one place. */
  #guard(claim: MediaValidationClaim): FakeValidationRow | null {
    const row = this.rows.get(claim.sceneGenerationId);
    if (row === undefined) return null;
    if (row.status !== "RUNNING") return null;
    if (row.version !== claim.version) return null;
    if (row.leaseToken !== claim.leaseToken) return null;
    if (row.receiptSha256 !== claim.expectedReceipt.sha256) return null;
    if (row.receiptSizeBytes !== claim.expectedReceipt.sizeBytes) return null;
    return row;
  }

  async finalizeValid(input: MediaValidationFinalizeValidInput): Promise<MediaValidationWriteOutcome> {
    this.#note("finalizeValid");
    const row = this.#guard(input.claim);
    if (row === null) return { kind: "LOST" };
    row.status = "VALID";
    row.facts = input.facts;
    row.invalidReason = null;
    row.leaseToken = null;
    row.leaseExpiresAt = null;
    row.nextAttemptAt = null;
    row.validatedAt = input.validatedAt;
    row.version += 1;
    return { kind: "WRITTEN" };
  }

  async finalizeInvalidMedia(
    input: MediaValidationFinalizeInvalidInput,
  ): Promise<MediaValidationWriteOutcome> {
    this.#note("finalizeInvalidMedia");
    const row = this.#guard(input.claim);
    if (row === null) return { kind: "LOST" };
    row.status = "INVALID_MEDIA";
    row.invalidReason = input.reason;
    row.facts = null;
    row.leaseToken = null;
    row.leaseExpiresAt = null;
    row.nextAttemptAt = null;
    row.validatedAt = input.validatedAt;
    row.version += 1;
    return { kind: "WRITTEN" };
  }

  async finalizeIntegrityMismatch(
    input: MediaValidationFinalizeMismatchInput,
  ): Promise<MediaValidationWriteOutcome> {
    this.#note("finalizeIntegrityMismatch");
    const row = this.#guard(input.claim);
    if (row === null) return { kind: "LOST" };
    row.status = "INTEGRITY_MISMATCH";
    row.invalidReason = null;
    row.facts = null;
    row.leaseToken = null;
    row.leaseExpiresAt = null;
    row.nextAttemptAt = null;
    row.validatedAt = input.validatedAt;
    row.version += 1;
    return { kind: "WRITTEN" };
  }

  async releaseToPending(input: MediaValidationReleaseInput): Promise<MediaValidationWriteOutcome> {
    this.#note("releaseToPending");
    const row = this.#guard(input.claim);
    if (row === null) return { kind: "LOST" };
    row.status = "PENDING";
    row.leaseToken = null;
    row.leaseExpiresAt = null;
    row.nextAttemptAt = input.nextAttemptAt;
    row.invalidReason = null;
    row.facts = null;
    row.validatedAt = null;
    row.version += 1;
    return { kind: "WRITTEN" };
  }

  async findBySceneGeneration(
    sceneGenerationId: string,
  ): Promise<DurableMediaValidationRecord | null> {
    this.#note("findBySceneGeneration");
    const row = this.rows.get(sceneGenerationId);
    if (row === undefined) return null;
    const receipt = {
      sha256: row.receiptSha256,
      sizeBytes: row.receiptSizeBytes,
    } as DurableMediaValidationRecord["receipt"];
    const base = { receipt, attemptCount: row.attemptCount, version: row.version };
    switch (row.status) {
      case "PENDING":
        return { status: "PENDING", ...base, nextAttemptAt: row.nextAttemptAt };
      case "RUNNING":
        return { status: "RUNNING", ...base, leaseExpiresAt: row.leaseExpiresAt ?? 0 };
      case "VALID":
        return {
          status: "VALID",
          ...base,
          facts: row.facts as ManagedOutputMediaFacts,
          validatedAt: row.validatedAt ?? 0,
        };
      case "INVALID_MEDIA":
        return {
          status: "INVALID_MEDIA",
          ...base,
          reason: row.invalidReason as ManagedOutputMediaInvalidReason,
          validatedAt: row.validatedAt ?? 0,
        };
      case "INTEGRITY_MISMATCH":
        return { status: "INTEGRITY_MISMATCH", ...base, validatedAt: row.validatedAt ?? 0 };
    }
  }
}
