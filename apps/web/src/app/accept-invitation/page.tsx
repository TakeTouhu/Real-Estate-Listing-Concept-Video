import type { Metadata } from "next";
import type { InvitationOffer } from "@app/domain";
import { getCurrentUser, type CurrentUser } from "@/lib/auth";
import {
  ACCEPT_ERRORS,
  acceptError,
  openInvitation,
  waitingInvitationToken,
  type AcceptError,
} from "@/lib/invitations";

export const dynamic = "force-dynamic";

// The address may hold the link's token: requests from the page carry at most
// its origin, never its path or query (as on the verify page, ADR-0129).
export const metadata: Metadata = { referrer: "strict-origin" };

type Params = { token?: string | string[]; error?: string | string[] };

/**
 * An invitation (ADR-0138). Opened from its emailed link, it shows what the
 * invitation offers and asks for one press before the token is used, so a
 * mail scanner that fetches the link changes nothing. Without a token, it
 * shows the invitation waiting in this browser, and why accepting it was
 * refused. Only a complete sign-in is offered to accept; anyone else is asked
 * to continue to the sign-in page.
 */
export default async function AcceptInvitationPage({ searchParams }: { searchParams: Promise<Params> }) {
  const params = await searchParams;
  const current = await getCurrentUser();
  if (params.token !== undefined) {
    const token = typeof params.token === "string" ? params.token : "";
    const opened = await openInvitation(token);
    if (opened.state !== "open") return <NotOpen state={opened.state} />;
    return <Offer offer={opened.offer} token={token} current={current} error={null} />;
  }
  const error = acceptError(params.error);
  const token = await waitingInvitationToken();
  const opened = token === null ? null : await openInvitation(token);
  if (opened?.state === "open") return <Offer offer={opened.offer} token={null} current={current} error={error} />;
  if (error !== null) return <Refused error={error} />;
  return <NotOpen state={opened?.state ?? "none"} />;
}

function Offer({
  offer,
  token,
  current,
  error,
}: {
  offer: InvitationOffer;
  token: string | null;
  current: CurrentUser | null;
  error: AcceptError | null;
}) {
  return (
    <section>
      <h1>Join {offer.organizationName}</h1>
      {error ? (
        <p className="status-bad" role="alert">
          {ACCEPT_ERRORS[error]}
        </p>
      ) : null}
      <p>
        You are invited to join <strong>{offer.organizationName}</strong> on VTaVision as {offer.invitedAs}.
      </p>
      <form method="post" action="/api/invitations/accept" className="card">
        {token === null ? null : <input type="hidden" name="token" value={token} />}
        {current ? (
          <p>
            You are signed in as <strong>{current.user.email}</strong>. Only the account with the email address this
            invitation was sent to can accept it.
          </p>
        ) : (
          <p>
            Sign in, or create an account, with the email address this invitation was sent to. You can accept it once
            that address is verified.
          </p>
        )}
        <button type="submit">{current ? "Accept invitation" : "Continue"}</button>
      </form>
      {current ? (
        <>
          <form method="post" action="/api/invitations/dismiss">
            <button type="submit">Not now</button>
          </form>
          <form method="post" action="/api/auth/logout">
            <button type="submit">Sign out</button>
          </form>
        </>
      ) : null}
    </section>
  );
}

function Refused({ error }: { error: AcceptError }) {
  return (
    <section>
      <h1>Invitation not accepted</h1>
      <p className="status-bad" role="alert">
        {ACCEPT_ERRORS[error]}
      </p>
      <p>
        <a href="/">Continue</a>
      </p>
    </section>
  );
}

function NotOpen({ state }: { state: "invalid" | "failed" | "none" }) {
  const text = {
    invalid: ACCEPT_ERRORS.invalid,
    failed: "The invitation cannot be shown right now. Try again later.",
    none: "No invitation is waiting here. Open the link in your invitation email.",
  }[state];
  return (
    <section>
      <h1>{state === "invalid" ? "Link not valid" : "Invitation"}</h1>
      <p className={state === "none" ? "muted" : "status-bad"} role={state === "none" ? undefined : "alert"}>
        {text}
      </p>
      <p>
        <a href="/">Continue</a>
      </p>
    </section>
  );
}
