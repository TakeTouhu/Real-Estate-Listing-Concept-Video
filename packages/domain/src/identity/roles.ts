/**
 * The standard role templates and the permission matrix (ADR-0052 Decision 10,
 * Phase 6C), the individual-grant ceiling on top of them (Phase 6D), and the
 * same ceiling on what a group carries (Phase 6G).
 *
 * Each template's grant list is exhaustive: a permission a template does not
 * list, it does not grant. A member's effective permissions are its template's,
 * its individual grants and its groups' permissions.
 */

export type Role = "OWNER" | "ADMIN" | "MANAGER" | "CREATOR" | "VIEWER" | "BILLING";

export const ROLES: readonly Role[] = ["OWNER", "ADMIN", "MANAGER", "CREATOR", "VIEWER", "BILLING"];

export const PERMISSIONS = [
  "organization.view",
  "organization.manage",
  "member.view",
  "member.manage",
  "group.view",
  "group.manage",
  "permission.manage",
  "property.view",
  "property.create",
  "property.edit",
  "property.delete",
  "asset.upload",
  "asset.delete",
  "analysis.review",
  "video.view",
  "video.generate",
  "video.regenerate",
  "video.download",
  "disclosure.change",
  "disclosure.none",
  "unit.consume",
  "unit.view",
  "billing.view",
  "billing.manage",
  "audit.view",
  "audit.export",
  "video.share",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/**
 * What a member's reach over Property-rooted content is evaluated against. Fixed
 * by role: there is no standalone Scope change, only a role change. Turned into
 * a member's reach of Properties by `reachOf` (Phase 6I).
 */
export type Scope = "ORGANIZATION" | "GROUP" | "OWN";

const ROLE_SCOPE: Record<Role, Scope> = {
  OWNER: "ORGANIZATION",
  ADMIN: "ORGANIZATION",
  MANAGER: "GROUP",
  CREATOR: "OWN",
  VIEWER: "OWN",
  BILLING: "ORGANIZATION",
};

/** Granted to every content-working template: OWNER, ADMIN, MANAGER, CREATOR. */
const CONTENT_WORK: readonly Permission[] = [
  "property.view",
  "property.create",
  "property.edit",
  "property.delete",
  "asset.upload",
  "asset.delete",
  "analysis.review",
  "video.view",
  "video.generate",
  "video.regenerate",
  "video.download",
  "disclosure.change",
  "unit.consume",
  "unit.view",
];

/**
 * The approved matrix. `disclosure.none` and `video.share` are granted by no
 * template: the first only ever by an explicit `OWNER` grant to an individual,
 * the second not at all in the initial release.
 */
const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  OWNER: [
    "organization.view",
    "organization.manage",
    "member.view",
    "member.manage",
    "group.view",
    "group.manage",
    "permission.manage",
    ...CONTENT_WORK,
    "billing.view",
    "billing.manage",
    "audit.view",
    "audit.export",
  ],
  ADMIN: [
    "organization.view",
    "organization.manage",
    "member.view",
    "member.manage",
    "group.view",
    "group.manage",
    "permission.manage",
    ...CONTENT_WORK,
    "billing.view",
    "audit.view",
    "audit.export",
  ],
  MANAGER: ["organization.view", "member.view", "group.view", ...CONTENT_WORK],
  CREATOR: ["organization.view", ...CONTENT_WORK],
  VIEWER: ["organization.view", "property.view", "video.view", "video.download"],
  BILLING: ["organization.view", "member.view", "unit.view", "billing.view", "billing.manage"],
};

export function hasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

export function scopeForRole(role: Role): Scope {
  return ROLE_SCOPE[role];
}

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

/** Roles only an `OWNER` may assign, remove, or change a member to or from. */
const OWNER_ONLY_ROLES: readonly Role[] = ["OWNER", "ADMIN", "BILLING"];

/**
 * The role-assignment ceiling: may a member holding `actorRole` give a member
 * `role`, or take it away?
 *
 * `OWNER` may assign any role; `ADMIN` only `MANAGER`, `CREATOR` and `VIEWER`;
 * every other template nothing. Asked of both ends of a change — the role a
 * member has and the role it is given — so an `ADMIN` can neither promote to nor
 * demote from a protected role, nor change its own. The last-`OWNER` invariant is
 * checked separately, against the organization's members.
 */
export function mayAssignRole(actorRole: Role, role: Role): boolean {
  if (actorRole === "OWNER") return true;
  if (actorRole === "ADMIN") return !OWNER_ONLY_ROLES.includes(role);
  return false;
}

/** `video.share` is reserved for after the initial release and never granted. */
export const GRANTABLE_PERMISSIONS: readonly Permission[] = PERMISSIONS.filter(
  (permission) => permission !== "video.share",
);

/** Only an `OWNER` may grant or revoke these (ADR-0052 Decision 10, protected authority). */
export const PROTECTED_PERMISSIONS: readonly Permission[] = [
  "permission.manage",
  "billing.manage",
  "disclosure.none",
];

