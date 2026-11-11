import { redirect } from "next/navigation";
import type { MembersOverview, MembersOverviewMember, Role } from "@app/domain";
import { AppError } from "@app/shared";
import { getCurrentUser } from "@/lib/auth";
import { getIdentityServices } from "@/lib/identity";
import {
  INVITATION_LIFETIME,
  MEMBERS_ERRORS,
  MEMBERS_NOTICES,
  getMembersOverviewService,
  membersError,
  membersNotice,
} from "@/lib/members";
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

type Query = { notice?: string | string[]; error?: string | string[] };

/**
 * An organization's members, its pending invitations and its seats (AT-5,
 * ADR-0134), for a holder of `member.view`. Viewing writes nothing. A holder
 * of `member.manage` invites with the roles it may assign, and cancels their
 * pending invitations (AT-6b, ADR-0136); the routes answer with a code this
 * page turns into a fixed sentence. A holder of `permission.manage` gives
 * another member a role its ceiling allows, in place of one it allows (AT-8a,
 * ADR-0139).
 */
export default async function MembersPage({
  params,
  searchParams,
}: {
  params: Promise<{ organizationId: string }>;
  searchParams?: Promise<Query>;
}) {
  const current = await getCurrentUser();
  if (!current) redirect("/login");
  const { organizationId } = await params;
  const query = (await searchParams) ?? {};
  const notice = membersNotice(query.notice);
  const failure = membersError(query.error);

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
      {notice ? (
        <p className="status-ok" role="status">
          {MEMBERS_NOTICES[notice]}
        </p>
      ) : null}
      {failure ? (
        <p className="status-bad" role="alert">
          {MEMBERS_ERRORS[failure]}
        </p>
      ) : null}
      <Seats seats={overview.seats} />
      <Invite organizationId={organizationId} overview={overview} />

      <div className="card">
        <h2>Members ({overview.members.length})</h2>
        {overview.assignableRoles.length > 0 ? (
          <p className="muted">
            A member&apos;s role decides what they can do and which Properties they reach. Changing it keeps their
            individual permissions and Property assignments. An Owner, Admin or Billing member must use two-step
            sign-in. You cannot change your own role here.
          </p>
        ) : null}
        <ul>
          {overview.members.map((member) => (
            <li key={member.userId}>
              <strong>{member.name}</strong>
              {member.you ? " (you)" : null} · {member.email} · {ROLE_NAMES[member.role]} · joined{" "}
              {formatJst(member.joinedAt)}
              <ChangeRole organizationId={organizationId} member={member} assignableRoles={overview.assignableRoles} />
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
            {overview.invitations.map((invitation) => (
              <li key={invitation.id}>
                {invitation.email} · {ROLE_NAMES[invitation.role]} · invited {formatJst(invitation.invitedAt)},
                expires {formatJst(invitation.expiresAt)}
                {overview.invitableRoles.includes(invitation.role) ? (
                  <form
                    method="post"
                    action={`/api/organizations/${encodeURIComponent(organizationId)}/invitations/${encodeURIComponent(
                      invitation.id,
                    )}/cancel`}
                  >
                    <button type="submit" aria-label={`Cancel the invitation of ${invitation.email}`}>
                      Cancel invitation
                    </button>
                  </form>
                ) : null}
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

/**
 * The role form of a member other than the viewer whose role the viewer may
 * give: the other roles it may give, none chosen to begin with.
 */
function ChangeRole({
  organizationId,
  member,
  assignableRoles,
}: {
  organizationId: string;
  member: MembersOverviewMember;
  assignableRoles: readonly Role[];
}) {
  const roles = assignableRoles.filter((role) => role !== member.role);
  if (member.you || !assignableRoles.includes(member.role) || roles.length === 0) return null;
  return (
    <form
      method="post"
      action={`/api/organizations/${encodeURIComponent(organizationId)}/members/${encodeURIComponent(
        member.userId,
      )}/role`}
    >
      <select name="role" defaultValue="" required aria-label={`New role for ${member.email}`}>
        <option value="" disabled>
          New role
        </option>
        {roles.map((role) => (
          <option key={role} value={role}>
            {ROLE_NAMES[role]}
          </option>
        ))}
      </select>{" "}
      <button type="submit" aria-label={`Change the role of ${member.email}`}>
        Change role
      </button>
    </form>
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

/**
 * The invite form, for a member who may invite with some role. With no plan,
 * or every seat taken, it says why instead: inviting never adds a seat.
 */
function Invite({ organizationId, overview }: { organizationId: string; overview: MembersOverview }) {
  const { invitableRoles, seats } = overview;
  if (invitableRoles.length === 0) return null;
  return (
    <div className="card">
      <h2>Invite someone</h2>
      {seats === null ? (
        <p>You can invite people once the plan is set up.</p>
      ) : seats.taken >= seats.included ? (
        <p>{MEMBERS_ERRORS["no-seat"]}</p>
      ) : (
        <form method="post" action={`/api/organizations/${encodeURIComponent(organizationId)}/invitations`}>
          <label className="field" htmlFor="invite-email">
            Email address
          </label>
          <input id="invite-email" name="email" type="email" autoComplete="off" required />
          <label className="field" htmlFor="invite-role">
            Role
          </label>
          <select id="invite-role" name="role" defaultValue="" required>
            <option value="" disabled>
              Choose a role
            </option>
            {invitableRoles.map((role) => (
              <option key={role} value={role}>
                {ROLE_NAMES[role]}
              </option>
            ))}
          </select>
          <p className="muted">
            We email the address a link that works for {INVITATION_LIFETIME}. The invitation takes a seat until it
            is accepted, cancelled or expires.
          </p>
          <p className="field">
            <button type="submit">Send invitation</button>
          </p>
        </form>
      )}
    </div>
  );
}
