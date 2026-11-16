import { redirect } from "next/navigation";
import { MFA_MANDATORY_PERMISSIONS, type MemberPermission, type MemberPermissions, type Scope } from "@app/domain";
import { AppError } from "@app/shared";
import { getCurrentUser } from "@/lib/auth";
import { getIdentityServices } from "@/lib/identity";
import {
  MEMBER_PERMISSIONS_ERRORS,
  MEMBER_PERMISSIONS_NOTICES,
  getMemberPermissionsService,
  memberPermissionsError,
  memberPermissionsNotice,
  offersToGive,
} from "@/lib/member-permissions";
import { NOT_YET_USED, PERMISSION_AREAS, PERMISSION_NAMES, permissionAnswer, roleLimit } from "@/lib/permission-names";
import { ROLE_NAMES } from "@/lib/role-names";

export const dynamic = "force-dynamic";

/** Which Properties a member's permissions over Properties apply to, by the scope their role fixes. */
const REACH: Record<Scope, string> = {
  ORGANIZATION: "every Property of the organization",
  GROUP: "the Properties of the groups they belong to",
  OWN: "the Properties they are responsible for",
};

type Query = { notice?: string | string[]; error?: string | string[] };

/**
 * What one member of an organization may do, and where each permission comes
 * from: their role, an individual grant or their groups (AT-11a, ADR-0146).
 * For a holder of `member.view`, who reaches it from the members page.
 * Viewing writes nothing. A viewer the grant ceiling allows gives the member
 * a permission they cannot use yet, and takes back one given individually
 * (AT-11b, ADR-0147); the routes answer with a code this page turns into a
 * fixed sentence.
 */
export default async function MemberPermissionsPage({
  params,
  searchParams,
}: {
  params: Promise<{ organizationId: string; userId: string }>;
  searchParams?: Promise<Query>;
}) {
  const current = await getCurrentUser();
  if (!current) redirect("/login");
  const { organizationId, userId } = await params;
  const query = (await searchParams) ?? {};
  const notice = memberPermissionsNotice(query.notice);
  const failure = memberPermissionsError(query.error);
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
  const action = `/api/organizations/${encodeURIComponent(organizationId)}/members/${encodeURIComponent(
    member.userId,
  )}/permissions`;
  const changes = view.permissions.some((row) => offersToGive(row) || row.mayRevoke);

  return (
    <section>
      <h1>Permissions</h1>
      {name ? <p className="muted">{name}</p> : null}
      {notice ? (
        <p className="status-ok" role="status">
          {MEMBER_PERMISSIONS_NOTICES[notice]}
        </p>
      ) : null}
      {failure ? (
        <p className="status-bad" role="alert">
          {MEMBER_PERMISSIONS_ERRORS[failure]}
        </p>
      ) : null}
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
        {changes ? (
          <p className="muted">
            You can give them a permission they do not have, or take back one given to them individually. One from
            their role or groups changes only with their role or groups. A permission given individually never widens
            which Properties they reach, and stays if their role changes.
          </p>
        ) : null}
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
                  <Change action={action} member={member} row={row} />
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

/**
 * The forms of one permission: giving it, when the page offers to, and taking
 * back the member's individual grant of it, when the viewer may. Giving says
 * what holding it brings beyond the permission itself.
 */
function Change({
  action,
  member,
  row,
}: {
  action: string;
  member: MemberPermissions["member"];
  row: MemberPermission;
}) {
  const name = PERMISSION_NAMES[row.permission];
  const limit = roleLimit(row.permission, member.role);
  return (
    <>
      {offersToGive(row) ? (
        <form method="post" action={`${action}/grant`}>
          <input type="hidden" name="permission" value={row.permission} />
          {MFA_MANDATORY_PERMISSIONS.includes(row.permission) ? (
            <span className="muted">Whoever holds it must use two-step sign-in. </span>
          ) : null}
          {limit === undefined ? null : <span className="muted">{limit} </span>}
          <button type="submit" aria-label={`Give ${member.email} the permission: ${name}`}>
            Give
          </button>
        </form>
      ) : null}
      {row.mayRevoke ? (
        <form method="post" action={`${action}/revoke`}>
          <input type="hidden" name="permission" value={row.permission} />
          <button type="submit" aria-label={`Take back from ${member.email} the permission: ${name}`}>
            Take back
          </button>
        </form>
      ) : null}
    </>
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
