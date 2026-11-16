import { redirect } from "next/navigation";
import {
  GROUP_NAME_MAX_LENGTH,
  MFA_MANDATORY_PERMISSIONS,
  type GroupsOverview,
  type GroupsOverviewGroup,
  type GroupsOverviewMember,
  type Permission,
} from "@app/domain";
import { AppError } from "@app/shared";
import { getCurrentUser } from "@/lib/auth";
import { GROUPS_ERRORS, GROUPS_NOTICES, getGroupsOverviewService, groupsError, groupsNotice } from "@/lib/groups";
import { getIdentityServices } from "@/lib/identity";
import { NOT_YET_USED, PERMISSION_NAMES, actsOnMembers } from "@/lib/permission-names";
import { ROLE_NAMES } from "@/lib/role-names";

export const dynamic = "force-dynamic";

type Query = { notice?: string | string[]; error?: string | string[] };

/**
 * An organization's groups, who belongs to each (AT-9a, ADR-0141) and the
 * permissions each gives its members (AT-11c, ADR-0148), for a holder of
 * `group.view`. Viewing writes nothing. A holder of `group.manage` creates and
 * renames a group, and one who is also an `OWNER` or `ADMIN` deletes one
 * (AT-9b, ADR-0142); one who may also assign a member's role adds them to a
 * group or removes them (AT-9c, ADR-0143); a holder of `permission.manage`
 * gives a group a permission or takes one back. Each is offered where the
 * grant ceiling allows it on that group. Each route answers with a code this
 * page turns into a fixed sentence.
 */
