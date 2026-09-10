import type { PrismaClient } from "@prisma/client";
import type {
  CompletionCandidate,
  CompletionRepository,
  ProviderPollingContext,
  ProviderPollingContextReader,
} from "@app/domain";

/**
 * The one persisted read that begins an orchestration run.
 *
 * Short, tenant-scoped, and outside any transaction — deliberately. Everything
 * this returns is advisory: it says what was true a moment ago and authorizes
 * nothing, because holding a lock from here until after a provider has been
 * polled would put a vendor's response time inside a database transaction. Every
 * write still goes through Phase 2H-1's compare-and-set, which re-reads the row
 * under its own lock and reaches its own conclusion.
 *
 * **No provider client, no HTTP, no object storage.** This module reads four
 * columns and a state.
 */

/**
 * The states an orchestration run may act on.
 *
 * `OUTPUT_VERIFIED` is included so the runner can answer "already done" without
 * a second query — and so it can answer it *before* calling anything external.
 * Every other state is excluded at the query rather than in application code: a
 * `FAILED_*` attempt is finished, `QUEUED` and `SUBMITTING` have no provider job
 * to ask about, and `RECONCILIATION_*` belongs to a different phase's question.
 */
const ORCHESTRATED_STATES = [
  "PROCESSING",
  "PROVIDER_SUCCEEDED",
  "OUTPUT_INGESTING",
  "OUTPUT_VERIFIED",
] as const;

type OrchestratedState = (typeof ORCHESTRATED_STATES)[number];

interface ContextRow {
  attemptId: string;
  orchestrationState: string | null;
  submissionCertainty: string | null;
  providerName: string | null;
  providerModelId: string | null;
  providerPredictionId: string | null;
}

function isOrchestratedState(value: string | null): value is OrchestratedState {
  return value !== null && (ORCHESTRATED_STATES as readonly string[]).includes(value);
}

/**
 * Build the reader over an existing completion repository.
 *
 * Discovery is **delegated**, not reimplemented: `findCompletionCandidates` is
 * Phase 2H-1's, already bounded by the canonical 1..100 validator, already
 * filtered to `ACCEPTED`, and already returning identifiers only. A second query
 * here would be a second place for the certainty filter and the limit rule to
 * drift apart, and the drift would be invisible until the day one of them let
 * something through.
 */
export function createProviderPollingContextReader(
  prisma: PrismaClient,
  completion: CompletionRepository,
): ProviderPollingContextReader {
  return {
    async loadPollingContext({ organizationId, attemptId }) {
      // Tenant-scoped through the ownership chain, the same traversal every
      // Phase 2G/2H read uses. A cross-tenant attempt id matches nothing and is
      // therefore indistinguishable from one that does not exist — the answer
      // cannot be used to probe for another organization's rows.
      const rows = await prisma.$queryRaw<ContextRow[]>`
        SELECT a."id"                        AS "attemptId",
               a."orchestrationState"::text  AS "orchestrationState",
               a."submissionCertainty"::text AS "submissionCertainty",
               a."providerName"              AS "providerName",
               a."providerModelId"           AS "providerModelId",
               a."providerPredictionId"      AS "providerPredictionId"
          FROM "scene_generations" a
          JOIN "scene_generation_requests" r ON r."id" = a."generationSceneRequestId"
          JOIN "generation_scenes" s ON s."id" = r."generationSceneId"
          JOIN "generation_jobs" j ON j."id" = s."generationJobId"
          JOIN "video_projects" p ON p."id" = j."videoProjectId"
         WHERE a."id" = ${attemptId}
           AND p."organizationId" = ${organizationId}
      `;
      const row = rows[0];
      if (row === undefined) return null;

      // A legacy row — admitted before the orchestration linkage existed — has a
      // null `orchestrationState`, and the join above already excludes one with
      // no parent request. Neither is reinterpreted as a Phase 2H attempt: a
      // legacy `state = 'SUCCEEDED'` is a historical fact recorded under a
      // different vocabulary, and calling a provider about it would be acting on
      // a guess.
      if (!isOrchestratedState(row.orchestrationState)) return null;

      // Certainty is a hard filter rather than a field to report. An attempt the
      // provider never accepted, or whose acceptance is unknown, has no provider
      // job to ask about — that is reconciliation's question, not this one.
      if (row.submissionCertainty !== "ACCEPTED") return null;

      // Taken from the row exactly as stored. Not defaulted, not trimmed, not
      // substituted from configuration: the runner refuses a blank rather than
      // letting today's provider answer for yesterday's prediction.
      const context: ProviderPollingContext = {
        organizationId,
        attemptId: row.attemptId,
        orchestrationState: row.orchestrationState,
        submissionCertainty: "ACCEPTED",
        providerName: row.providerName ?? "",
        providerModelId: row.providerModelId ?? "",
        providerPredictionId: row.providerPredictionId ?? "",
      };
      return context;
    },

    async findOrchestrationCandidates({ stage, limit }): Promise<readonly CompletionCandidate[]> {
      return completion.findCompletionCandidates({ stage, limit });
    },
  };
}
