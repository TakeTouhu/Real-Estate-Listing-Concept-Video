import { MemberPermissionsService } from "@app/domain";
import { getIdentityServices } from "./identity";

let service: MemberPermissionsService | undefined;

/**
 * What a member may do, and why (ADR-0146). Server-only. It reads the member,
 * their account, their individual grants, their groups and those groups'
 * permissions, and writes nothing.
 */
export function getMemberPermissionsService(): MemberPermissionsService {
  service ??= new MemberPermissionsService(getIdentityServices().deps);
  return service;
}
