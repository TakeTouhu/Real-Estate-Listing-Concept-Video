import {
  GROUP_NAME_MAX_LENGTH,
  GroupService,
  GroupsOverviewService,
  type GroupNameRefusal,
  type GroupRenameRefusal,
} from "@app/domain";
import { createLogger, type Logger } from "@app/observability";
import { AppError } from "@app/shared";
import { getIdentityServices } from "./identity";
import { codeOf } from "./page-codes";

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
function getGroupService(): GroupService {
  return new GroupService(getIdentityServices().deps);
}

/**
 * What the groups page says after a change, by the code a route sends it back
 * with (`?notice=` or `?error=`). The page shows only these: never text the
 * address carries, nor a group's name.
 */
export const GROUPS_NOTICES = {
  "group-created": "The group was created.",
  "group-renamed": "The group's name was saved.",
  "group-deleted": "The group was deleted.",
} as const;

export const GROUPS_ERRORS = {
  "group-name": `Enter a group name of 1 to ${GROUP_NAME_MAX_LENGTH} characters.`,
  "group-name-taken": "Another group of this organization already has that name.",
  "may-not-create-group": "You cannot create groups in this organization.",
  "create-group-failed": "Something went wrong. Check below whether the group was created.",
  "group-gone": "That group no longer exists.",
  "group-changed": "That group was renamed or deleted meanwhile. Check below and try again.",
  "may-not-rename-group": "You cannot rename groups in this organization.",
  "rename-group-failed": "Something went wrong. Check below whether the group was renamed.",
  "may-not-delete-group": "You cannot delete this group.",
  "delete-group-failed": "Something went wrong. Check below whether the group was deleted.",
} as const;

export type GroupsNotice = keyof typeof GROUPS_NOTICES;
export type GroupsError = keyof typeof GROUPS_ERRORS;

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

const RENAME_REFUSALS: Record<GroupRenameRefusal, GroupsError> = { ...NAME_REFUSALS, STALE: "group-changed" };

/** The refusal in `refusals` a group change's error names, or `null` for one that is not such a refusal. */
function refusalOf<R extends string>(error: unknown, refusals: Record<R, GroupsError>): GroupsError | null {
  if (!(error instanceof AppError) || error.code !== "VALIDATION_FAILED") return null;
  const reason = error.details?.["reason"];
  return typeof reason === "string" && Object.hasOwn(refusals, reason) ? refusals[reason as R] : null;
}

/** Whether an error is the given code's. */
const isCode = (error: unknown, code: string) => error instanceof AppError && error.code === code;

/** The longest group id a groups page's address may name; a group's is 20 characters. */
export const GROUP_ID_MAX_LENGTH = 64;

/**
 * Whether `groupId` could be a group's id. One longer than any is refused
 * before the service is asked, so it never reaches the audit log.
 */
const isGroupId = (groupId: string) => groupId.length > 0 && groupId.length <= GROUP_ID_MAX_LENGTH;

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
    if (isCode(error, "FORBIDDEN")) return { error: "may-not-create-group" };
    const refusal = refusalOf(error, NAME_REFUSALS);
    if (refusal !== null) return { error: refusal };
    log.error("A group could not be created", { code: errorCode(error) });
    return { error: "create-group-failed" };
  }
}

/**
 * Rename a group, as the groups page's form asks (AT-9b, ADR-0142): `name`,
 * and `from`, the name the page showed. The group service decides
 * (`group.manage`, then the name, then the group still of this organization
 * and still named as shown) and audits it. A failure that is not a refusal is
 * logged by its error code alone: never a name.
 */
export async function renameGroup(
  actorUserId: string,
  organizationId: string,
  groupId: string,
  form: { readonly name: string; readonly from: string },
  log: Pick<Logger, "error"> = getGroupsLogger(),
): Promise<GroupsOutcome> {
  if (!isGroupId(groupId)) return { error: "group-gone" };
  try {
    // A form without the name it showed carries an empty one, which no group has: stale, once the
    // permission is asked, so a refusal is still audited.
    await getGroupService().rename(actorUserId, organizationId, groupId, form.name, form.from);
    return { notice: "group-renamed" };
  } catch (error) {
    if (isCode(error, "FORBIDDEN")) return { error: "may-not-rename-group" };
    if (isCode(error, "NOT_FOUND")) return { error: "group-gone" };
    const refusal = refusalOf(error, RENAME_REFUSALS);
    if (refusal !== null) return { error: refusal };
    log.error("A group could not be renamed", { code: errorCode(error) });
    return { error: "rename-group-failed" };
  }
}

/**
 * Delete a group, as the groups page's form asks (AT-9b, ADR-0142). The group
 * service decides (`group.manage` and the `OWNER` or `ADMIN` role, then the
 * ceiling of what the group gave its members), ungroups its Properties and
 * audits it. A failure that is not a refusal is logged by its error code alone.
 */
export async function deleteGroup(
  actorUserId: string,
  organizationId: string,
  groupId: string,
  log: Pick<Logger, "error"> = getGroupsLogger(),
): Promise<GroupsOutcome> {
  if (!isGroupId(groupId)) return { error: "group-gone" };
  try {
    await getGroupService().delete(actorUserId, organizationId, groupId);
    return { notice: "group-deleted" };
  } catch (error) {
    if (isCode(error, "FORBIDDEN")) return { error: "may-not-delete-group" };
    if (isCode(error, "NOT_FOUND")) return { error: "group-gone" };
    log.error("A group could not be deleted", { code: errorCode(error) });
    return { error: "delete-group-failed" };
  }
}
