export type Role = "OWNER" | "ADMIN" | "CREATOR" | "REVIEWER";

export const ROLES: readonly Role[] = ["OWNER", "ADMIN", "CREATOR", "REVIEWER"];

export type Permission =
  | "org:manage"
  | "member:read"
  | "member:manage"
  | "property:write"
  | "video:review";

const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  OWNER: ["org:manage", "member:read", "member:manage", "property:write", "video:review"],
  ADMIN: ["member:read", "member:manage", "property:write", "video:review"],
  CREATOR: ["member:read", "property:write"],
  REVIEWER: ["member:read", "video:review"],
};

export function hasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}
