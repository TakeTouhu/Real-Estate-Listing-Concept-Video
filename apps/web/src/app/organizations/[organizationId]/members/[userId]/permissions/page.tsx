import { redirect } from "next/navigation";
import type { MemberPermissions, Scope } from "@app/domain";
import { AppError } from "@app/shared";
import { getCurrentUser } from "@/lib/auth";
import { getIdentityServices } from "@/lib/identity";
import { getMemberPermissionsService } from "@/lib/member-permissions";
import { NOT_YET_USED, PERMISSION_AREAS, PERMISSION_NAMES, permissionAnswer } from "@/lib/permission-names";
import { ROLE_NAMES } from "@/lib/role-names";

export const dynamic = "force-dynamic";

/** Which Properties a member's permissions over Properties apply to, by the scope their role fixes. */
const REACH: Record<Scope, string> = {
  ORGANIZATION: "every Property of the organization",
  GROUP: "the Properties of the groups they belong to",
  OWN: "the Properties they are responsible for",
};

/**
 * What one member of an organization may do, and where each permission comes
 * from: their role, an individual grant or their groups (AT-11a, ADR-0146).
 * For a holder of `member.view`, who reaches it from the members page.
 * Viewing writes nothing.
 */
export default async function MemberPermissionsPage({
  params,
}: {
  params: Promise<{ organizationId: string; userId: string }>;
}) {
  const current = await getCurrentUser();
  if (!current) redirect("/login");
  const { organizationId, userId } = await params;
  const membersPage = `/organizations/${encodeURIComponent(organizationId)}/members`;

  let view: MemberPermissions;
  try {
    view = await getMemberPermissionsService().view(current.user.id, organizationId, userId);
  } catch (error) {
    if (error instanceof AppError && error.code === "FORBIDDEN") {
      return <Refusal text="You cannot view this organization's members." back="/" backText="Back to organizations" />;
    }
    if (error instanceof AppError && error.code === "NOT_FOUND") {
      return (
        <Refusal
          text="That person is not a member of this organization."
          back={membersPage}
          backText="Back to members"
        />
      );
    }
    throw error;
  }

  const memberships = await getIdentityServices().organizations.listForUser(current.user.id);
  const name = memberships.find(({ organization }) => organization.id === organizationId)?.organization.name;
  const { member } = view;

  return (
    <section>
      <h1>Permissions</h1>
      {name ? <p className="muted">{name}</p> : null}
      <div className="card">
        <h2>
          {member.name}
          {member.you ? " (you)" : null}
        </h2>
        <p>
          {member.email} · {ROLE_NAMES[member.role]}
        </p>
        <p className="muted">
          What they can do comes from their role, from permissions given to them individually, and from the
          permissions of the groups they belong to. These add up: nothing takes a permission away, though a Viewer
          or Billing member can never add Properties, however it is given. Their permissions over Properties, photos
          and videos apply to {REACH[view.scope]}, which their role decides.
        </p>
      </div>
      {PERMISSION_AREAS.map((area) => (
        <div className="card" key={area.title}>
          <h2>{area.title}</h2>
          <ul>
            {view.permissions
              .filter(({ permission }) => area.permissions.includes(permission))
              .map((row) => (
                <li key={row.permission}>
                  <strong>{PERMISSION_NAMES[row.permission]}</strong>{" "}
                  <span className="muted">({row.permission})</span>: {permissionAnswer(row, member.role)}
                  {NOT_YET_USED.includes(row.permission) ? (
                    <span className="muted"> Nothing in VTaVision uses it yet.</span>
                  ) : null}
                </li>
              ))}
          </ul>
        </div>
      ))}
      <p>
        <a href={membersPage}>Back to members</a>
      </p>
    </section>
  );
}

function Refusal({ text, back, backText }: { text: string; back: string; backText: string }) {
  return (
    <section>
      <h1>Permissions</h1>
      <p className="status-bad" role="alert">
        {text}
      </p>
      <p>
        <a href={back}>{backText}</a>
      </p>
    </section>
  );
}
