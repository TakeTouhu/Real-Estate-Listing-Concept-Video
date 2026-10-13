import { AppError } from "@app/shared";
import type { IdentityServiceDeps } from "./ports";
import { hasPermission, type Permission, type Role } from "./roles";

export interface AuthContext {
  readonly userId: string;
  readonly organizationId: string;
  readonly role: Role;
}

/**
 * Resolve and enforce organization-scoped access. Denies with FORBIDDEN when the
 * user has no membership in the target organization (the core tenant-isolation
 * guarantee) or when their role lacks any of the required permissions.
 */
export async function authorizeOrganization(
  deps: IdentityServiceDeps,
  userId: string,
  organizationId: string,
  required?: Permission | readonly Permission[],
): Promise<AuthContext> {
  const membership = await deps.repos.memberships.find(organizationId, userId);
  if (!membership) {
    throw new AppError("FORBIDDEN", "You do not have access to this organization");
  }
  const permissions: readonly Permission[] =
    required === undefined ? [] : typeof required === "string" ? [required] : required;
  for (const permission of permissions) {
    if (!hasPermission(membership.role, permission)) {
      throw new AppError("FORBIDDEN", `Role ${membership.role} lacks permission '${permission}'`);
    }
  }
  return { userId, organizationId, role: membership.role };
}
