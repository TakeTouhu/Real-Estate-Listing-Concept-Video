import type { IdentityServiceDeps } from "../identity/ports";
import type { Session } from "../identity/types";

/**
 * How far a sign-in has got (ADR-0065 Decision 12). `CODE_REQUIRED`: the user
 * has MFA on and this sign-in has not passed it, so it may only enter a code or
 * sign out.
 */
export type MfaSignInStep = "SIGNED_IN" | "CODE_REQUIRED";

export async function mfaSignInStep(
  deps: Pick<IdentityServiceDeps, "repos">,
  session: Pick<Session, "userId" | "mfaVerifiedAt">,
): Promise<MfaSignInStep> {
  if (session.mfaVerifiedAt !== null) return "SIGNED_IN";
  return (await deps.repos.mfa.findFactor(session.userId)) === null ? "SIGNED_IN" : "CODE_REQUIRED";
}
