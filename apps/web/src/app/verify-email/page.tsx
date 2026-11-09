import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { ACCOUNT_LINK_TOKEN_MAX_LENGTH } from "@app/domain";
import { getSignIn, nextPageFor } from "@/lib/auth";
import { VERIFY_EMAIL_NOTICES, verifyEmailNotice } from "@/lib/email-verification";

export const dynamic = "force-dynamic";

// The address may hold a link's token: requests from the page carry at most its
// origin, never its path or query. Not "no-referrer", which would also make the
// page's own forms post `Origin: null`.
export const metadata: Metadata = { referrer: "strict-origin" };

type Params = { token?: string | string[]; notice?: string | string[] };

/**
 * Email verification (ADR-0129). Opened from an emailed link, it asks for one
 * press of a button before the token is used, so a mail scanner that fetches
 * the link verifies nothing. Otherwise it is the only page a sign-in that has
 * not verified its address may see: it names the address and sends the link
 * again.
 */
export default async function VerifyEmailPage({ searchParams }: { searchParams: Promise<Params> }) {
  const params = await searchParams;
  const notice = verifyEmailNotice(params.notice);
  if (params.token !== undefined) return <OpenLink token={params.token} />;
  if (notice === "verified") {
    return (
      <Outcome heading="Email address verified" text={VERIFY_EMAIL_NOTICES.verified} status="status-ok" />
    );
  }

  const signIn = await getSignIn();
  if (signIn?.step !== "EMAIL_VERIFICATION_REQUIRED") {
    if (notice === "invalid") {
      return <InvalidLink />;
    }
    redirect(signIn ? nextPageFor(signIn.step) : "/login");
  }
  return (
    <section>
      <h1>Verify your email address</h1>
      {notice ? (
        <p className={notice === "sent" ? "status-ok" : "status-bad"} role={notice === "sent" ? "status" : "alert"}>
          {VERIFY_EMAIL_NOTICES[notice]}
        </p>
      ) : null}
      <p>
        {notice === "not-sent" ? "To continue, have a link sent to " : "To continue, open the link we sent to "}
        <strong>{signIn.user.email}</strong>. It works once, for 24 hours.
      </p>
      <form method="post" action="/api/auth/verify-email/resend" className="card">
        <p className="muted">No email? Check your spam folder, or have a new link sent.</p>
        <button type="submit">Send the link again</button>
      </form>
      <form method="post" action="/api/auth/logout">
        <button type="submit">Sign out</button>
      </form>
    </section>
  );
}

/** One press verifies the address the link was sent to. */
function OpenLink({ token }: { token: string | string[] }) {
  if (typeof token !== "string" || token.length === 0 || token.length > ACCOUNT_LINK_TOKEN_MAX_LENGTH) {
    return <InvalidLink />;
  }
  return (
    <section>
      <h1>Verify your email address</h1>
      <form method="post" action="/api/auth/verify-email" className="card">
        <input type="hidden" name="token" value={token} />
        <p>Press the button to verify the email address of your account.</p>
        <p className="muted">If you did not create an account with this address, close this page.</p>
        <button type="submit">Verify email address</button>
      </form>
    </section>
  );
}

function InvalidLink() {
  return (
    <Outcome heading="Link not valid" text={VERIFY_EMAIL_NOTICES.invalid} status="status-bad">
      Sign in to have a new link sent.
    </Outcome>
  );
}

function Outcome({
  heading,
  text,
  status,
  children,
}: {
  heading: string;
  text: string;
  status: "status-ok" | "status-bad";
  children?: string;
}) {
  return (
    <section>
      <h1>{heading}</h1>
      <p className={status} role={status === "status-bad" ? "alert" : "status"}>
        {text}
      </p>
      {children ? <p>{children}</p> : null}
      <p>
        <a href="/">Continue</a>
      </p>
    </section>
  );
}
