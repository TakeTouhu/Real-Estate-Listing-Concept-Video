import { AppError } from "@app/shared";
import type { IdentityServiceDeps } from "./ports";
import { effectivePermissions, type Permission, type Role } from "./roles";
import type { Membership } from "./types";

export interface AuthContext {
  readonly userId: string;
  readonly organizationId: string;
  readonly role: Role;
  /** The member's effective permissions: its template's plus its individual grants. */
  readonly permissions: readonly Permission[];
}

/** A membership's effective permissions, reading its individual grants. */
export async function effectivePermissionsOf(
  deps: Pick<IdentityServiceDeps, "repos">,
  membership: Membership,
): Promise<readonly Permission[]> {
  const grants = await deps.repos.permissionGrants.listForMember(membership.organizationId, membership.userId);
  return effectivePermissions(
    membership.role,
    grants.map((grant) => grant.permission),
  );
}

/**
 * Resolve and enforce organization-scoped access. Denies with FORBIDDEN when the
 * user has no membership in the target organization (the core tenant-isolation
 * guarantee) or when their effective permissions lack any of the required ones.
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
  const effective = await effectivePermissionsOf(deps, membership);
  const permissions: readonly Permission[] =
    required === undefined ? [] : typeof required === "string" ? [required] : required;
  for (const permission of permissions) {
    if (!effective.includes(permission)) {
      throw new AppError("FORBIDDEN", `Role ${membership.role} lacks permission '${permission}'`);
    }
  }
  return { userId, organizationId, role: membership.role, permissions: effective };
}
