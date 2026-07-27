export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const params = await searchParams;
  return (
    <section>
      <h1>Operations sign in</h1>
      <p className="muted">
        Enter the operator token to access the Phase 0 health-check console.
      </p>
      {params.error ? (
        <p className="status-bad" role="alert">
          Invalid operator token.
        </p>
      ) : null}
      <form method="post" action="/api/auth/login" className="card">
        <label className="field" htmlFor="token">
          Operator token
        </label>
        <input id="token" name="token" type="password" autoComplete="off" required />
        <p className="field">
          <button type="submit">Sign in</button>
        </p>
      </form>
    </section>
  );
}
