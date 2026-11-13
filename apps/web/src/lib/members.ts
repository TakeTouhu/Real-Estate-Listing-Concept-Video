import {
  INVITATION_TTL_SECONDS,
  MembersOverviewService,
  MembershipService,
  includedSeatsFrom,
  isRole,
  linkLifetime,
  type InvitationRefusal,
  type MembershipChangeRefusal,
  type Role,
} from "@app/domain";
import { createSubscriptionRepository, getPrismaClient } from "@app/database";
import { createLogger, type Logger } from "@app/observability";
import { AppError } from "@app/shared";
import { getIdentityServices } from "./identity";
import { getMailer } from "./mailer";

let overview: MembersOverviewService | undefined;

/**
 * Who belongs to an organization, who is invited, and its seats (ADR-0134).
 * Server-only. It reads the members, their accounts, the invitations and the
 * subscription, and writes nothing.
 */
export function getMembersOverviewService(): MembersOverviewService {
  if (overview) return overview;
  overview = new MembersOverviewService({
    identity: getIdentityServices().deps,
    subscriptions: createSubscriptionRepository(getPrismaClient()),
  });
  return overview;
}

/** Each role as the members and groups pages name it. */
export const ROLE_NAMES: Record<Role, string> = {
  OWNER: "Owner",
  ADMIN: "Admin",
  MANAGER: "Manager",
  CREATOR: "Creator",
  VIEWER: "Viewer",
  BILLING: "Billing",
};

/** The page an invitation's link opens, with its token (ADR-0138). */
export const ACCEPT_INVITATION_PATH = "/accept-invitation";

/** How long an invitation's link works, worded as its email words it. */
export const INVITATION_LIFETIME = linkLifetime(INVITATION_TTL_SECONDS);

const errorCode = (error: unknown) => (error instanceof AppError ? error.code : "UNEXPECTED");

/**
 * The invitation was kept, and then its email could not be sent: whatever the
 * mailer threw, so the page never says nothing was saved. Only the code goes on.
 */
class InvitationNotMailed extends Error {
  constructor(readonly code: string) {
    super("The invitation was kept, but its email could not be sent");
  }
}

/**
 * Inviting and cancelling in the web app (ADR-0135, ADR-0136): the seats come
 * from the organization's plan, and the invitation is mailed through
 * `getMailer`, its link on `APP_BASE_URL`. With no outbox or no base address,
 * inviting fails with `CONFIGURATION_ERROR` before anything is written; a send
 * that fails once the invitation is kept fails as {@link InvitationNotMailed}.
 */
export function getMembershipService(): MembershipService {
  const mailer = getMailer();
  return new MembershipService(getIdentityServices().deps, {
    invitationTtlSeconds: INVITATION_TTL_SECONDS,
    includedSeats: includedSeatsFrom(createSubscriptionRepository(getPrismaClient())),
    email: {
      send: async (message) => {
        try {
          await mailer.send(message);
        } catch (error) {
          throw new InvitationNotMailed(errorCode(error));
        }
      },
    },
    invitationUrl: (token) => mailer.link(ACCEPT_INVITATION_PATH, token),
  });
}

/**
 * What the members page says after inviting, cancelling, changing a role or
 * removing a member, by the code a route sends it back with (`?notice=` or
 * `?error=`). The page shows only these: never text the address carries, nor
 * the invited address.
 */
export const MEMBERS_NOTICES = {
  invited: `The invitation was sent. Its link works for ${INVITATION_LIFETIME}.`,
  cancelled: "The invitation was cancelled. Its link no longer works, and its seat is free.",
  "role-changed":
    "The member's role was changed. What they can do, and which Properties they reach, follow the new role now.",
  "member-removed":
    "The member was removed. They can no longer open this organization, and Properties they were responsible " +
    "for have no responsible user now.",
} as const;

