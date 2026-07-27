export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const params = await searchParams;
  return (
    <section>
      <h1>Real Estate Virtual Tour AI</h1>
      <p className="muted">Sign in or create an account to manage your organizations.</p>
      {params.error ? (
        <p className="status-bad" role="alert">
          {params.error}
        </p>
      ) : null}

      <form method="post" action="/api/auth/login" className="card">
        <h2>Sign in</h2>
        <label className="field" htmlFor="login-email">
          Email
        </label>
        <input id="login-email" name="email" type="email" autoComplete="email" required />
        <label className="field" htmlFor="login-password">
          Password
        </label>
        <input
          id="login-password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
        />
        <p className="field">
          <button type="submit">Sign in</button>
        </p>
      </form>

      <form method="post" action="/api/auth/register" className="card">
        <h2>Create account</h2>
        <label className="field" htmlFor="reg-name">
          Name
        </label>
        <input id="reg-name" name="name" type="text" autoComplete="name" required />
        <label className="field" htmlFor="reg-email">
          Email
        </label>
        <input id="reg-email" name="email" type="email" autoComplete="email" required />
        <label className="field" htmlFor="reg-password">
          Password (min 10 characters)
        </label>
        <input
          id="reg-password"
          name="password"
          type="password"
          autoComplete="new-password"
          minLength={10}
          required
        />
        <p className="field">
          <button type="submit">Create account</button>
        </p>
      </form>
    </section>
  );
}
