import type { PropertyAssignmentProblem } from "@app/domain";
import { createLogger, type Logger } from "@app/observability";
import { AppError } from "@app/shared";
import { codeOf } from "./page-codes";
import { getPropertyServices } from "./property";

/**
 * What the Property page says after its assignment form is posted, by the
 * code the route sends it back with (`?notice=` or `?error=`, ADR-0144). The
 * page shows only these: never text the address carries, nor a member's or a
 * group's name.
 */
export const ASSIGNMENT_NOTICES = {
  "assignment-saved": "The responsible user and group were saved.",
  "assignment-unchanged": "Nothing changed: that is the Property's assignment already.",
} as const;

export const ASSIGNMENT_ERRORS = {
  "property-gone": "That Property no longer exists.",
  "responsible-user-gone":
    "That person can no longer be made responsible: they left the organization or now handle its billing.",
  "assignment-group-gone": "That group no longer exists.",
  "assignment-changed": "Someone changed this Property's assignment meanwhile. Check it below and try again.",
  "may-not-assign": "Only an Owner or an Admin can change a Property's responsible user and group.",
  "assign-failed": "Something went wrong. Check below whether the assignment was saved.",
} as const;

export type AssignmentNotice = keyof typeof ASSIGNMENT_NOTICES;
export type AssignmentError = keyof typeof ASSIGNMENT_ERRORS;

/** The notice a `?notice=` code names, or `null` for anything else. */
export function assignmentNotice(param: string | readonly string[] | undefined): AssignmentNotice | null {
  return codeOf(ASSIGNMENT_NOTICES, param);
}

/** The error an `?error=` code names, or `null` for anything else. */
export function assignmentError(param: string | readonly string[] | undefined): AssignmentError | null {
  return codeOf(ASSIGNMENT_ERRORS, param);
}

/** What a change of a Property's assignment ended with, for the Property page. */
export type AssignmentOutcome = { readonly notice: AssignmentNotice } | { readonly error: AssignmentError };

/** The Property page with a notice or an error, on the address the request came to. */
export function propertyPage(requestUrl: string, propertyId: string, outcome: AssignmentOutcome): URL {
  const url = new URL(`/properties/${encodeURIComponent(propertyId)}`, requestUrl);
  if ("notice" in outcome) url.searchParams.set("notice", outcome.notice);
  else url.searchParams.set("error", outcome.error);
  return url;
}

let logger: Logger | undefined;

function getAssignmentLogger(): Pick<Logger, "error"> {
  logger ??= createLogger({ base: { component: "property-assignment" } });
  return logger;
}

const errorCode = (error: unknown) => (error instanceof AppError ? error.code : "UNEXPECTED");

const PROBLEM_ANSWERS: Record<PropertyAssignmentProblem, AssignmentError> = {
  RESPONSIBLE_USER: "responsible-user-gone",
  GROUP: "assignment-group-gone",
  STALE: "assignment-changed",
};

/** What an invalid choice's `VALIDATION_FAILED` says, by its reason, or `null` for any other error. */
function problemOf(error: unknown): AssignmentError | null {
  if (!(error instanceof AppError) || error.code !== "VALIDATION_FAILED") return null;
  const reason = error.details?.["reason"];
  return typeof reason === "string" && Object.hasOwn(PROBLEM_ANSWERS, reason)
    ? PROBLEM_ANSWERS[reason as PropertyAssignmentProblem]
    : null;
}

/** The longest id the assignment form or its address may name; one this product makes is 20 characters. */
export const ASSIGNMENT_ID_MAX_LENGTH = 64;

/** A form's id, empty for "None". */
const none = (id: string) => (id === "" ? null : id);

/**
 * Change a Property's responsible user and group, as the Property page's form
 * asks (AT-10a, ADR-0144): each field empty for "None", and the assignment the
 * page showed. The Property service decides (the `OWNER` or `ADMIN` role, the
 * Property, the assignment still the one shown, then each new choice) and
 * audits it. An id longer than any this product makes is refused before the
 * service is asked, so it never reaches the audit log. A failure that is not a
 * refusal is logged by its error code alone.
 */
export async function assignProperty(
  actorUserId: string,
  organizationId: string,
  propertyId: string,
  form: {
    readonly responsibleUserId: string;
    readonly groupId: string;
    readonly shownResponsibleUserId: string;
    readonly shownGroupId: string;
  },
  log: Pick<Logger, "error"> = getAssignmentLogger(),
): Promise<AssignmentOutcome> {
  const tooLong = (id: string) => id.length > ASSIGNMENT_ID_MAX_LENGTH;
  if (tooLong(propertyId)) return { error: "property-gone" };
  if (tooLong(form.responsibleUserId)) return { error: "responsible-user-gone" };
  if (tooLong(form.groupId)) return { error: "assignment-group-gone" };
  try {
    const { changed } = await getPropertyServices().properties.assign(
      actorUserId,
      organizationId,
      propertyId,
      { responsibleUserId: none(form.responsibleUserId), groupId: none(form.groupId) },
      { responsibleUserId: none(form.shownResponsibleUserId), groupId: none(form.shownGroupId) },
    );
    return { notice: changed ? "assignment-saved" : "assignment-unchanged" };
  } catch (error) {
    if (error instanceof AppError && error.code === "FORBIDDEN") return { error: "may-not-assign" };
    if (error instanceof AppError && error.code === "NOT_FOUND") return { error: "property-gone" };
    const problem = problemOf(error);
    if (problem !== null) return { error: problem };
    log.error("A Property's assignment could not be changed", { code: errorCode(error) });
    return { error: "assign-failed" };
  }
}