/**
 * What a group may carry: the grantable vocabulary less `disclosure.none`, which
 * only an `OWNER` grants and only to an individual (ADR-0052 Decision 10).
 */
export const GROUP_GRANTABLE_PERMISSIONS: readonly Permission[] = GRANTABLE_PERMISSIONS.filter(
  (permission) => permission !== "disclosure.none",
);

/** Roles for which `property.create` never becomes effective, from any grant source. */
const CANNOT_CREATE_PROPERTY: readonly Role[] = ["VIEWER", "BILLING"];

export function isPermission(value: unknown): value is Permission {
  return typeof value === "string" && (PERMISSIONS as readonly string[]).includes(value);
}

/**
 * What a member may actually do: its template's permissions, its individual
 * grants and the permissions of its groups, in vocabulary order. They add up —
 * there is no DENY — but a group confers nothing outside what a group may
 * carry, whatever is stored, and `property.create` is a ceiling on the
 * recipient's role, so it is never effective for a `VIEWER` or `BILLING` member,
 * however it was granted.
 */
export function effectivePermissions(
  role: Role,
  granted: readonly Permission[],
  fromGroups: readonly Permission[] = [],
): readonly Permission[] {
  return PERMISSIONS.filter(
    (permission) =>
      (ROLE_PERMISSIONS[role].includes(permission) ||
        granted.includes(permission) ||
        (fromGroups.includes(permission) && GROUP_GRANTABLE_PERMISSIONS.includes(permission))) &&
      !(permission === "property.create" && CANNOT_CREATE_PROPERTY.includes(role)),
  );
}

/** Why a grant or revocation is refused; `null` when it is allowed. */
export type GrantRefusal = "not_grantable" | "target_role" | "protected" | "not_held" | "recipient_ceiling";

/**
 * The individual-grant ceiling (ADR-0052 Decision 10): may a member holding
 * `actorRole` and `actorPermissions` grant `permission` to, or revoke it from, a
 * member holding `targetRole`? The caller has already required
 * `permission.manage`.
 *
 * - The actor must be able to manage the target's role at all (`mayAssignRole`),
 *   so an `ADMIN` grants only to `MANAGER`, `CREATOR` and `VIEWER` members and
 *   never to itself.
 * - `permission.manage`, `billing.manage` and `disclosure.none` are `OWNER`-only.
 * - Anyone else delegates only what it effectively holds.
 * - `property.create` is never granted to a `VIEWER` or `BILLING` member; it can
 *   still be revoked from one, should a grant predate a role change.
 */
export function grantRefusal(
  operation: "grant" | "revoke",
  actorRole: Role,
  actorPermissions: readonly Permission[],
  targetRole: Role,
  permission: Permission,
): GrantRefusal | null {
  if (!GRANTABLE_PERMISSIONS.includes(permission)) return "not_grantable";
  if (!mayAssignRole(actorRole, targetRole)) return "target_role";
  const delegation = delegationRefusal(actorRole, actorPermissions, permission);
  if (delegation !== null) return delegation;
  if (operation === "grant" && permission === "property.create" && CANNOT_CREATE_PROPERTY.includes(targetRole)) {
    return "recipient_ceiling";
  }
  return null;
}

/** `permission.manage`, `billing.manage` and `disclosure.none` are `OWNER`-only; anyone else delegates only what it holds. */
function delegationRefusal(
  actorRole: Role,
  actorPermissions: readonly Permission[],
  permission: Permission,
): "protected" | "not_held" | null {
  if (actorRole === "OWNER") return null;
  if (PROTECTED_PERMISSIONS.includes(permission)) return "protected";
  if (!actorPermissions.includes(permission)) return "not_held";
  return null;
}

/** Why the actor may not give a group a permission, or take it away; `null` when it may. */
export type GroupGrantRefusal = "not_grantable" | "protected" | "not_held";

/**
 * The grant ceiling on a group's permission, as far as it concerns the actor
 * alone: may a member holding `actorRole` and `actorPermissions` give a group
 * `permission`, or take it away? `disclosure.none` and `video.share` are never
 * on a group; otherwise as `grantRefusal`. The ceiling's other half, whether the
 * actor may manage the role of each member the change reaches, is asked of the
 * group's members as the change commits (ADR-0061).
 *
 * `property.create` is no refusal here: a group may carry it for its `MANAGER`
 * and `CREATOR` members, and for its `VIEWER` and `BILLING` members it is never
 * effective.
 */
export function groupGrantRefusal(
  actorRole: Role,
  actorPermissions: readonly Permission[],
  permission: Permission,
): GroupGrantRefusal | null {
  if (!GROUP_GRANTABLE_PERMISSIONS.includes(permission)) return "not_grantable";
  return delegationRefusal(actorRole, actorPermissions, permission);
}
