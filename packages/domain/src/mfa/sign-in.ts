import type { IdentityServiceDeps } from "../identity/ports";
import type { Session, User } from "../identity/types";
import { isMfaRequired } from "./requirement";

/**
 * How far a sign-in has got (ADR-0065 Decisions 12 and 15). `CODE_REQUIRED`:
 * the user has MFA on and this sign-in has not passed it. `SETUP_REQUIRED`: the
 * user must use MFA and has not set it up. Either may only finish that step or
 * sign out.
 */
export type MfaSignInStep = "SIGNED_IN" | "CODE_REQUIRED" | "SETUP_REQUIRED";

export async function mfaSignInStep(
  deps: Pick<IdentityServiceDeps, "repos">,
  session: Pick<Session, "userId" | "mfaVerifiedAt">,
): Promise<MfaSignInStep> {
  if ((await deps.repos.mfa.findFactor(session.userId)) !== null) {
    return session.mfaVerifiedAt === null ? "CODE_REQUIRED" : "SIGNED_IN";
  }
  // Read from current memberships, so a grant applies from the next request.
  return (await isMfaRequired(deps, session.userId)) ? "SETUP_REQUIRED" : "SIGNED_IN";
}

/**
 * How far a sign-in has got, email verification included (ADR-0129): an MFA
 * code first, since a sign-in that owes one has proven only the password; then
 * the account's email address (ADR-0052 Decision 18, ADR-0128); then MFA
 * set-up. `EMAIL_VERIFICATION_REQUIRED` may only verify the address, ask for
 * the link again or sign out.
 */
export type SignInStep = MfaSignInStep | "EMAIL_VERIFICATION_REQUIRED";

export async function signInStep(
  deps: Pick<IdentityServiceDeps, "repos">,
  user: Pick<User, "emailVerifiedAt">,
  session: Pick<Session, "userId" | "mfaVerifiedAt">,
): Promise<SignInStep> {
  const mfa = await mfaSignInStep(deps, session);
  if (mfa === "CODE_REQUIRED" || user.emailVerifiedAt !== null) return mfa;
  return "EMAIL_VERIFICATION_REQUIRED";
}
