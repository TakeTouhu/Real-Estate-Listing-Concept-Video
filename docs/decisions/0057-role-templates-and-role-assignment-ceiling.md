# ADR-0057 — The role templates, the permission matrix and the role-assignment ceiling

Status: Accepted (Phase 6C)
Implements: ADR-0052 Decision 10 (template-to-permission matrix, role-fixed
Scope, role-assignment ceiling, no self-escalation, last `OWNER`) and Decision 2
(no `REVIEWER`; source-photo review is `analysis.review`). First of the
authorization packages; grants, groups and row Scope follow.

## Context

ADR-0052 approved six role templates, 27 permissions and a grant ceiling. The
code still carried the model it replaced: `OWNER`, `ADMIN`, `CREATOR`,
`REVIEWER`, and five permissions (`org:manage`, `member:read`, `member:manage`,
`property:write`, `video:review`). Two consequences forced this package ahead of
the remaining billing work:

- ADR-0053 Decision 5A gates every commercial mutation — Unit purchase,
  cancellation, plan change, seats, storage — on `billing.manage`, which did not
  exist.
- `MembershipService` checked only `member:manage` before inviting, changing a
  role or removing a member, so an `ADMIN` could invite an `OWNER`, promote
  itself to `OWNER`, or remove one. No HTTP route reached those methods, so this
  was latent, but ADR-0052 is explicit that no role may escalate itself past its
  ceiling by any route.

---

## Decision 1 — The six templates and the matrix, as approved

`Role` is `OWNER | ADMIN | MANAGER | CREATOR | VIEWER | BILLING`; `Permission` is
the ADR-0052 list of 27 dotted names. Each template's grant list is the ADR
matrix, exhaustively: what a template does not list it does not grant.
`disclosure.none` and `video.share` are granted by no template.

Until individual grants and group permissions exist (later packages), a
member's effective permissions are exactly its template's. Each template's
Scope (`ORGANIZATION`, `GROUP`, `OWN`) is recorded as data by `scopeForRole`;
row-level enforcement is a later package.

The matrix is pinned cell for cell by a test that transcribes the ADR table row
by row, independently of how the implementation groups grants.

## Decision 2 — The role-assignment ceiling on every membership path

`mayAssignRole(actor, role)`: an `OWNER` may assign any role; an `ADMIN` only
`MANAGER`, `CREATOR` and `VIEWER`; every other template nothing. It is asked of
every role a change touches:

| Path | Needs | Ceiling asked of |
| --- | --- | --- |
| Invite | `member.manage` | the invited role |
| Accept an invitation | the **inviter's** current membership, with `member.manage` | the invited role, against the inviter's role *now* |
| Change a role | `permission.manage` | the member's current role **and** the new one |
| Remove a member | `member.manage` | the member's current role |

So an `ADMIN` can neither promote to nor demote from `OWNER`, `ADMIN` or
`BILLING`, cannot remove a member holding one, and cannot change its own role.
The last-`OWNER` invariant is unchanged and checked after the ceiling.

**Acceptance re-asks the ceiling.** Acceptance is where the role is actually
granted, so an invitation whose inviter has since lost the authority to assign
that role — demoted, or no longer a member — is refused. The ADR requires the
ceiling on every grant path; an invitation is one that outlives the moment it was
checked.

**Every refusal of a member is audited** as `member.role_change_refused`, with
the operation, the actor's role, the target and the roles involved. A non-member
is refused as any other organization access is and writes nothing into that
organization's audit trail. A role change and an invitation acceptance record the
**resulting fixed Scope**, as ADR-0052 requires of a role change.

## Decision 3 — `REVIEWER` becomes `VIEWER`

Migration 19 recreates the `Role` type (PostgreSQL cannot drop an enum value) and
maps every `REVIEWER` membership and invitation to `VIEWER`. ADR-0052 removes
`REVIEWER` but does not say what an existing one becomes; `VIEWER` is the
least-privileged template that keeps what a reviewer could see. A `REVIEWER`
could review source photos; a `VIEWER` cannot, and an `OWNER` or `ADMIN` who
wants that member to keep reviewing changes the role. No production customer
exists, so only development and test data is affected. Recorded in
`docs/decisions/TODO.md` as a choice the ADR did not make.

Any other value fails the cast and aborts the migration instead of being guessed.

## Decision 4 — Each existing check moves to one specific permission

Reads now check a view permission too, so a `BILLING` member, which holds no
Property-content permission, reads no Property content.

| Action | Before | After |
| --- | --- | --- |
| Create / edit / delete a Property | `property:write` | `property.create` / `property.edit` / `property.delete` |
| List or read Properties, assets, analyses; an asset download URL | membership | `property.view` |
| Request, complete or retry an upload; start or refresh an analysis | `property:write` | `asset.upload` |
| Request an asset's deletion | `property:write` | `asset.delete` |
| Approve, reject or correct an analysis | `video:review` | `analysis.review` |
| Create a video project; compose its storyboard | `property:write` | `video.generate` |
| Read a storyboard; list video projects | membership | `video.view` |
| Start a scene generation | `property:write` | `video.generate` **and** `unit.consume` |
| List members | `member:read` | `member.view` |

ADR-0052 names no permission for creating a video project, composing a
storyboard or starting an analysis. They are mapped to the permission of the act
they prepare — generation, and ingesting an uploaded photo — rather than to
review, which is a separate human decision. Under the six templates every choice
here has the same holders as the alternatives (`OWNER`, `ADMIN`, `MANAGER`,
`CREATOR`), so no member's access changes because of the choice; it matters only
once individual grants exist, and is recorded in `TODO.md` for confirmation.

`unit.consume` is an independent permission (ADR-0052 Decision 10), and starting
a scene spends the organization's Units, so it is required alongside
`video.generate`. No template separates the two today.

## Consequences

- `CREATOR` and `MANAGER` may now review source photos (`analysis.review`), as
  the matrix grants; `VIEWER` and `BILLING` may not.
- `BILLING` is refused every Property, asset, analysis and storyboard read.
- Nothing commercial is built. `billing.manage` exists and is held by `OWNER` and
  `BILLING`, ready for the commercial packages to require.
- **Row Scope is not enforced.** Every role still reaches every Property of its
  organization, as `CREATOR` already did. `MANAGER`'s `GROUP` and `CREATOR`'s and
  `VIEWER`'s `OWN` Scope arrive with the Property-assignment package.
- No member-management HTTP route or page exists; the ceiling closes paths before
  one is built.

## Not decided here

Individual permission grants and their protected authority (`permission.manage`,
`billing.manage` and `disclosure.none` are `OWNER`-only); groups and group
permissions; Property-rooted Scope; MFA enforcement for `billing.manage` holders.
