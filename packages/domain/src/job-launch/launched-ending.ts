/**
 * Ending a deleted Property's launched job before its video is assembled
 * (GS-7d-3a, ADR-0102).
 *
 * A launched job holds its Unit until its video is published, and the one step
 * that consumes it, Transaction G, reads no Property. So a job whose Property
 * was deleted after every one of its scenes was sent would still be assembled
 * and delivered, its Unit consumed. The product owner decided on 2026-10-29
 * ("すぐ戻す") that a deleted Property's unfinished videos end at once and
 * their Units come back. ADR-0099 ends a waiting one and ADR-0100 a generating
 * one's attempt still waiting to be sent; this ends one launched and not yet
 * being assembled: `GENERATING`, `SCENES_READY` or `COMPOSITION_PENDING`.
 *
 * The job fails and its Unit is released, in one commit. Its scenes are left to
 * Transaction L (ADR-0084), as Transaction K leaves a failed job's other scenes:
 * a scene at the provider still finishes there and its video is never
 * delivered, because delivery requires the job `GENERATING`. That call's cost is
 * VTaVision's, never the customer's (ADR-0083 Decision 1).
 *
 * The decision is made from the rows the ending locked, never from what the
 * caller believed. Pure: the persistence layer reads, this decides, the
 * persistence layer writes what it answers.
 */

import { deepFreeze } from "@app/shared";
import type { GenerationJobState } from "../orchestration/types";

/** The states a launched job is ended from: launched, and not yet being assembled. */
export const JOB_STATES_BEFORE_ASSEMBLY = deepFreeze([
  "GENERATING",
  "SCENES_READY",
  "COMPOSITION_PENDING",
] as const satisfies readonly GenerationJobState[]);

export type JobStateBeforeAssembly = (typeof JOB_STATES_BEFORE_ASSEMBLY)[number];

/** The rows the ending reads, under the locks it took. */
export interface LaunchedJobLockedRows {
  /** `null` when there is no such job in the organization. */
  readonly jobState: string | null;
  /** Whether the job's delivered-video pointer names a version. */
  readonly jobHoldsDeliverable: boolean;
  /** `null` when the job has no reservation. */
  readonly reservationState: string | null;
  readonly propertyDeleted: boolean;
}

/** Why a launched job is not ended. Nothing was written. */
export type LaunchedJobEndingRefusal =
  /**
   * The job is not launched and before assembly: it waits (ADR-0099's), is
   * being assembled or checked (Transaction G's), was delivered or ended,
   * belongs to another organization, or does not exist.
   */
  | "NOT_BEFORE_ASSEMBLY"
  /**
   * It holds a delivered video: a regeneration, which holds no Unit and rolls
   * back to that video on failure (ADR-0083 Decision 3).
   */
  | "HOLDS_DELIVERABLE"
  /**
   * Its reservation is not `RESERVED`. A hold on reconciliation is the platform
   * not knowing what a provider did, and one consumed or released has nothing
   * left to return.
   */
  | "RESERVATION_NOT_HELD"
  /** Its Property stands. */
  | "PROPERTY_STANDS";

export type LaunchedJobEnding =
  | { readonly kind: "END"; readonly from: JobStateBeforeAssembly }
  | { readonly kind: "KEEP"; readonly reason: LaunchedJobEndingRefusal };

const keep = (reason: LaunchedJobEndingRefusal): LaunchedJobEnding => ({ kind: "KEEP", reason });

/**
 * Decide whether a launched job ends, from the rows the ending locked.
 *
 * The job's state and its deliverable come first, so a job being assembled or
 * a regeneration is never ended here whatever else is true of it; then the
 * hold, so only a `RESERVED` one is ever released.
 */
export function decideLaunchedJobEnding(locked: LaunchedJobLockedRows): LaunchedJobEnding {
  const from = JOB_STATES_BEFORE_ASSEMBLY.find((state) => state === locked.jobState);
  if (from === undefined) return keep("NOT_BEFORE_ASSEMBLY");
  if (locked.jobHoldsDeliverable) return keep("HOLDS_DELIVERABLE");
  if (locked.reservationState !== "RESERVED") return keep("RESERVATION_NOT_HELD");
  if (!locked.propertyDeleted) return keep("PROPERTY_STANDS");
  return { kind: "END", from };
}

/** Fixed application-owned event type: the job's move to `FAILED_TERMINAL`. */
export const JOB_ENDED_PROPERTY_DELETED_EVENT_TYPE = "job.ended_property_deleted";
