import { redirect } from "next/navigation";
import type { MfaStatus } from "@app/domain";
import { AppError } from "@app/shared";
import { getCurrentUser } from "@/lib/auth";
import { getMfaService } from "@/lib/mfa";
import { MfaPanel } from "./mfa-panel";

export const dynamic = "force-dynamic";

/** The signed-in user's own sign-in security: authenticator-app MFA and recovery codes (ADR-0065). */
export default async function SecurityPage() {
  const current = await getCurrentUser();
  if (!current) redirect("/login");
  const status = await mfaStatus(current.user.id);
  return (
    <section>
      <h1>Sign-in security</h1>
      <p>
        <a href="/">Back to organizations</a>
      </p>
      {status ? (
        <MfaPanel
          enabled={status.enabled}
          required={status.required}
          recoveryCodesLeft={status.recoveryCodesLeft}
        />
      ) : (
        <p className="status-bad" role="alert">
          MFA is not available right now.
        </p>
      )}
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
