import type { AssignableMember, PropertyAssignmentChoices } from "@app/domain";
import { ROLE_NAMES } from "@/lib/role-names";

/** A member as the lists name them: name, address where shown, and role. */
function memberLine(member: AssignableMember): string {
  return `${member.name}${member.email === null ? "" : ` · ${member.email}`} · ${ROLE_NAMES[member.role]}`;
}

/**
 * A Property's responsible user and group, and the closed form that changes
 * them, for an `OWNER` or `ADMIN` (AT-10a, ADR-0144). The form carries the
 * assignment shown, so a change someone made meanwhile is never undone.
 */
export function AssignmentSection({
  organizationId,
  propertyId,
  choices,
}: {
  organizationId: string;
  propertyId: string;
  choices: PropertyAssignmentChoices;
}) {
  const responsible = choices.members.find(({ userId }) => userId === choices.responsibleUserId);
  const group = choices.groups.find(({ id }) => id === choices.groupId);
  const action =
    `/api/organizations/${encodeURIComponent(organizationId)}` +
    `/properties/${encodeURIComponent(propertyId)}/assignment`;
  return (
    <div className="card">
      <h2>Assignment</h2>
      <p>Responsible user: {responsible ? memberLine(responsible) : "None"}</p>
      <p>Group: {group ? group.name : "None"}</p>
      <p className="muted">
        A Manager reaches the Properties of the groups they belong to, and a Creator or Viewer the Properties
        they are responsible for.
      </p>
      <details>
        <summary>Change assignment…</summary>
        <form method="post" action={action}>
          <input type="hidden" name="shownResponsibleUserId" value={choices.responsibleUserId ?? ""} />
          <input type="hidden" name="shownGroupId" value={choices.groupId ?? ""} />
          <label className="field" htmlFor="assign-responsible">
            Responsible user
          </label>
          <select id="assign-responsible" name="responsibleUserId" defaultValue={choices.responsibleUserId ?? ""}>
            <option value="">None</option>
            {choices.members.map((member) => (
              <option key={member.userId} value={member.userId}>
                {memberLine(member)}
              </option>
            ))}
          </select>
          <label className="field" htmlFor="assign-group">
            Group
          </label>
          <select id="assign-group" name="groupId" defaultValue={choices.groupId ?? ""}>
            <option value="">None</option>
            {choices.groups.map(({ id, name }) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
          <p className="field">
            <button type="submit">Save assignment</button>
          </p>
        </form>
      </details>
    </div>
  );
}
