import { cookies } from "next/headers";
import { ACCOUNT_LINK_TOKEN_MAX_LENGTH, type AcceptanceRefusal, type InvitationOffer } from "@app/domain";
import { createLogger, type Logger } from "@app/observability";
import { AppError } from "@app/shared";
import { getServerEnv } from "./env";
import { getMembershipService } from "./members";

/**
 * The cookie an invitation waits in while its person signs in, creates an
 * account, verifies their address or finishes MFA (ADR-0138). It holds the
 * link's token, which only the link's holder has, and no page script reads
 * it.
 */
export const INVITATION_COOKIE = "rev_invitation";

/** How long an invitation waits in the browser: as long as a verification link works (ADR-0128). */
export const INVITATION_WAIT_SECONDS = 24 * 60 * 60;

export interface InvitationCookieOptions {
  readonly httpOnly: true;
  readonly sameSite: "lax";
  readonly secure: boolean;
  readonly path: "/";
  readonly maxAge: number;
}

export function invitationCookieOptions(): InvitationCookieOptions {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: getServerEnv().NODE_ENV === "production",
    path: "/",
    maxAge: INVITATION_WAIT_SECONDS,
  };
}

/** Whether `value` could be an invitation's token: any longer is refused unread, as a link's token is. */
export function isInvitationToken(value: string): boolean {
  return value.length > 0 && value.length <= ACCOUNT_LINK_TOKEN_MAX_LENGTH;
}

/** The token of the invitation waiting in this browser, or `null`. */
export async function waitingInvitationToken(): Promise<string | null> {
  const token = (await cookies()).get(INVITATION_COOKIE)?.value;
  return token !== undefined && isInvitationToken(token) ? token : null;
}

/**
 * What the invitation page says when accepting ended in a refusal, by the code
 * the accept route sends it back with (`?error=`). The page shows only these:
 * never the invited address, nor text the address carries.
 */
export const ACCEPT_ERRORS = {
  invalid:
    "This invitation link does not work. It may have expired, been cancelled or been used already. Ask whoever " +
    "invited you for a new invitation.",
  expired: "This invitation has expired. Ask whoever invited you to invite you again.",
  "wrong-account":
    "This invitation was sent to another email address. Sign out, then sign in or create an account with the " +
    "address it was sent to.",
  unverified: "Verify your email address before accepting this invitation.",
  "already-member": "You are a member of this organization already.",
  withdrawn:
    "This invitation can no longer be accepted: whoever sent it can no longer invite with its role. Ask for a new " +
    "invitation.",
  "no-plan":
    "This organization has no plan yet, so it has no seat for you. Open the link in your invitation email again " +
    "once it has one.",
  "no-seat":
    "Every seat of this organization is taken by a member. Open the link in your invitation email again once a " +
    "seat is free.",
  failed: "Something went wrong, and you have not joined. Try again.",
} as const;

export type AcceptError = keyof typeof ACCEPT_ERRORS;

/** The error an `?error=` code names, or `null` for anything else. */
export function acceptError(param: string | readonly string[] | undefined): AcceptError | null {
  return typeof param === "string" && Object.hasOwn(ACCEPT_ERRORS, param) ? (param as AcceptError) : null;
}

/**
 * Whether the invitation keeps waiting in the browser after `error`: only
 * while this browser can still accept it, by signing in with the invited
 * address, verifying it, or trying again.
 */
export function keepsInvitationWaiting(error: AcceptError): boolean {
  return error === "wrong-account" || error === "unverified" || error === "failed";
}

/** The invitation page, with the code of a refusal, on the address the request came to. */
export function acceptInvitationPage(requestUrl: string, error?: AcceptError): URL {
  const url = new URL("/accept-invitation", requestUrl);
  if (error !== undefined) url.searchParams.set("error", error);
  return url;
}

/** The organizations page, saying which organization was joined. */
export function joinedPage(requestUrl: string, organizationId: string): URL {
  const url = new URL("/", requestUrl);
  url.searchParams.set("joined", organizationId);
  return url;
}

let logger: Logger | undefined;

function getInvitationsLogger(): Pick<Logger, "error"> {
  logger ??= createLogger({ base: { component: "invitations" } });
  return logger;
}

const errorCode = (error: unknown) => (error instanceof AppError ? error.code : "UNEXPECTED");

/**
 * What the invitation of `token` offers (ADR-0138): `invalid` for a token of
 * no open invitation. A failure to read it is logged by its error code alone:
 * never the token.
 */
export async function openInvitation(
  token: string,
  log: Pick<Logger, "error"> = getInvitationsLogger(),
): Promise<{ readonly state: "open"; readonly offer: InvitationOffer } | { readonly state: "invalid" | "failed" }> {
  try {
    const offer = await getMembershipService().describeInvitation(token);
    return offer === null ? { state: "invalid" } : { state: "open", offer };
  } catch (error) {
    log.error("An invitation could not be read", { code: errorCode(error) });
    return { state: "failed" };
  }
}

/** What the invitation waiting in this browser offers, while it is open; otherwise `null`. */
export async function waitingInvitation(): Promise<InvitationOffer | null> {
  const token = await waitingInvitationToken();
  if (token === null) return null;
  const opened = await openInvitation(token);
  return opened.state === "open" ? opened.offer : null;
}

const REFUSALS: Record<AcceptanceRefusal, AcceptError> = {
  EXPIRED: "expired",
  EMAIL_NOT_VERIFIED: "unverified",
  WRONG_ACCOUNT: "wrong-account",
  ALREADY_MEMBER: "already-member",
  NO_PLAN: "no-plan",
  NO_SEAT: "no-seat",
};

/** The refusal an accepting error names, or `null` for one that is not a refusal. */
function refusalOf(error: AppError): AcceptError | null {
  if (error.code === "NOT_FOUND") return "invalid";
  if (error.code === "FORBIDDEN") return "withdrawn";
  const reason = error.details?.["reason"];
  return error.code === "VALIDATION_FAILED" && typeof reason === "string" && Object.hasOwn(REFUSALS, reason)
    ? REFUSALS[reason as AcceptanceRefusal]
    : null;
}

/**
 * Accept the invitation of `token` as `userId` (ADR-0137, ADR-0138): the
 * organization joined, or why not. A failure that is not a refusal is logged
 * by its error code alone: never the token.
 */
export async function acceptInvitationAs(
  userId: string,
  token: string,
  log: Pick<Logger, "error"> = getInvitationsLogger(),
): Promise<{ readonly joined: string } | { readonly error: AcceptError }> {
  try {
    const membership = await getMembershipService().acceptInvitation(userId, token);
    return { joined: membership.organizationId };
  } catch (error) {
    const refusal = error instanceof AppError ? refusalOf(error) : null;
    if (refusal !== null) return { error: refusal };
    log.error("An invitation could not be accepted", { code: errorCode(error) });
    return { error: "failed" };
  }
}
