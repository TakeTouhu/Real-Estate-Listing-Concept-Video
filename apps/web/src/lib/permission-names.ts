import type { MemberPermission, Permission, Role } from "@app/domain";
import { ROLE_NAMES } from "./role-names";

/**
 * Each permission as a member's permissions page names it (AT-11a, ADR-0146):
 * what it lets a member do. `video.share` is reserved, and no one holds it.
 */
export const PERMISSION_NAMES: Record<Permission, string> = {
  "organization.view": "See the organization",
  "organization.manage": "Change the organization's settings",
  "member.view": "See the members and their permissions",
  "member.manage": "Invite and remove members",
  "group.view": "See the groups and who is in them",
  "group.manage": "Create and rename groups, and change who is in them",
  "permission.manage": "Change members' roles and permissions",
  "property.view": "See Properties",
  "property.create": "Add Properties",
  "property.edit": "Edit Properties",
  "property.delete": "Delete Properties",
  "asset.upload": "Upload photos",
  "asset.delete": "Delete photos",
  "analysis.review": "Review the analysis of photos",
  "video.view": "See video projects and watch videos",
  "video.generate": "Make videos",
  "video.regenerate": "Make a video again",
  "video.download": "Download videos",
  "disclosure.change": "Change a video's AI disclosure or logo",
  "disclosure.none": "Make videos without the AI disclosure",
  "unit.consume": "Spend Units on videos",
  "unit.view": "See Units",
  "billing.view": "See billing",
  "billing.manage": "Buy Units and manage billing",
  "audit.view": "See the audit log",
  "audit.export": "Export the audit log",
  "video.share": "Share videos",
};

/** The page's sections, each in vocabulary order: together, every permission a member can hold, once. */
export const PERMISSION_AREAS: readonly { readonly title: string; readonly permissions: readonly Permission[] }[] = [
  {
    title: "Organization and team",
    permissions: [
      "organization.view",
      "organization.manage",
      "member.view",
      "member.manage",
      "group.view",
      "group.manage",
      "permission.manage",
    ],
  },
  {
    title: "Properties and photos",
    permissions: [
      "property.view",
      "property.create",
      "property.edit",
      "property.delete",
      "asset.upload",
      "asset.delete",
      "analysis.review",
    ],
  },
  {
    title: "Videos",
    permissions: [
      "video.view",
      "video.generate",
      "video.regenerate",
      "video.download",
      "disclosure.change",
      "disclosure.none",
    ],
  },
  { title: "Units and billing", permissions: ["unit.consume", "unit.view", "billing.view", "billing.manage"] },
  { title: "Audit log", permissions: ["audit.view", "audit.export"] },
];

/**
 * Permissions nothing in VTaVision checks yet, because what they are for is
 * not built: membership alone opens an organization, and there is no
 * settings page, second generation of a video, disclosure change, Mode C or
 * audit log page. The page says so, rather than let one look like it does
 * something.
 */
export const NOT_YET_USED: readonly Permission[] = [
  "organization.view",
  "organization.manage",
  "video.regenerate",
  "disclosure.change",
  "disclosure.none",
  "audit.view",
  "audit.export",
];

/** `items` as a sentence lists them: "a", "a and b", "a, b and c". */
function listed(items: readonly string[]): string {
  return items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/** Where a member's permission comes from, as a phrase, or `null` when nothing gives it. */
function sources({ fromRole, granted, groupCount, groupNames }: MemberPermission): string | null {
  const from: string[] = [];
  if (fromRole) from.push("their role");
  if (granted) from.push("an individual grant");
  if (groupNames !== null && groupNames.length > 0) {
    from.push(`the group${groupNames.length > 1 ? "s" : ""} ${listed(groupNames)}`);
  } else if (groupCount > 0) {
    from.push(groupCount === 1 ? "one of their groups" : `${groupCount} of their groups`);
  }
  return from.length === 0 ? null : listed(from);
}

/**
 * Whether a member holding `role` may do what `permission` allows, and why,
 * as a sentence. Only `property.create`, for a `VIEWER` or `BILLING` member,
 * can be given and still not be in effect.
 */
export function permissionAnswer(permission: MemberPermission, role: Role): string {
  const from = sources(permission);
  if (from === null) return "No.";
  if (permission.effective) return `Yes, from ${from}.`;
  return `No, although it comes from ${from}: it is never in effect for a ${ROLE_NAMES[role]}.`;
}