export const MEMBERS_ERRORS = {
  email: "Enter an email address an invitation can be sent to.",
  role: "Choose the role to invite with.",
  "no-plan": "This organization has no plan yet, so it cannot invite anyone.",
  "already-invited": "That email address already has a pending invitation. Cancel it to invite the address again.",
  "already-member": "That email address belongs to a member of this organization already.",
  "no-seat":
    "Every seat is taken by a member or a pending invitation. Inviting never adds a seat: a member who manages " +
    "billing must buy one, or an invitation can be cancelled.",
  "may-not-invite": "You cannot invite someone to this organization with that role.",
  "may-not-cancel": "You cannot cancel this invitation.",
  gone: "That invitation is no longer pending: it was accepted, cancelled, or it expired.",
  unavailable: "Invitations cannot be sent right now. Nothing was saved.",
  "invite-failed":
    "Something went wrong. If the invitation is listed below, its email may not have been sent: cancel it and " +
    "invite again.",
  "cancel-failed": "Something went wrong. Check below whether the invitation is still pending.",
  "new-role": "Choose the member's new role.",
  "may-not-change-role": "You cannot give that member that role.",
  "not-a-member": "That person is not a member of this organization.",
  "last-owner": "The organization must keep an Owner. Make another member an Owner first.",
  "member-changed": "That member's role changed meanwhile. Check it below, and change it again if you still need to.",
  "role-change-failed": "Something went wrong. Check below whether the member's role changed.",
  "may-not-remove": "You cannot remove that member.",
  "removal-member-changed":
    "That member's role changed, or they were removed, meanwhile. Check below, and remove them again if you still " +
    "need to.",
  "removal-failed": "Something went wrong. Check below whether that person is still a member.",
} as const;

export type MembersNotice = keyof typeof MEMBERS_NOTICES;
export type MembersError = keyof typeof MEMBERS_ERRORS;

function codeOf<T extends object>(table: T, param: string | readonly string[] | undefined): keyof T | null {
  return typeof param === "string" && Object.hasOwn(table, param) ? (param as keyof T) : null;
}

/** The notice a `?notice=` code names, or `null` for anything else. */
export function membersNotice(param: string | readonly string[] | undefined): MembersNotice | null {
  return codeOf(MEMBERS_NOTICES, param);
}

/** The error an `?error=` code names, or `null` for anything else. */
export function membersError(param: string | readonly string[] | undefined): MembersError | null {
  return codeOf(MEMBERS_ERRORS, param);
}

/** What inviting, cancelling, changing a role or removing a member ended with, for the members page. */
export type MembersOutcome = { readonly notice: MembersNotice } | { readonly error: MembersError };

/** The members page with a notice or an error, on the address the request came to. */
export function membersPage(requestUrl: string, organizationId: string, outcome: MembersOutcome): URL {
  const url = new URL(`/organizations/${encodeURIComponent(organizationId)}/members`, requestUrl);
  if ("notice" in outcome) url.searchParams.set("notice", outcome.notice);
  else url.searchParams.set("error", outcome.error);
  return url;
}

let logger: Logger | undefined;

function getMembersLogger(): Pick<Logger, "error"> {
  logger ??= createLogger({ base: { component: "members" } });
  return logger;
}

const REFUSALS: Record<InvitationRefusal, MembersError> = {
  INVALID_EMAIL: "email",
  NO_PLAN: "no-plan",
  ALREADY_INVITED: "already-invited",
  ALREADY_MEMBER: "already-member",
  NO_SEAT: "no-seat",
};

/** The refusal an inviting error names, or `null` for one that is not a refusal. */
function refusalOf(error: AppError): MembersError | null {
  if (error.code === "FORBIDDEN") return "may-not-invite";
  if (error.code === "CONFIGURATION_ERROR") return "unavailable";
  const reason = error.details?.["reason"];
  return error.code === "VALIDATION_FAILED" && typeof reason === "string" && Object.hasOwn(REFUSALS, reason)
    ? REFUSALS[reason as InvitationRefusal]
    : null;
}

/**
 * Invite `email` with `role`, as the members page's form asks (ADR-0136). The
 * membership service decides and mails the link; its token is the invitee's
 * and goes no further. A failure that is not a refusal is logged by its error
 * code alone: never the address.
 */
export async function inviteMember(
  actorUserId: string,
  organizationId: string,
  form: { readonly email: string; readonly role: string },
  log: Pick<Logger, "error"> = getMembersLogger(),
): Promise<MembersOutcome> {
  const { email, role } = form;
  if (!isRole(role)) return { error: "role" };
  try {
    await getMembershipService().invite(actorUserId, { organizationId, email, role });
    return { notice: "invited" };
  } catch (error) {
    if (error instanceof InvitationNotMailed) {
      log.error("An invitation was kept, but its email could not be sent", { code: error.code });
      return { error: "invite-failed" };
    }
    const refusal = error instanceof AppError ? refusalOf(error) : null;
    if (refusal !== null) return { error: refusal };
    log.error("An invitation could not be sent", { code: errorCode(error) });
    return { error: "invite-failed" };
  }
}

/**
 * Cancel a pending invitation, as the members page's button asks (ADR-0136).
 * A failure that is not a refusal is logged by its error code alone.
 */
