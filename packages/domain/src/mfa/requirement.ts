import { effectivePermissionsOf } from "../identity/authorization";
import type { IdentityServiceDeps } from "../identity/ports";
import type { Permission, Role } from "../identity/roles";

const MFA_MANDATORY_ROLES: readonly Role[] = ["OWNER", "ADMIN"];
/** Holding either, from any source, makes MFA mandatory (ADR-0052 Decision 18). */
export const MFA_MANDATORY_PERMISSIONS: readonly Permission[] = ["permission.manage", "billing.manage"];

/**
 * Whether the user must use MFA: an `OWNER` or `ADMIN` of any organization, or
 * a holder there of `permission.manage` or `billing.manage` by template,
 * individual grant or group. Read from current memberships on every call.
 */
export async function isMfaRequired(deps: Pick<IdentityServiceDeps, "repos">, userId: string): Promise<boolean> {
  for (const membership of await deps.repos.memberships.listByUser(userId)) {
    if (MFA_MANDATORY_ROLES.includes(membership.role)) return true;
    const permissions = await effectivePermissionsOf(deps, membership);
    if (MFA_MANDATORY_PERMISSIONS.some((permission) => permissions.includes(permission))) return true;
  }
  return false;
}
