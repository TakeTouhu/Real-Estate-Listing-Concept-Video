import type { Metadata } from "next";
import type { ReactElement } from "react";
import { MIN_PASSWORD_LENGTH } from "@app/domain";
import {
  RESET_PASSWORD_NOTICES,
  openResetLink,
  resetPasswordNotice,
  type ResetPasswordNotice,
} from "@/lib/password-reset";

export const dynamic = "force-dynamic";

// The address may hold a link's token: requests from the page carry at most its
// origin, never its path or query (as on the verify page, ADR-0129).
export const metadata: Metadata = { referrer: "strict-origin" };

type Params = { token?: string | string[]; notice?: string | string[] };

/**
 * Password reset (ADR-0133), with no sign-in. Opened from an emailed link, it
 * shows the new-password form only while the link would reset a password, and
 * opening it writes nothing, so a mail scanner that fetches the link uses
 * nothing. Otherwise it asks for a link, and says how the last step went.
 */
export default async function ResetPasswordPage({ searchParams }: { searchParams: Promise<Params> }) {
  const params = await searchParams;
  if (params.token !== undefined) return openLink(params.token);
  const notice = resetPasswordNotice(params.notice);
  if (notice === "reset") {
    return (
      <section>
        <h1>Password changed</h1>
        <p className="status-ok" role="status">
          {RESET_PASSWORD_NOTICES.reset}
        </p>
        <p>
          <a href="/login">Sign in</a>
        </p>
      </section>
    );
  }
  return <AskForLink notice={notice} />;
}

async function openLink(token: string | string[]): Promise<ReactElement> {
  const state = await openResetLink(token);
  if (state !== "usable" || typeof token !== "string") {
    return <AskForLink notice={state === "failed" ? "failed" : "invalid"} />;
  }
  return (
    <section>
      <h1>Choose a new password</h1>
      <form method="post" action="/api/auth/reset-password" className="card">
        <input type="hidden" name="token" value={token} />
        <label className="field" htmlFor="reset-password">
          New password (min {MIN_PASSWORD_LENGTH} characters)
        </label>
        <input
          id="reset-password"
          name="password"
          type="password"
          autoComplete="new-password"
          minLength={MIN_PASSWORD_LENGTH}
          required
        />
        <p className="muted">Choosing a new password signs your account out everywhere.</p>
        <p className="field">
          <button type="submit">Change password</button>
        </p>
      </form>
    </section>
  );
}

function AskForLink({ notice }: { notice: ResetPasswordNotice | null }) {
  return (
    <section>
      <h1>{notice === "invalid" ? "Link not valid" : "Reset your password"}</h1>
      {notice ? (
        <p className={notice === "sent" ? "status-ok" : "status-bad"} role={notice === "sent" ? "status" : "alert"}>
          {RESET_PASSWORD_NOTICES[notice]}
        </p>
      ) : null}
      <form method="post" action="/api/auth/reset-password/request" className="card">
        <p>Enter the email address of your account, and we will send it a link to choose a new password.</p>
        <label className="field" htmlFor="reset-email">
          Email
        </label>
        <input id="reset-email" name="email" type="email" autoComplete="email" required />
        <p className="field">
          <button type="submit">Send the link</button>
        </p>
      </form>
      <p>
        <a href="/login">Back to sign in</a>
      </p>
    </section>
  );
}