export async function cancelMemberInvitation(
  actorUserId: string,
  organizationId: string,
  invitationId: string,
  log: Pick<Logger, "error"> = getMembersLogger(),
): Promise<MembersOutcome> {
  try {
    await getMembershipService().cancelInvitation(actorUserId, organizationId, invitationId);
    return { notice: "cancelled" };
  } catch (error) {
    if (error instanceof AppError && error.code === "FORBIDDEN") return { error: "may-not-cancel" };
    if (error instanceof AppError && error.code === "NOT_FOUND") return { error: "gone" };
    log.error("An invitation could not be cancelled", { code: errorCode(error) });
    return { error: "cancel-failed" };
  }
}

/** What a role change, or a removal, answers each of its refusals with. */
interface MembershipChangeAnswers {
  /** The poster may not make this change. */
  readonly forbidden: MembersError;
  /** The change wrote nothing, by `details.reason`. */
  readonly refusals: Record<MembershipChangeRefusal, MembersError>;
}

const ROLE_CHANGE_ANSWERS: MembershipChangeAnswers = {
  forbidden: "may-not-change-role",
  refusals: { LAST_OWNER: "last-owner", STALE: "member-changed" },
};

const REMOVAL_ANSWERS: MembershipChangeAnswers = {
  forbidden: "may-not-remove",
  refusals: { LAST_OWNER: "last-owner", STALE: "removal-member-changed" },
};

/** The refusal a role change's or a removal's error names, or `null` for one that is not a refusal. */
function membershipChangeRefusalOf(error: AppError, answers: MembershipChangeAnswers): MembersError | null {
  if (error.code === "FORBIDDEN") return answers.forbidden;
  if (error.code === "NOT_FOUND") return "not-a-member";
  const reason = error.details?.["reason"];
  if (error.code !== "VALIDATION_FAILED" || typeof reason !== "string") return null;
  return Object.hasOwn(answers.refusals, reason) ? answers.refusals[reason as MembershipChangeRefusal] : null;
}

/** The longest account id a members page's address may name; an account's is 20 characters. */
export const MEMBER_ID_MAX_LENGTH = 64;

/**
 * Give a member another role, as the members page's form asks (ADR-0139):
 * `role`, and `from`, the role the page showed. The membership service
 * decides (`permission.manage`, the ceiling of the role held and of the new
 * one, the role still the one shown, the last `OWNER`) and audits it. An id
 * longer than any account's is refused before the service is asked, so it
 * never reaches the audit log. A failure that is not a refusal is logged by
 * its error code alone.
 */
export async function changeMemberRole(
  actorUserId: string,
  organizationId: string,
  memberUserId: string,
  form: { readonly role: string; readonly from: string },
  log: Pick<Logger, "error"> = getMembersLogger(),
): Promise<MembersOutcome> {
  const { role, from } = form;
  if (memberUserId.length === 0 || memberUserId.length > MEMBER_ID_MAX_LENGTH) return { error: "not-a-member" };
  if (!isRole(role)) return { error: "new-role" };
  // A form without the role it showed cannot say the member still holds it.
  if (!isRole(from)) return { error: "member-changed" };
  try {
    await getMembershipService().changeRole(actorUserId, organizationId, memberUserId, role, from);
    return { notice: "role-changed" };
  } catch (error) {
    const refusal = error instanceof AppError ? membershipChangeRefusalOf(error, ROLE_CHANGE_ANSWERS) : null;
    if (refusal !== null) return { error: refusal };
    log.error("A member's role could not be changed", { code: errorCode(error) });
    return { error: "role-change-failed" };
  }
}

/**
 * Remove a member from the organization, as the members page's form asks
 * (ADR-0140): `from`, the role the page showed. The membership service
 * decides (`member.manage`, the ceiling of the role held, the role still the
 * one shown, the last `OWNER`) and audits it. An id longer than any account's
 * is refused before the service is asked, so it never reaches the audit log.
 * A failure that is not a refusal is logged by its error code alone.
 */
export async function removeOrganizationMember(
  actorUserId: string,
  organizationId: string,
  memberUserId: string,
  form: { readonly from: string },
  log: Pick<Logger, "error"> = getMembersLogger(),
): Promise<MembersOutcome> {
  if (memberUserId.length === 0 || memberUserId.length > MEMBER_ID_MAX_LENGTH) return { error: "not-a-member" };
  // A form without the role it showed cannot say the member still holds it.
  if (!isRole(form.from)) return { error: "removal-member-changed" };
  try {
    await getMembershipService().removeMember(actorUserId, organizationId, memberUserId, form.from);
    return { notice: "member-removed" };
  } catch (error) {
    const refusal = error instanceof AppError ? membershipChangeRefusalOf(error, REMOVAL_ANSWERS) : null;
    if (refusal !== null) return { error: refusal };
    log.error("A member could not be removed", { code: errorCode(error) });
    return { error: "removal-failed" };
  }
}
