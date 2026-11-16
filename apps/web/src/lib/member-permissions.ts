import {
  MemberPermissionsService,
  PermissionGrantService,
  isPermission,
  type MemberPermission,
} from "@app/domain";
import { createLogger, type Logger } from "@app/observability";
import { AppError } from "@app/shared";
import { getIdentityServices } from "./identity";
import { MEMBER_ID_MAX_LENGTH, membersPage } from "./members";
import { codeOf } from "./page-codes";
import { NOT_GIVEN_HERE } from "./permission-names";

let service: MemberPermissionsService | undefined;

/**
 * What a member may do, and why (ADR-0146). Server-only. It reads the member,
 * their account, their individual grants, their groups and those groups'
 * permissions, and writes nothing.
 */
export function getMemberPermissionsService(): MemberPermissionsService {
  service ??= new MemberPermissionsService(getIdentityServices().deps);
  return service;
}

/**
 * Whether the page offers to give `row`'s permission: the viewer may give it,
 * the member cannot do it now, and it is given here (ADR-0147).
 */
export function offersToGive(row: MemberPermission): boolean {
  return row.mayGrant && !row.effective && !NOT_GIVEN_HERE.includes(row.permission);
}

/**
 * What a member's permissions page says after giving or taking back a
 * permission, by the code a route sends it back with. The page shows only
 * these.
 */
export const MEMBER_PERMISSIONS_NOTICES = {
  granted: "The permission was given to them individually. What they can do now is shown below.",
  revoked: "Their individual permission was taken back. What they can do now is shown below.",
} as const;

export const MEMBER_PERMISSIONS_ERRORS = {
  permission: "That permission cannot be given or taken back here.",
  "may-not-grant": "You cannot give that member that permission.",
  "may-not-revoke": "You cannot take that permission back from that member.",
  "not-granted": "They no longer hold that permission individually: it was taken back meanwhile.",
  "grant-failed": "Something went wrong. Check below whether they have that permission.",
  "revoke-failed": "Something went wrong. Check below whether they still hold that permission individually.",
} as const;

export type MemberPermissionsNotice = keyof typeof MEMBER_PERMISSIONS_NOTICES;
export type MemberPermissionsError = keyof typeof MEMBER_PERMISSIONS_ERRORS;

/** The notice a `?notice=` code names, or `null` for anything else. */
export function memberPermissionsNotice(param: string | readonly string[] | undefined): MemberPermissionsNotice | null {
  return codeOf(MEMBER_PERMISSIONS_NOTICES, param);
}

/** The error an `?error=` code names, or `null` for anything else. */
export function memberPermissionsError(param: string | readonly string[] | undefined): MemberPermissionsError | null {
  return codeOf(MEMBER_PERMISSIONS_ERRORS, param);
}

/**
 * What giving or taking back a permission ended with: a code for the member's
 * permissions page, or `gone` when there is no such member to show.
 */
export type MemberPermissionsOutcome =
  | { readonly notice: MemberPermissionsNotice }
  | { readonly error: MemberPermissionsError }
  | { readonly gone: true };

/**
 * The member's permissions page with a notice or an error, on the address the
 * request came to; for a member who is gone, the members page saying so.
 */
export function memberPermissionsPage(
  requestUrl: string,
  organizationId: string,
  memberUserId: string,
  outcome: MemberPermissionsOutcome,
): URL {
  if ("gone" in outcome) return membersPage(requestUrl, organizationId, { error: "not-a-member" });
  const url = new URL(
    `/organizations/${encodeURIComponent(organizationId)}/members/${encodeURIComponent(memberUserId)}/permissions`,
    requestUrl,
  );
  if ("notice" in outcome) url.searchParams.set("notice", outcome.notice);
  else url.searchParams.set("error", outcome.error);
  return url;
}

let logger: Logger | undefined;

function getMemberPermissionsLogger(): Pick<Logger, "error"> {
  logger ??= createLogger({ base: { component: "member-permissions" } });
  return logger;
}

const errorCode = (error: unknown) => (error instanceof AppError ? error.code : "UNEXPECTED");

/** Grants and their revocation (ADR-0058), asked only by the two functions below. */
function getPermissionGrantService(): PermissionGrantService {
  return new PermissionGrantService(getIdentityServices().deps);
}

const isMemberId = (userId: string) => userId.length > 0 && userId.length <= MEMBER_ID_MAX_LENGTH;

/**
 * Give a member `permission` individually, as their permissions page asks
 * (ADR-0147). The grant service decides (`permission.manage`, the grant
 * ceiling) and audits it, refusals included. An id longer than any account's,
 * a permission that is not one, and one not given here are refused before
 * the service is asked, so they never reach the audit log. A failure that is
 * not a refusal is logged by its error code alone.
 */
export async function grantMemberPermission(
  actorUserId: string,
  organizationId: string,
  memberUserId: string,
  permission: string,
  log: Pick<Logger, "error"> = getMemberPermissionsLogger(),
): Promise<MemberPermissionsOutcome> {
  if (!isMemberId(memberUserId)) return { gone: true };
  if (!isPermission(permission) || NOT_GIVEN_HERE.includes(permission)) return { error: "permission" };
  try {
    await getPermissionGrantService().grant(actorUserId, organizationId, memberUserId, permission);
    return { notice: "granted" };
  } catch (error) {
    if (error instanceof AppError && error.code === "FORBIDDEN") return { error: "may-not-grant" };
    if (error instanceof AppError && error.code === "NOT_FOUND") return { gone: true };
    log.error("A permission could not be given", { code: errorCode(error) });
    return { error: "grant-failed" };
  }
}

/**
 * Take back a member's individual grant of `permission`, as their permissions
 * page asks (ADR-0147). The grant service decides and audits it, as for
 * giving. A grant no longer held, or a member no longer there, is `NOT_FOUND`
 * either way: the page then shows which. A failure that is not a refusal is
 * logged by its error code alone.
 */
export async function revokeMemberPermission(
  actorUserId: string,
  organizationId: string,
  memberUserId: string,
  permission: string,
  log: Pick<Logger, "error"> = getMemberPermissionsLogger(),
): Promise<MemberPermissionsOutcome> {
  if (!isMemberId(memberUserId)) return { gone: true };
  if (!isPermission(permission)) return { error: "permission" };
  try {
    await getPermissionGrantService().revoke(actorUserId, organizationId, memberUserId, permission);
    return { notice: "revoked" };
  } catch (error) {
    if (error instanceof AppError && error.code === "FORBIDDEN") return { error: "may-not-revoke" };
    if (error instanceof AppError && error.code === "NOT_FOUND") return { error: "not-granted" };
    log.error("A permission could not be taken back", { code: errorCode(error) });
    return { error: "revoke-failed" };
  }
}
