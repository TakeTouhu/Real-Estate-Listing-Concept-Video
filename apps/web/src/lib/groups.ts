import { GROUP_NAME_MAX_LENGTH, GroupService, GroupsOverviewService, type GroupNameRefusal } from "@app/domain";
import { createLogger, type Logger } from "@app/observability";
import { AppError } from "@app/shared";
import { getIdentityServices } from "./identity";

let overview: GroupsOverviewService | undefined;

/**
 * An organization's groups and their members (ADR-0141). Server-only. It reads
 * the groups, their members and the members' accounts, and writes nothing.
 */
export function getGroupsOverviewService(): GroupsOverviewService {
  overview ??= new GroupsOverviewService(getIdentityServices().deps);
  return overview;
}

/** Groups and their changes (ADR-0060), each audited with what it changed or why it was refused. */
export function getGroupService(): GroupService {
  return new GroupService(getIdentityServices().deps);
}

/**
 * What the groups page says after a change, by the code a route sends it back
 * with (`?notice=` or `?error=`). The page shows only these: never text the
 * address carries, nor a group's name.
 */
export const GROUPS_NOTICES = {
  "group-created": "The group was created.",
} as const;

export const GROUPS_ERRORS = {
  "group-name": `Enter a group name of 1 to ${GROUP_NAME_MAX_LENGTH} characters.`,
  "group-name-taken": "Another group of this organization already has that name.",
  "may-not-create-group": "You cannot create groups in this organization.",
  "create-group-failed": "Something went wrong. Check below whether the group was created.",
} as const;

export type GroupsNotice = keyof typeof GROUPS_NOTICES;
export type GroupsError = keyof typeof GROUPS_ERRORS;

function codeOf<T extends object>(table: T, param: string | readonly string[] | undefined): keyof T | null {
  return typeof param === "string" && Object.hasOwn(table, param) ? (param as keyof T) : null;
}

/** The notice a `?notice=` code names, or `null` for anything else. */
export function groupsNotice(param: string | readonly string[] | undefined): GroupsNotice | null {
  return codeOf(GROUPS_NOTICES, param);
}

/** The error an `?error=` code names, or `null` for anything else. */
export function groupsError(param: string | readonly string[] | undefined): GroupsError | null {
  return codeOf(GROUPS_ERRORS, param);
}

/** What a change of a group ended with, for the groups page. */
export type GroupsOutcome = { readonly notice: GroupsNotice } | { readonly error: GroupsError };

/** The groups page with a notice or an error, on the address the request came to. */
export function groupsPage(requestUrl: string, organizationId: string, outcome: GroupsOutcome): URL {
  const url = new URL(`/organizations/${encodeURIComponent(organizationId)}/groups`, requestUrl);
  if ("notice" in outcome) url.searchParams.set("notice", outcome.notice);
  else url.searchParams.set("error", outcome.error);
  return url;
}

let logger: Logger | undefined;

function getGroupsLogger(): Pick<Logger, "error"> {
  logger ??= createLogger({ base: { component: "groups" } });
  return logger;
}

const errorCode = (error: unknown) => (error instanceof AppError ? error.code : "UNEXPECTED");

const NAME_REFUSALS: Record<GroupNameRefusal, GroupsError> = {
  INVALID_NAME: "group-name",
  NAME_TAKEN: "group-name-taken",
};

/** The refusal of a name a group change's error names, or `null` for one that is not such a refusal. */
function nameRefusalOf(error: AppError): GroupsError | null {
  const reason = error.details?.["reason"];
  return error.code === "VALIDATION_FAILED" && typeof reason === "string" && Object.hasOwn(NAME_REFUSALS, reason)
    ? NAME_REFUSALS[reason as GroupNameRefusal]
    : null;
}

/**
 * Create a group named `name`, as the groups page's form asks (ADR-0141). The
 * group service decides (`group.manage`, then the name: trimmed, 1 to 100
 * characters, unique within the organization) and audits it. A failure that is
 * not a refusal is logged by its error code alone: never the name.
 */
export async function createGroup(
  actorUserId: string,
  organizationId: string,
  form: { readonly name: string },
  log: Pick<Logger, "error"> = getGroupsLogger(),
): Promise<GroupsOutcome> {
  try {
    await getGroupService().create(actorUserId, organizationId, form.name);
    return { notice: "group-created" };
  } catch (error) {
    if (error instanceof AppError && error.code === "FORBIDDEN") return { error: "may-not-create-group" };
    const refusal = error instanceof AppError ? nameRefusalOf(error) : null;
    if (refusal !== null) return { error: refusal };
    log.error("A group could not be created", { code: errorCode(error) });
    return { error: "create-group-failed" };
  }
}
