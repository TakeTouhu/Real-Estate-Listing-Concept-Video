import { ROLES } from "../identity/roles";
import type { Membership } from "../identity/types";

const compareIds = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The order the members page (ADR-0134) and the groups page (ADR-0141) list
 * members in: by role, `OWNER` first, then the longest-standing member first,
 * then by account id.
 */
export function compareMembers(
  a: Pick<Membership, "role" | "createdAt" | "userId">,
  b: Pick<Membership, "role" | "createdAt" | "userId">,
): number {
  return (
    ROLES.indexOf(a.role) - ROLES.indexOf(b.role) ||
    a.createdAt.getTime() - b.createdAt.getTime() ||
    compareIds(a.userId, b.userId)
  );
}
