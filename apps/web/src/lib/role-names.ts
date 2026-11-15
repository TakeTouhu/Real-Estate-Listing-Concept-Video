import type { AssignableMember, Role } from "@app/domain";

/** Each role as the members, groups and Property pages name it. */
export const ROLE_NAMES: Record<Role, string> = {
  OWNER: "Owner",
  ADMIN: "Admin",
  MANAGER: "Manager",
  CREATOR: "Creator",
  VIEWER: "Viewer",
  BILLING: "Billing",
};

/** A member as the Property forms list it: name, address where shown, and role. */
export function memberLine({ name, email, role }: Pick<AssignableMember, "name" | "email" | "role">): string {
  return `${name}${email === null ? "" : ` · ${email}`} · ${ROLE_NAMES[role]}`;
}
