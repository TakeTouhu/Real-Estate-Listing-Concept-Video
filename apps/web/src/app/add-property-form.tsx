import { PROPERTY_TYPES, type PropertyCreationChoices } from "@app/domain";
import { memberLine } from "@/lib/role-names";

/**
 * The home page's "Add a property" form for one organization, with what the
 * member's role lets it choose for the new Property (AT-10b, ADR-0145). A
 * `MANAGER` in no group is told why it cannot add one instead.
 */
export function AddPropertyForm({
  organizationId,
  choices,
}: {
  organizationId: string;
  choices: PropertyCreationChoices;
}) {
  if (choices.kind === "OWN_GROUP" && choices.groups.length === 0) {
    return (
      <p className="muted">
        You cannot add a property yet: a Manager&apos;s properties belong to one of their groups, and you belong to
        none. An Owner or Admin can add you to a group.
      </p>
    );
  }
  const id = (field: string) => `${field}-${organizationId}`;
  return (
    <details>
      <summary>Add a property</summary>
      <form method="post" action="/api/properties">
        <input type="hidden" name="organizationId" value={organizationId} />
        <label className="field" htmlFor={id("name")}>
          Property name
        </label>
        <input id={id("name")} name="name" type="text" required />

        <label className="field" htmlFor={id("type")}>
          Property type
        </label>
        <select id={id("type")} name="propertyType" defaultValue="APARTMENT">
          {PROPERTY_TYPES.map((type) => (
            <option key={type} value={type}>
              {type}
            </option>
          ))}
        </select>

        <label className="field" htmlFor={id("addr")}>
          Area or masked address <span className="muted">(optional)</span>
        </label>
        <input id={id("addr")} name="addressMasked" type="text" />

        <label className="field" htmlFor={id("desc")}>
          Description <span className="muted">(optional)</span>
        </label>
        <input id={id("desc")} name="description" type="text" />

        <AssignmentFields id={id} choices={choices} />

        <label className="field checkbox">
          <input type="checkbox" name="rightsConfirmed" value="yes" required /> I own or have
          licensed the photos I will upload for this property.
        </label>
        <p className="field">
          <button type="submit">Create property</button>
        </p>
      </form>
    </details>
  );
}

/**
 * The new Property's responsible user and group: an `OWNER` or `ADMIN`
 * chooses either, both or neither; a `MANAGER` is responsible for it and
 * chooses one of its own groups, its only one already chosen; a `CREATOR` is
 * responsible for it, in no group.
 */
function AssignmentFields({ id, choices }: { id: (field: string) => string; choices: PropertyCreationChoices }) {
  if (choices.kind === "SELF") {
    return <p className="muted">You will be responsible for this property. It will belong to no group.</p>;
  }
  const groupOptions = choices.groups.map((group) => (
    <option key={group.id} value={group.id}>
      {group.name}
    </option>
  ));
  if (choices.kind === "OWN_GROUP") {
    const several = choices.groups.length > 1;
    return (
      <>
        <p className="muted">You will be responsible for this property.</p>
        <label className="field" htmlFor={id("group")}>
          Group
        </label>
        <select id={id("group")} name="groupId" required defaultValue={several ? "" : choices.groups[0]?.id}>
          {several ? (
            <option value="" disabled>
              Choose one of your groups
            </option>
          ) : null}
          {groupOptions}
        </select>
      </>
    );
  }
  return (
    <>
      <label className="field" htmlFor={id("responsible")}>
        Responsible user <span className="muted">(optional)</span>
      </label>
      <select id={id("responsible")} name="responsibleUserId" defaultValue="">
        <option value="">None</option>
        {choices.members.map((member) => (
          <option key={member.userId} value={member.userId}>
            {memberLine(member)}
          </option>
        ))}
      </select>
      <label className="field" htmlFor={id("group")}>
        Group <span className="muted">(optional)</span>
      </label>
      <select id={id("group")} name="groupId" defaultValue="">
        <option value="">None</option>
        {groupOptions}
      </select>
      <p className="muted">
        A Manager reaches the Properties of the groups they belong to, and a Creator or Viewer the Properties they
        are responsible for.
      </p>
    </>
  );
}
