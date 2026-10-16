import { redirect } from "next/navigation";
import type { MfaStatus } from "@app/domain";
import { AppError } from "@app/shared";
import { getSignIn, nextPageFor } from "@/lib/auth";
import { getMfaService } from "@/lib/mfa";
import { MfaPanel } from "./mfa-panel";

export const dynamic = "force-dynamic";

/**
 * The signed-in user's own sign-in security: authenticator-app MFA and recovery
 * codes (ADR-0065). Also where a sign-in that must use MFA, and has not set it
 * up, sets it up before anything else (Decision 15).
 */
export default async function SecurityPage() {
  const signIn = await getSignIn();
  if (!signIn) redirect("/login");
  if (signIn.step === "CODE_REQUIRED") redirect(nextPageFor(signIn.step));
  const mustSetUp = signIn.step === "SETUP_REQUIRED";
  const status = await mfaStatus(signIn.user.id);
  return (
    <section>
      <h1>Sign-in security</h1>
      {mustSetUp ? (
        <p>Your role or organization requires two-step sign-in (MFA). Set it up to continue.</p>
      ) : (
        <p>
          <a href="/">Back to organizations</a>
        </p>
      )}
      {status ? (
        <MfaPanel
          enabled={status.enabled}
          required={status.required}
          recoveryCodesLeft={status.recoveryCodesLeft}
          mustSetUp={mustSetUp}
        />
      ) : (
        <p className="status-bad" role="alert">
          MFA is not available right now.
        </p>
      )}
      {mustSetUp ? (
        <form method="post" action="/api/auth/logout">
          <button type="submit">Sign out</button>
        </form>
      ) : null}
    </section>
  );
}

/** Null when MFA is not configured on this server. */
async function mfaStatus(userId: string): Promise<MfaStatus | null> {
  try {
    return await getMfaService().status(userId);
  } catch (error) {
    if (error instanceof AppError && error.code === "CONFIGURATION_ERROR") return null;
    throw error;
  }
}