export default async function GroupsPage({
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
  const notice = groupsNotice(query.notice);
  const failure = groupsError(query.error);

  let overview: GroupsOverview;
  try {
    overview = await getGroupsOverviewService().overview(current.user.id, organizationId);
  } catch (error) {
    if (!(error instanceof AppError) || error.code !== "FORBIDDEN") throw error;
    return (
      <section>
        <h1>Groups</h1>
        <p className="status-bad" role="alert">
          You cannot view this organization&apos;s groups.
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
      <h1>Groups</h1>
      {name ? <p className="muted">{name}</p> : null}
      {notice ? (
        <p className="status-ok" role="status">
          {GROUPS_NOTICES[notice]}
        </p>
      ) : null}
      {failure ? (
        <p className="status-bad" role="alert">
          {GROUPS_ERRORS[failure]}
        </p>
      ) : null}
      <p className="muted">A Manager reaches the Properties assigned to the groups they belong to.</p>
      {overview.mayManage ? <CreateGroup organizationId={organizationId} /> : null}

      <div className="card">
        <h2>Groups ({overview.groups.length})</h2>
        {overview.groups.length === 0 ? (
          <p className="muted">No groups yet.</p>
        ) : (
          <ul>
            {overview.groups.map((group) => (
              <li key={group.id}>
                <strong>{group.name}</strong> ·{" "}
                {group.members.length === 1 ? "1 member" : `${group.members.length} members`}
                {group.members.length > 0 ? (
                  <ul>
                    {group.members.map((member) => (
                      <li key={member.userId}>
                        {memberLine(member)}
                        {member.mayRemove ? (
                          <RemoveGroupMember organizationId={organizationId} group={group} member={member} />
                        ) : null}
                      </li>
                    ))}
                  </ul>
                ) : null}
                <GroupPermissions organizationId={organizationId} group={group} />
                {group.addable.length > 0 ? <AddGroupMember organizationId={organizationId} group={group} /> : null}
                {overview.mayManage ? <RenameGroup organizationId={organizationId} group={group} /> : null}
                {group.mayDelete ? <DeleteGroup organizationId={organizationId} group={group} /> : null}
              </li>
            ))}
          </ul>
        )}
      </div>

      <p>
        <a href={`/organizations/${encodeURIComponent(organizationId)}/members`}>Members</a> ·{" "}
        <a href="/">Back to organizations</a>
      </p>
    </section>
  );
}

/** The form that creates a group, for a holder of `group.manage`. */
function CreateGroup({ organizationId }: { organizationId: string }) {
  return (
    <div className="card">
      <h2>Create a group</h2>
      <form method="post" action={`/api/organizations/${encodeURIComponent(organizationId)}/groups`}>
        <label className="field" htmlFor="group-name">
          Group name
        </label>
        <input id="group-name" name="name" type="text" maxLength={GROUP_NAME_MAX_LENGTH} autoComplete="off" required />
        <p className="field">
          <button type="submit">Create group</button>
        </p>
      </form>
    </div>
  );
}

/** A member as the page names them: name, address where shown, and role. */
function memberLine(member: GroupsOverviewMember): string {
  return `${member.name}${member.email === null ? "" : ` · ${member.email}`} · ${ROLE_NAMES[member.role]}`;
}

/** Where a group's changes are posted. */
function groupAction(
  organizationId: string,
  groupId: string,
  change: "rename" | "delete" | "members" | "permissions",
): string {
  return `/api/organizations/${encodeURIComponent(organizationId)}/groups/${encodeURIComponent(groupId)}/${change}`;
}

/**
 * The closed form that renames a group, for a holder of `group.manage`. It
 * carries the name it shows, so a group renamed meanwhile is not renamed again
 * unseen.
 */
function RenameGroup({ organizationId, group }: { organizationId: string; group: GroupsOverviewGroup }) {
  return (
    <details>
      <summary aria-label={`Rename ${group.name}…`}>Rename…</summary>
      <form method="post" action={groupAction(organizationId, group.id, "rename")}>
        <input type="hidden" name="from" value={group.name} />
        <label className="field" htmlFor={`rename-${group.id}`}>
          New name
        </label>
        <input
          id={`rename-${group.id}`}
          aria-label={`New name for ${group.name}`}
          name="name"
          type="text"
          defaultValue={group.name}
          maxLength={GROUP_NAME_MAX_LENGTH}
          autoComplete="off"
          required
        />
        <p className="field">
          <button type="submit" aria-label={`Rename group ${group.name}`}>
            Rename group
          </button>
        </p>
      </form>
    </details>
  );
}

/**
 * The closed form that deletes a group, for a holder of `group.manage` who is
 * an `OWNER` or `ADMIN` (ADR-0052 Decision 11). Opened, it says what deleting
 * does before its button.
 */
function DeleteGroup({ organizationId, group }: { organizationId: string; group: GroupsOverviewGroup }) {
  return (
    <details>
      <summary aria-label={`Delete ${group.name}…`}>Delete…</summary>
      <form method="post" action={groupAction(organizationId, group.id, "delete")}>
        <p className="muted" id={`delete-${group.id}-effects`}>
          {group.name} will be deleted. Its members stay in the organization with their roles, and lose only what
          this group gave them. Properties assigned to it are left with no group, so no Manager reaches them.
          Nothing else is deleted, and this cannot be undone.
        </p>
        <button type="submit" aria-label={`Delete group ${group.name}`} aria-describedby={`delete-${group.id}-effects`}>
          Delete group
        </button>
      </form>
    </details>
  );
}

/**
 * The closed form that adds a member of the organization to a group: one of
 * those not in it whose role the viewer may assign (ADR-0143).
 */
function AddGroupMember({ organizationId, group }: { organizationId: string; group: GroupsOverviewGroup }) {
  return (
    <details>
      <summary aria-label={`Add member to ${group.name}…`}>Add member…</summary>
      <form method="post" action={groupAction(organizationId, group.id, "members")}>
        <label className="field" htmlFor={`add-${group.id}`}>
          Member
        </label>
        <select
          id={`add-${group.id}`}
          aria-label={`Member to add to ${group.name}`}
          name="userId"
          defaultValue=""
          required
        >
          <option value="" disabled>
            Choose a member
          </option>
          {group.addable.map((member) => (
            <option key={member.userId} value={member.userId}>
              {memberLine(member)}
            </option>
          ))}
        </select>
        <p className="field">
          <button type="submit" aria-label={`Add to group ${group.name}`}>
            Add to group
          </button>
        </p>
      </form>
    </details>
  );
}

/**
 * The closed form that removes a member from a group, for a viewer who may
 * assign their role (ADR-0143). Opened, it says what removing does before its
 * button.
 */
function RemoveGroupMember({
  organizationId,
  group,
  member,
}: {
  organizationId: string;
  group: GroupsOverviewGroup;
  member: GroupsOverviewMember;
}) {
  const who = member.email === null ? member.name : `${member.name} (${member.email})`;
  const effects = `remove-${group.id}-${member.userId}-effects`;
  const action = `${groupAction(organizationId, group.id, "members")}/${encodeURIComponent(member.userId)}/remove`;
  return (
    <details>
      <summary aria-label={`Remove ${who} from ${group.name}…`}>Remove…</summary>
      <form method="post" action={action}>
        <p className="muted" id={effects}>
          {member.name} will leave {group.name} and lose only what this group gave them, so a Manager no longer
          reaches the Properties assigned to it. They stay in the organization with their role.
        </p>
        <button type="submit" aria-label={`Remove from group ${group.name}: ${who}`} aria-describedby={effects}>
          Remove from group
        </button>
      </form>
    </details>
  );
}

/** A permission as the page names it, saying so when nothing in VTaVision uses it yet (ADR-0146). */
function permissionName(permission: Permission): string {
  const unused = NOT_YET_USED.includes(permission) ? " (nothing in VTaVision uses it yet)" : "";
  return `${PERMISSION_NAMES[permission]}${unused}`;
}

/**
 * What a group gives each of its members (ADR-0061), with the form taking each
 * back where the viewer may, and the form giving it another where there is one
 * to give (ADR-0148).
 */
function GroupPermissions({ organizationId, group }: { organizationId: string; group: GroupsOverviewGroup }) {
  const action = groupAction(organizationId, group.id, "permissions");
  return (
    <>
      {group.permissions.length === 0 ? (
        <p className="muted">It gives its members no permissions.</p>
      ) : (
        <>
          <p>It gives each of its members:</p>
          <ul>
            {group.permissions.map((permission) => (
              <li key={permission}>
                {permissionName(permission)}
                {group.revocable.includes(permission) ? (
                  <form method="post" action={`${action}/revoke`}>
                    <input type="hidden" name="permission" value={permission} />
                    <button
                      type="submit"
                      aria-label={`Take back from ${group.name} the permission: ${PERMISSION_NAMES[permission]}`}
                    >
                      Take back
                    </button>
                  </form>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      )}
      {group.givable.length > 0 ? <GiveGroupPermission action={`${action}/grant`} group={group} /> : null}
    </>
  );
}

/**
 * The closed form that gives a group one of the permissions the viewer may
 * give it. Opened, it says what giving brings before its list.
 */
function GiveGroupPermission({ action, group }: { action: string; group: GroupsOverviewGroup }) {
  const notes = `give-${group.id}-notes`;
  const mfa = group.givable.filter((permission) => MFA_MANDATORY_PERMISSIONS.includes(permission));
  const quoted = mfa.map((permission) => `"${PERMISSION_NAMES[permission]}"`).join(" or ");
  return (
    <details>
      <summary aria-label={`Give ${group.name} a permission…`}>Give a permission…</summary>
      <form method="post" action={action}>
        <p className="muted" id={notes}>
          Each member of {group.name} will hold it, and so will anyone added to the group later. It never widens which
          Properties they reach.
          {group.givable.includes("property.create")
            ? " \"Add Properties\" is never in effect for a Viewer or Billing member."
            : null}
          {mfa.length > 0 ? ` Whoever holds ${quoted} must use two-step sign-in.` : null}
          {group.givable.some(actsOnMembers)
            ? " Whatever a group gives, only an Owner or Admin can act on other members."
            : null}
        </p>
        <label className="field" htmlFor={`give-${group.id}`}>
          Permission
        </label>
        <select
          id={`give-${group.id}`}
          aria-label={`Permission to give ${group.name}`}
          name="permission"
          defaultValue=""
          required
        >
          <option value="" disabled>
            Choose a permission
          </option>
          {group.givable.map((permission) => (
            <option key={permission} value={permission}>
              {permissionName(permission)}
            </option>
          ))}
        </select>
        <p className="field">
          <button type="submit" aria-label={`Give to group ${group.name}`} aria-describedby={notes}>
            Give to group
          </button>
        </p>
      </form>
    </details>
  );
}
