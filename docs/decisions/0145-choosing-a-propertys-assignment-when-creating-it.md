# ADR-0145 — Choosing a Property's responsible user and group when creating it

Status: Accepted (AT-10b, 2026-11-15). Second and last part of AT-10 in the
accounts-and-team plan, which the product owner approved on 2026-11-09
(`/mnt/project-files/cto/accounts-team-proposal.md`): "Property assignment on
the Property page". AT-10a (ADR-0144) lets an `OWNER` or `ADMIN` change an
existing Property's assignments; AT-10b lets a member choose them when
creating one.

Builds on: ADR-0052 Decisions 10 and 11 (a `MANAGER`'s and a `CREATOR`'s
creation-time assignments are fixed by role), ADR-0062 (`PropertyService.create`
decides a new Property's assignments by its creator's role, and audits a
refusal), ADR-0064 (what each role reaches) and ADR-0144 (the choices offered,
the 64-character id bound, `details.reason`).

## Context

`PropertyService.create` has taken a responsible user and a group since Phase
6H, but the home page's "Add a property" form sent neither. So:
- an `OWNER` or `ADMIN` could only create an unassigned Property, and then
  assign it on its page (AT-10a);
- a `MANAGER` in one group got that group, but **a `MANAGER` in several groups
  could not create a Property at all**: the service asks which group, and the
  form had no way to say;
- a `VIEWER` was shown the form, which the service always refused.

This ADR adds no rule about who may choose what. Every refusal and every
effect is `PropertyService.create`'s, as built.

---

## Decision 1 — What a member may choose, by role

`PropertyService.creationChoices` is new. It answers what `create` would
accept, by the member's role:

| Member | Answer | `create` then |
| --- | --- | --- |
| `OWNER`, `ADMIN` | `ANY`: the members who may be chosen (any but a `BILLING` one, in the members page's order) and the organization's groups | either, both or neither, as chosen |
| `MANAGER` | `OWN_GROUP`: its own groups, by name; none if it is in none | the `MANAGER` is responsible, and the Property is in the group chosen |
| `CREATOR` | `SELF` | the `CREATOR` is responsible, in no group |
| without `property.create` (`VIEWER`, `BILLING`) | nothing | refuses |

It writes nothing and audits nothing. A member's address is shown only to a
viewer holding `member.view`, as in ADR-0144; an `OWNER` and `ADMIN` hold it
by template. The members list is the one AT-10a's form offers, less the
current responsible user a new Property does not have.

## Decision 2 — The "Add a property" form, by role

The home page's form keeps its fields and adds, by Decision 1:
- **`OWNER`, `ADMIN`**: a **Responsible user** list and a **Group** list, each
  starting at "None", which keeps today's unassigned Property; and the
  sentence the Property page uses about what each assignment reaches;
- **`MANAGER`**: "You will be responsible for this property." and a required
  **Group** list of its own groups. With one group, it is already chosen. With
  several, the list starts at "Choose one of your groups", which cannot be
  sent;
- **`MANAGER` in no group**: no form, and a sentence saying why: a Manager's
  properties belong to one of their groups, and an Owner or Admin can add them
  to one;
- **`CREATOR`**: "You will be responsible for this property. It will belong to
  no group.";
- **anyone without `property.create`**: no form.

## Decision 3 — The create route

`POST /api/properties` now:
1. refuses a post whose `Origin` is not this site with `403`, before reading
   anything, as every form route added since ADR-0068 does;
2. reads `responsibleUserId` and `groupId`, each **empty for none chosen**: an
   empty field is not passed to `create`, so the service decides as before;
3. answers an id longer than 64 characters before asking the service, with
   the sentence the service gives for a member or group that is not this
   organization's, so it never reaches the audit log (ADR-0144 Decision 5).

Its answers are otherwise unchanged: `303` to the new Property's page, or
`303` to the home page with the error's sentence. The home page already shows
those sentences for this route and others; none of them names a member or a
group.

## Decision 4 — The home page no longer fails for a `BILLING` member

The home page listed each organization's Properties with
`PropertyService.list`, which needs `property.view`. A `BILLING` member does
not hold it, so since an `OWNER` could invite one (AT-6, AT-7) or make a
member one (AT-8a), the home page failed for them, including right after
accepting an invitation. For such an organization the page now says "Your
role does not include Properties." and offers no form. `PropertyService.list`
and `GET /api/properties` are unchanged.

## Consequences

- No migration, permission or audit action. A Property created with an
  assignment records it in `property.created`, as the service always did.
- A `MANAGER` in several groups can create a Property from the product.
- Phase 6H's shape test now checks that the create route passes only the
  assignment the form chose, an empty field none.
- A browser test creates a group, then a Property with its owner responsible
  and in that group.

## Not decided here

- Showing a Property's assignment to anyone but an `OWNER` or `ADMIN`
  (ADR-0144).
- Keeping what was typed in the form when it is refused: the home page shows
  the error and an empty form, as before.
