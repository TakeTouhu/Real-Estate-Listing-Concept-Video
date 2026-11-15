# ADR-0144 — Changing a Property's responsible user and group on its page

Status: Accepted (AT-10a, 2026-11-15). First part of AT-10 in the
accounts-and-team plan, which the product owner approved on 2026-11-09
(`/mnt/project-files/cto/accounts-team-proposal.md`): "Property assignment on
the Property page". AT-10a lets an `OWNER` or `ADMIN` change an existing
Property's assignments; AT-10b lets a member choose them when creating one.

Builds on: ADR-0052 Decision 10 (the Property is the authorization root; only
`OWNER` and `ADMIN` change an assignment), ADR-0062 (`PropertyService.assign`:
its role check, validation, compare-and-set and audit), ADR-0064 (what each
role reaches), ADR-0139 (a form carries what the page showed) and ADR-0141 to
ADR-0143 (the groups page's codes and id bounds).

## Context

`PropertyService.assign` has existed since Phase 6H. No page or route called
it, so every Property stayed unassigned. Since AT-7 a colleague can join an
organization, and since AT-9c a `MANAGER` can be put in a group. But a
`MANAGER` reaches only the Properties of its groups, and a `CREATOR` or
`VIEWER` only those it is responsible for (ADR-0064), so with no assignment
none of them reaches any Property. This ADR lets an `OWNER` or `ADMIN` change
both assignments from the Property page. It adds no rule about who may assign
what: every refusal and every effect is the Property service's, as built.

---

## Decision 1 — Only an `OWNER` or `ADMIN` sees the assignment

`PropertyService.assignmentChoices` is new. For an `OWNER` or `ADMIN` it gives:
- the Property's current responsible user and group;
- the members who may be chosen as the responsible user: any member but a
  `BILLING` one, as creation and reassignment allow (ADR-0062), in the members
  page's order. The current responsible user is always among them, whatever
  their role now, so the form can keep them (a role change does not rewrite an
  assignment);
- the organization's groups, by name.

For anyone else it gives nothing, and the Property page shows them nothing
new. It reads the Property as `get` does, writes nothing and audits nothing.
A member's address is shown only to a viewer holding `member.view`, as on the
members and groups pages; an `OWNER` and `ADMIN` hold it by template.

## Decision 2 — A form on the Property page

For an `OWNER` or `ADMIN`, the Property page says who is responsible for the
Property and which group it belongs to, each "None" when unset, and what that
means: a `MANAGER` reaches the Properties of the groups they belong to, and a
`CREATOR` or `VIEWER` the Properties they are responsible for.

A closed **Change assignment…** form follows. It has two lists, each showing
the current choice first selected:
- **Responsible user**: "None", then the members of Decision 1, each as its
  name, address (where shown) and role;
- **Group**: "None", then the groups.

It also carries the assignment the page showed. Its post is
`POST /api/organizations/{id}/properties/{propertyId}/assignment`, with the
fields `responsibleUserId`, `groupId`, `shownResponsibleUserId` and
`shownGroupId`, each empty for "None".

## Decision 3 — A change is judged against the assignment shown

`PropertyService.assign` now also takes the assignment the page showed. If the
Property's assignment is no longer that, nothing is written and the page says
it changed meanwhile, as a role change does when the role is no longer the one
shown (ADR-0139). Without this, saving a form that changes only the group
would silently undo a responsible user someone else had just chosen.

Everything else is as ADR-0062 Decision 3 built it:
1. the `OWNER` or `ADMIN` role, not a permission: anyone else is refused and
   audited (`property.assignment_refused`, `reassignment_role`) before the
   Property is looked up;
2. the Property, of this organization and not deleted;
3. the assignment shown;
4. only a new choice is checked: a responsible user who is a member and not
   `BILLING`, and a group of this organization;
5. a change that changes nothing writes nothing, and the page says so;
6. the write applies only while the assignment is still the one checked
   (compare-and-set), and `property.assignment_changed` records the actor's
   role and the previous and new responsible user and group.

Without the shown assignment, `assign` keeps its existing behaviour.

## Decision 4 — A refused choice says which

The Property service answered three different problems with
`VALIDATION_FAILED`, told apart only by their messages. Each now carries
`details.reason`; the type is `PropertyAssignmentProblem`:
- `RESPONSIBLE_USER`: the chosen responsible user is not a member of this
  organization, or is a `BILLING` member;
- `GROUP`: the chosen group is not a group of this organization;
- `STALE`: the assignment changed meanwhile, whether found before the write
  (Decision 3) or by the compare-and-set.

Codes, messages and audit entries do not change. A `MANAGER` in several groups
that names none at creation keeps its reason-less `VALIDATION_FAILED` until
AT-10b offers the choice.

## Decision 5 — Codes, and ids from the form and the address

The route refuses a post whose `Origin` is not this site with `403` before
anything is read, and sends a signed-out visitor to `/login`. Every other
answer is `303` to `/properties/{propertyId}` with exactly one code:

| Code | When |
| --- | --- |
| `notice=assignment-saved` | changed (`property.assignment_changed`) |
| `notice=assignment-unchanged` | the choice was the assignment shown: nothing written |
| `error=property-gone` | `NOT_FOUND`, or a Property id longer than 64 characters |
| `error=responsible-user-gone` | `RESPONSIBLE_USER`, or a member id longer than 64 characters |
| `error=assignment-group-gone` | `GROUP`, or a group id longer than 64 characters |
| `error=assignment-changed` | `STALE` |
| `error=may-not-assign` | `FORBIDDEN`: not an `OWNER` or `ADMIN` |
| `error=assign-failed` | anything else |

A Property the visitor no longer reaches is answered by the Property page as
before: it sends them home with "Property not found".

**An id longer than 64 characters is answered before the service is asked.**
A refused change is audited with the Property and the requested responsible
user and group, so each is bounded as a group's and a member's id are
(ADR-0142, ADR-0143). An id this product made is at most 20 characters.

Names never go into the address or the log. A failure that is not a refusal
is logged with the error's code alone.

## Consequences

- One route and one form are new. There is no migration, permission or audit
  action.
- Phase 6H's dormancy test now allows `properties.assign(` from
  `apps/web/src/lib/property-assignment.ts` only. The create route still
  passes no assignment until AT-10b.
- A browser test creates a group and a Property, assigns the Property to the
  group and its owner, and then deletes the group, after which the Property
  page shows it ungrouped (ADR-0062 Decision 4).

## Not decided here

- Choosing the responsible user and group when creating a Property (AT-10b).
  Until then, a `MANAGER` in several groups cannot create one from the product.
- Showing a Property's assignment to anyone but an `OWNER` or `ADMIN`.
