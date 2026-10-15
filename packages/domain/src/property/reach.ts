import type { AuthContext } from "../identity/authorization";
import type { IdentityServiceDeps } from "../identity/ports";
import { scopeForRole } from "../identity/roles";
import type { PropertyRepository } from "./ports";
import type { Property } from "./types";

/**
 * Which of its organization's Properties a member reaches (ADR-0052 Decision
 * 10, Phase 6I, ADR-0064). The Property is the authorization root: everything
 * under it is reached exactly when the Property is.
 *
 * - `ORGANIZATION` (`OWNER`, `ADMIN`, `BILLING`): every Property of the
 *   organization.
 * - `GROUP` (`MANAGER`): a Property assigned to any group the member is in now.
 *   An ungrouped Property is not reached, and being its responsible user does
 *   not reach it either.
 * - `OWN` (`CREATOR`, `VIEWER`): a Property the member is the assigned
 *   responsible user of. Never who created it.
 *
 * Every variant carries the organization, so no reach crosses a tenant.
 */
export type Reach =
  | { readonly scope: "ORGANIZATION"; readonly organizationId: string }
  | { readonly scope: "GROUP"; readonly organizationId: string; readonly groupIds: readonly string[] }
  | { readonly scope: "OWN"; readonly organizationId: string; readonly userId: string };

/**
 * An authorized member's reach. Fixed by its role; a `MANAGER`'s also reads its
 * current groups. Individual and group grants never change it.
 */
export async function reachOf(identity: Pick<IdentityServiceDeps, "repos">, actor: AuthContext): Promise<Reach> {
  const { organizationId, userId } = actor;
  const scope = scopeForRole(actor.role);
  switch (scope) {
    case "ORGANIZATION":
      return { scope, organizationId };
    case "GROUP":
      return { scope, organizationId, groupIds: await identity.repos.groups.listGroupIdsForMember(organizationId, userId) };
    case "OWN":
      return { scope, organizationId, userId };
  }
}

/** Whether `reach` reaches `property`, judged by its assignments alone. */
export function reaches(
  reach: Reach,
  property: Pick<Property, "organizationId" | "responsibleUserId" | "groupId">,
): boolean {
  if (property.organizationId !== reach.organizationId) return false;
  switch (reach.scope) {
    case "ORGANIZATION":
      return true;
    case "GROUP":
      return property.groupId !== null && reach.groupIds.includes(property.groupId);
    case "OWN":
      return property.responsibleUserId === reach.userId;
  }
}

/**
 * The Property an authorized member names, or `null` when it does not exist in
 * the organization or the member does not reach it. Callers answer `null` with
 * the not-found answer they already give, so a Property out of reach is
 * indistinguishable from one that does not exist. A deleted Property is
 * returned as it is; each caller keeps its own rule for it.
 */
export async function findReachableProperty(
  identity: Pick<IdentityServiceDeps, "repos">,
  properties: Pick<PropertyRepository, "findById">,
  actor: AuthContext,
  propertyId: string,
): Promise<Property | null> {
  const property = await properties.findById(actor.organizationId, propertyId);
  if (!property) return null;
  return reaches(await reachOf(identity, actor), property) ? property : null;
}
