import { redirect } from "next/navigation";
import { mayChangeMfaRequirement } from "@app/domain";
import { AppError } from "@app/shared";
import { getCurrentUser } from "@/lib/auth";
import { getIdentityServices } from "@/lib/identity";
import { waitingInvitation } from "@/lib/invitations";
import { getPropertyServices } from "@/lib/property";
import { AddPropertyForm } from "./add-property-form";

export const dynamic = "force-dynamic";

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; joined?: string }>;
}) {
  const current = await getCurrentUser();
  if (!current) {
    redirect("/login");
  }
  const params = await searchParams;
  // An invitation opened before signing in waits here until it is answered
  // (ADR-0138), unless this page has an error to show first.
  if (!params.error && (await waitingInvitation())) redirect("/accept-invitation");
  const organizations = await getIdentityServices().organizations.listForUser(current.user.id);
  const services = getPropertyServices();

  const groups = await Promise.all(
    organizations.map(async ({ organization, role }) => ({
      organization,
      role,
      properties: await services.properties.list(current.user.id, organization.id).catch(withoutPropertyView),
      creation: await services.properties.creationChoices(current.user.id, organization.id),
    })),
  );
  const joined = groups.find(({ organization }) => organization.id === params.joined);

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
      {joined ? (
        <p className="status-ok" role="status">
          You joined {joined.organization.name} as {joined.role}.
        </p>
      ) : null}

      {groups.length === 0 ? (
        <p className="muted">You are not a member of any organization yet.</p>
      ) : (
        groups.map(({ organization, role, properties, creation }) => (
          <div className="card" key={organization.id}>
            <h2>
              {organization.name} <span className="muted">({role})</span>
            </h2>
            <p className="muted">
              {organization.mfaRequired
                ? "Every member must use two-step sign-in (MFA)."
                : "Two-step sign-in (MFA) is not required of every member."}
            </p>
            {mayChangeMfaRequirement(role) ? (
              <form method="post" action={`/api/organizations/${organization.id}/mfa-requirement`}>
                <input type="hidden" name="required" value={organization.mfaRequired ? "false" : "true"} />
                <button type="submit">
                  {organization.mfaRequired ? "Stop requiring MFA of every member" : "Require MFA of every member"}
                </button>
              </form>
            ) : null}
            <p>
              <a href={`/organizations/${organization.id}/units`}>Units and plan</a> ·{" "}
              <a href={`/organizations/${organization.id}/members`}>Members</a> ·{" "}
              <a href={`/organizations/${organization.id}/groups`}>Groups</a>
            </p>

            {properties === null ? (
              <p className="muted">Your role does not include Properties.</p>
            ) : properties.length === 0 ? (
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

            {creation ? <AddPropertyForm organizationId={organization.id} choices={creation} /> : null}
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

      <p>
        <a href="/security">Sign-in security</a>
      </p>

      <form method="post" action="/api/auth/logout">
        <button type="submit">Sign out</button>
      </form>
    </section>
  );
}

/**
 * No list for a member whose permissions do not include viewing Properties, as
 * a `BILLING` member's do not. The organizations listed are the member's own,
 * so that is all `FORBIDDEN` can mean here (ADR-0145).
 */
function withoutPropertyView(error: unknown): null {
  if (error instanceof AppError && error.code === "FORBIDDEN") return null;
  throw error;
}
