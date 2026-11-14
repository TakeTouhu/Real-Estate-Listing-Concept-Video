import { redirect } from "next/navigation";
import { GROUP_NAME_MAX_LENGTH, type GroupsOverview } from "@app/domain";
import { AppError } from "@app/shared";
import { getCurrentUser } from "@/lib/auth";
import { GROUPS_ERRORS, GROUPS_NOTICES, getGroupsOverviewService, groupsError, groupsNotice } from "@/lib/groups";
import { getIdentityServices } from "@/lib/identity";
import { ROLE_NAMES } from "@/lib/role-names";

export const dynamic = "force-dynamic";

type Query = { notice?: string | string[]; error?: string | string[] };

/**
 * An organization's groups and who belongs to each (AT-9a, ADR-0141), for a
 * holder of `group.view`. Viewing writes nothing. A holder of `group.manage`
 * creates a group; the route answers with a code this page turns into a fixed
 * sentence.
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
                        {member.name}
                        {member.email === null ? null : ` · ${member.email}`} · {ROLE_NAMES[member.role]}
                      </li>
                    ))}
                  </ul>
                ) : null}
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
