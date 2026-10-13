/**
 * The standard role templates and the permission matrix (ADR-0052 Decision 10,
 * Phase 6C).
 *
 * Each template's grant list is exhaustive: a permission a template does not
 * list, it does not grant. Individual grants and group permissions are later
 * packages; until they exist a member's effective permissions are exactly its
 * template's.
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
 * by role: there is no standalone Scope change, only a role change. Recorded
 * here as data; row-level enforcement is a later package.
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
