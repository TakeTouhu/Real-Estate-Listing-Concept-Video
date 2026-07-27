import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { getIdentityServices } from "@/lib/identity";

export const dynamic = "force-dynamic";

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const current = await getCurrentUser();
  if (!current) {
    redirect("/login");
  }
  const params = await searchParams;
  const organizations = await getIdentityServices().organizations.listForUser(current.user.id);

  return (
    <section>
      <h1>Organizations</h1>
      <p className="muted">
        Signed in as {current.user.name} ({current.user.email})
      </p>
      {params.error ? (
        <p className="status-bad" role="alert">
          {params.error}
        </p>
      ) : null}

      <div className="card">
        <h2>Your organizations</h2>
        {organizations.length === 0 ? (
          <p className="muted">You are not a member of any organization yet.</p>
        ) : (
          <ul>
            {organizations.map(({ organization, role }) => (
              <li key={organization.id}>
                {organization.name} <span className="muted">({organization.slug})</span> —{" "}
                <strong>{role}</strong>
              </li>
            ))}
          </ul>
        )}
      </div>

      <form method="post" action="/api/organizations" className="card">
        <h2>Create organization</h2>
        <label className="field" htmlFor="org-name">
          Organization name
        </label>
        <input id="org-name" name="name" type="text" required style={{ maxWidth: "100%" }} />
        <p className="field">
          <button type="submit">Create</button>
        </p>
      </form>

      <form method="post" action="/api/auth/logout">
        <button type="submit">Sign out</button>
      </form>
    </section>
  );
}
