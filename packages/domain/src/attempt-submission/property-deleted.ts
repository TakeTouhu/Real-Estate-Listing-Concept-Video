/**
 * The ending of a generating job's attempt whose Property was deleted (GS-7d-2,
 * ADR-0100).
 *
 * The paid-submission gate refuses such an attempt for good (ADR-0096), and
 * discovery does not offer it (ADR-0097), so nothing would ever move it: its
 * job would hold its Unit and one of its organization's places for good,
 * against ADR-0052 Decision 19. On 2026-10-29 the product owner decided that a
 * deleted Property's unfinished videos end at once and return their Units.
 *
 * So the attempt ends before submission, `QUEUED → CANCELLED_PRE_SUBMISSION`,
 * as a refused preparation ends one (ADR-0097), with `PROPERTY_DELETED` as its
 * durable code. The attempt failure settlement (Transaction K, ADR-0083) then
 * fails the job and releases its Unit, and Transaction L (ADR-0084) closes its
 * other scenes.
 */

import type { SourceAuthorizationFailure } from "../authorization/types";

/** The code the ended attempt carries: the gate's own reason for refusing it. */
export const PROPERTY_DELETED_ATTEMPT_CODE = "PROPERTY_DELETED" as const satisfies SourceAuthorizationFailure;

/** The event the ending writes on the attempt. Not caller-supplied. */
export const ATTEMPT_ENDED_PROPERTY_DELETED_EVENT_TYPE = "attempt.ended_property_deleted";
