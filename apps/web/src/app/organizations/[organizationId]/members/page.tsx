import { redirect } from "next/navigation";
import type { MembersOverview, Role } from "@app/domain";
import { AppError } from "@app/shared";
import { getCurrentUser } from "@/lib/auth";
import { getIdentityServices } from "@/lib/identity";
import { getMembersOverviewService } from "@/lib/members";
import { formatJst } from "@/lib/units-view";

export const dynamic = "force-dynamic";

const ROLE_NAMES: Record<Role, string> = {
  OWNER: "Owner",
  ADMIN: "Admin",
  MANAGER: "Manager",
  CREATOR: "Creator",
  VIEWER: "Viewer",
  BILLING: "Billing",
};

/**
 * An organization's members, its pending invitations and its seats (AT-5,
 * ADR-0134), for a holder of `member.view`. Viewing writes nothing.
 */
export default async function MembersPage({ params }: { params: Promise<{ organizationId: string }> }) {
  const current = await getCurrentUser();
  if (!current) redirect("/login");
  const { organizationId } = await params;

  let overview: MembersOverview;
  try {
    overview = await getMembersOverviewService().overview(current.user.id, organizationId);
  } catch (error) {
    if (!(error instanceof AppError) || error.code !== "FORBIDDEN") throw error;
    return (
      <section>
        <h1>Members</h1>
        <p className="status-bad" role="alert">
          You cannot view this organization&apos;s members.
        </p>
        <p>
          <a href="/">Back to organizations</a>
        </p>
      </section>
    );
  }

  const memberships = await getIdentityServices().organizations.listForUser(current.user.id);
  const name = memberships.find(({ organization }) => organization.id === organizationId)?.organization.name;

  return (
    <section>
      <h1>Members</h1>
      {name ? <p className="muted">{name}</p> : null}
      <Seats seats={overview.seats} />

      <div className="card">
        <h2>Members ({overview.members.length})</h2>
        <ul>
          {overview.members.map((member) => (
            <li key={member.email}>
              <strong>{member.name}</strong>
              {member.you ? " (you)" : null} · {member.email} · {ROLE_NAMES[member.role]} · joined{" "}
              {formatJst(member.joinedAt)}
            </li>
          ))}
        </ul>
      </div>

      <div className="card">
        <h2>Pending invitations ({overview.invitations.length})</h2>
        {overview.invitations.length === 0 ? (
          <p className="muted">No pending invitations.</p>
        ) : (
          <ul>
            {overview.invitations.map((invitation, index) => (
              <li key={index}>
                {invitation.email} · {ROLE_NAMES[invitation.role]} · invited {formatJst(invitation.invitedAt)},
                expires {formatJst(invitation.expiresAt)}
              </li>
            ))}
          </ul>
        )}
      </div>

      <p>
        <a href="/">Back to organizations</a>
      </p>
    </section>
  );
}

function Seats({ seats }: { seats: MembersOverview["seats"] }) {
  return (
    <div className="card">
      <h2>Seats</h2>
      {seats === null ? (
        <p>
          This organization has no plan yet. Its seats come with the plan, which VTaVision sets up when your contract
          starts.
        </p>
      ) : (
        <>
          <p>
            <strong>{seats.taken}</strong> of {seats.included} taken.
          </p>
          <p className="muted">
            Every member takes a seat, the owner included, and so does an invitation until it is accepted or
            expires.
          </p>
        </>
      )}
    </div>
  );
}
