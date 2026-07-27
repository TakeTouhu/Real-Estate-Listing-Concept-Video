import { redirect } from "next/navigation";
import { PROPERTY_TYPES } from "@app/domain";
import { getCurrentUser } from "@/lib/auth";
import { getIdentityServices } from "@/lib/identity";
import { getPropertyServices } from "@/lib/property";

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
  const services = getPropertyServices();

  const groups = await Promise.all(
    organizations.map(async ({ organization, role }) => ({
      organization,
      role,
      properties: await services.properties.list(current.user.id, organization.id),
    })),
  );

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

      {groups.length === 0 ? (
        <p className="muted">You are not a member of any organization yet.</p>
      ) : (
        groups.map(({ organization, role, properties }) => (
          <div className="card" key={organization.id}>
            <h2>
              {organization.name} <span className="muted">({role})</span>
            </h2>

            {properties.length === 0 ? (
              <p className="muted">No properties yet.</p>
            ) : (
              <ul>
                {properties.map((property) => (
                  <li key={property.id}>
                    <a href={`/properties/${property.id}`}>{property.name}</a>{" "}
                    <span className="muted">· {property.propertyType}</span>
                  </li>
                ))}
              </ul>
            )}

            <details>
              <summary>Add a property</summary>
              <form method="post" action="/api/properties">
                <input type="hidden" name="organizationId" value={organization.id} />
                <label className="field" htmlFor={`name-${organization.id}`}>
                  Property name
                </label>
                <input id={`name-${organization.id}`} name="name" type="text" required />

                <label className="field" htmlFor={`type-${organization.id}`}>
                  Property type
                </label>
                <select id={`type-${organization.id}`} name="propertyType" defaultValue="APARTMENT">
                  {PROPERTY_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {type}
                    </option>
                  ))}
                </select>

                <label className="field" htmlFor={`addr-${organization.id}`}>
                  Area or masked address <span className="muted">(optional)</span>
                </label>
                <input id={`addr-${organization.id}`} name="addressMasked" type="text" />

                <label className="field" htmlFor={`desc-${organization.id}`}>
                  Description <span className="muted">(optional)</span>
                </label>
                <input id={`desc-${organization.id}`} name="description" type="text" />

                <label className="field checkbox">
                  <input type="checkbox" name="rightsConfirmed" value="yes" required /> I own or have
                  licensed the photos I will upload for this property.
                </label>
                <p className="field">
                  <button type="submit">Create property</button>
                </p>
              </form>
            </details>
          </div>
        ))
      )}

      <form method="post" action="/api/organizations" className="card">
        <h2>Create organization</h2>
        <label className="field" htmlFor="org-name">
          Organization name
        </label>
        <input id="org-name" name="name" type="text" required />
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
