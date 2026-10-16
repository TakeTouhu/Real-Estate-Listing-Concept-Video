import { redirect } from "next/navigation";
import { getSignIn } from "@/lib/auth";

export const dynamic = "force-dynamic";

/** The second sign-in step, for a sign-in that passed the password and owes a code (ADR-0065). */
export default async function MfaCodePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const signIn = await getSignIn();
  if (!signIn) redirect("/login");
  if (signIn.step === "SIGNED_IN") redirect("/");
  const params = await searchParams;
  return (
    <section>
      <h1>Enter your code</h1>
      <p className="muted">
        Enter the 6-digit code from your authenticator app, or one of your recovery codes.
      </p>
      {params.error ? (
        <p className="status-bad" role="alert">
          {params.error}
        </p>
      ) : null}

      <form method="post" action="/api/auth/mfa" className="card">
        <label className="field" htmlFor="mfa-code">
          Code
        </label>
        <input
          id="mfa-code"
          name="code"
          type="text"
          autoComplete="one-time-code"
          autoCapitalize="characters"
          spellCheck={false}
          required
        />
        <p className="field">
          <button type="submit">Continue</button>
        </p>
      </form>

      <form method="post" action="/api/auth/logout">
        <button type="submit">Sign out</button>
      </form>
    </section>
  );
}
