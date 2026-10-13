# ADR-0058 — Individual permission grants and the grant ceiling

Status: Accepted (Phase 6D)
Implements: ADR-0052 Decision 10 (*individual permissions*, *grant ceilings and
protected authority*, *no self-escalation past the ceiling*, *`disclosure.none` —
protected and individual-only*, *`property.create` capability ceiling*) and
ADR-0053 Decision 5A (an `ADMIN` holds `billing.manage` only by an explicit
`OWNER` grant). Second of the authorization packages, after ADR-0057; groups and
row Scope follow.

## Context

After Phase 6C a member's permissions were exactly its role template's. ADR-0052
adds individual grants on top, and two later packages cannot exist without
them: an organization cannot let its `ADMIN` buy Units (ADR-0053 Decision 5A),
and Mode C cannot be authorized at all, because `disclosure.none` is carried by
no template.

---

## Decision 1 — A durable grant per member and permission

Migration 20 adds `member_permission_grants`. Each row records the
organization, the user, the permission, the granting user and the time. The
primary key is (organization, user, permission), so a member holds a permission
by grant at most once. A CHECK admits exactly the grantable vocabulary: the 27
ADR-0052 permissions except `video.share`, which is reserved (ADR-0052 Decision
12). The foreign key to the membership cascades, so removing a member removes
their grants. A revocation deletes the row, and the audit log keeps the history.

`grantedByUserId` has no foreign key, like `invitations.invitedByUserId`. It is
attribution, not authority.

## Decision 2 — Effective permissions

A member's **effective permissions** are its template's plus its individual
grants. Grants add up and there is no DENY. `property.create` is a ceiling on
the recipient's role, so it is **never** effective for a `VIEWER` or `BILLING`
member, however it was granted.

`authorizeOrganization` checks effective permissions and returns them on the
auth context. Every existing permission check therefore honours grants without
changes at its call site. That covers the Property, asset, analysis,
storyboard and generation services. It also covers the membership paths of
ADR-0057, including the inviter's standing when an invitation is accepted. The
web pages that show or hide controls (review board, video-project create,
storyboard compose) read the same effective set from the organization list, so
a page never hides what the API allows.

A grant answers *what* a member may do, never *which* rows: Scope stays fixed by
role.

## Decision 3 — The grant ceiling

Granting or revoking needs the actor's effective `permission.manage`. Then
`grantRefusal` answers, in order:

| Refusal | When |
| --- | --- |
| `not_grantable` | the permission is `video.share` (or not in the vocabulary) |
| `target_role` | the actor may not manage the target's role (`mayAssignRole`, ADR-0057): an `ADMIN` reaches only `MANAGER`, `CREATOR` and `VIEWER` members, so never itself; every other non-`OWNER` reaches no one |
| `protected` | a non-`OWNER` grants or revokes `permission.manage`, `billing.manage` or `disclosure.none` |
| `not_held` | a non-`OWNER` grants or revokes a permission it does not effectively hold |
| `recipient_ceiling` | `property.create` is granted to a `VIEWER` or `BILLING` member |

So:
- an `ADMIN` cannot give itself `billing.manage` or `permission.manage`;
- an `ADMIN` cannot give or take `disclosure.none` from anyone;
- a `MANAGER` that an `OWNER` granted `permission.manage` can grant to no one.

An `OWNER` may grant `disclosure.none` to itself, as ADR-0052 allows. A revocation
asks the same ceiling, except that `property.create` may be taken back from a
`VIEWER` or `BILLING` member whose grant predates a role change.

**Every refusal of a member is audited** as `permission.grant_refused`, with the
operation, the reason, the actor's role, the target and its role, and the
permission. A member without `permission.manage` is refused before the target is
read (target role `null`). A non-member is refused like any other organization
access and writes nothing into that organization's audit trail. A grant records
`permission.granted` and a revocation `permission.revoked`, each with the target
and its role, **in the same database transaction as the change**. A crash or a
failed audit write therefore leaves neither, and a permission never becomes
effective, or stops being so, unrecorded.

A grant the member already holds changes nothing: no second row and no second
audit entry, including when concurrent grants race. Revoking a grant that does
not exist is `NOT_FOUND`, and of concurrent revocations exactly one succeeds and
is audited.

**A concurrent change between the ceiling and the write.** The ceiling is judged
on the memberships and grants as read. The grant and its audit entry are written
in a separate transaction. Suppose a role change, a demotion of the actor or a
revocation of the actor's own grant commits in between. It does not undo the
grant: the result is the same as if the grant had committed just before that
change. The ceiling allowed the grant at that point, and a grant survives a later
role change (Decision 4). The audit entry records the target's role as it was
read. Locking both memberships inside the write transaction would only reorder
such a race, not change what it can end in, so it is not done. A target removed
in between cannot receive the grant, because the membership foreign key refuses
the row.

## Decision 4 — Choices ADR-0052 does not make

Recorded in `docs/decisions/TODO.md` for confirmation:

1. **A non-`OWNER` delegates only what it effectively holds.** The ADR bounds a
   grant "by the granting actor's ceiling" without listing it. An `ADMIN` holds
   every non-protected grantable permission, so this changes nothing today.
2. **Grants survive a role change**, as Property assignments do ("a role change
   does not rewrite Property assignments"). Effective permissions recompute from
   the new role, with the `property.create` ceiling applied. Clearing grants on
   every role change would silently drop an `OWNER`'s deliberate grant.
3. **Granting `property.create` to a `VIEWER` or `BILLING` member is refused** at
   grant time, not stored as an ineffective row.
4. A repeated grant is a no-op; revoking an absent grant is `NOT_FOUND`.

## Consequences

- `billing.manage` can now reach an `ADMIN`, and `disclosure.none` anyone, but
  only through an `OWNER`.
- No route or page grants or revokes; the service is dormant. Mode C is not
  built, so `disclosure.none` authorizes nothing yet.
- **MFA is not built** at all. ADR-0052 makes it mandatory for every holder of
  `permission.manage` or `billing.manage`, so it must exist before any
  member-management or grant UI ships.
- One extra read (the member's grants) per authorization.
- The repository, not the service, writes a grant change's audit entry, because
  only it can put both in one transaction. The Phase 6C membership changes do
  not do this yet; that is recorded in `TODO.md`.

## Not decided here

Groups and group permissions (no group may carry `disclosure.none`);
Property-rooted row Scope; MFA; Mode C admission.
