import { describe, expect, it } from "vitest";
import {
  GRANTABLE_PERMISSIONS,
  PERMISSIONS,
  PROTECTED_PERMISSIONS,
  ROLES,
  effectivePermissions,
  grantRefusal,
  hasPermission,
  type Permission,
  type Role,
} from "./roles";

/**
 * The individual-grant ceiling and effective permissions (ADR-0052 Decision 10,
 * Phase 6D), as pure functions.
 */

const templateOf = (role: Role): readonly Permission[] => PERMISSIONS.filter((p) => hasPermission(role, p));

describe("the grantable vocabulary", () => {
  it("is every permission but the reserved video.share", () => {
    expect(GRANTABLE_PERMISSIONS).toHaveLength(26);
    expect(GRANTABLE_PERMISSIONS).not.toContain("video.share");
    expect([...GRANTABLE_PERMISSIONS, "video.share"].sort()).toEqual([...PERMISSIONS].sort());
  });

  it("protects exactly permission.manage, billing.manage and disclosure.none", () => {
    expect([...PROTECTED_PERMISSIONS].sort()).toEqual(["billing.manage", "disclosure.none", "permission.manage"]);
  });
});

describe("effectivePermissions", () => {
  it.each([...ROLES])("is exactly the %s template when there are no grants", (role) => {
    expect(effectivePermissions(role, [])).toEqual(templateOf(role));
  });

  it("adds grants to the template, in vocabulary order, without duplicates", () => {
    const effective = effectivePermissions("VIEWER", ["video.view", "audit.view", "disclosure.none"]);
    expect(effective).toEqual(PERMISSIONS.filter((p) => [...templateOf("VIEWER"), "audit.view", "disclosure.none"].includes(p)));
  });

  it.each(["VIEWER", "BILLING"] as const)("never makes property.create effective for %s", (role) => {
    expect(effectivePermissions(role, ["property.create", "property.edit"])).not.toContain("property.create");
    expect(effectivePermissions(role, ["property.create", "property.edit"])).toContain("property.edit");
  });

  it.each(["OWNER", "ADMIN", "MANAGER", "CREATOR"] as const)("leaves property.create effective for %s", (role) => {
    expect(effectivePermissions(role, [])).toContain("property.create");
  });
});

/**
 * The ceiling, transcribed from ADR-0052 Decision 10 independently of the
 * implementation: who may grant what to whom.
 */
function expected(actor: Role, target: Role, permission: Permission): string | null {
  if (permission === "video.share") return "not_grantable";
  const manageable: Record<Role, readonly Role[]> = {
    OWNER: ROLES,
    ADMIN: ["MANAGER", "CREATOR", "VIEWER"],
    MANAGER: [],
    CREATOR: [],
    VIEWER: [],
    BILLING: [],
  };
  if (!manageable[actor].includes(target)) return "target_role";
  if (actor !== "OWNER" && ["permission.manage", "billing.manage", "disclosure.none"].includes(permission)) {
    return "protected";
  }
  if (permission === "property.create" && (target === "VIEWER" || target === "BILLING")) return "recipient_ceiling";
  return null;
}

describe("grantRefusal — grant", () => {
  for (const actor of ROLES) {
    it(`matches the ADR for every target and permission when a ${actor} holds permission.manage`, () => {
      const actorPermissions = effectivePermissions(actor, ["permission.manage"]);
      for (const target of ROLES) {
        for (const permission of PERMISSIONS) {
          expect([target, permission, grantRefusal("grant", actor, actorPermissions, target, permission)]).toEqual([
            target,
            permission,
            expected(actor, target, permission),
          ]);
        }
      }
    });
  }

  it("lets a non-OWNER delegate only what it effectively holds", () => {
    const withoutAuditExport = templateOf("ADMIN").filter((p) => p !== "audit.export");
    expect(grantRefusal("grant", "ADMIN", withoutAuditExport, "CREATOR", "audit.export")).toBe("not_held");
    expect(grantRefusal("grant", "ADMIN", withoutAuditExport, "CREATOR", "audit.view")).toBeNull();
  });

  it("lets an OWNER grant what its template does not carry", () => {
    expect(templateOf("OWNER")).not.toContain("disclosure.none");
    expect(grantRefusal("grant", "OWNER", templateOf("OWNER"), "OWNER", "disclosure.none")).toBeNull();
  });
});

describe("grantRefusal — revoke", () => {
  it("applies the same ceiling as a grant", () => {
    expect(grantRefusal("revoke", "ADMIN", templateOf("ADMIN"), "CREATOR", "billing.manage")).toBe("protected");
    expect(grantRefusal("revoke", "ADMIN", templateOf("ADMIN"), "ADMIN", "audit.view")).toBe("target_role");
    expect(grantRefusal("revoke", "ADMIN", templateOf("ADMIN"), "CREATOR", "audit.view")).toBeNull();
  });

  it.each(["VIEWER", "BILLING"] as const)("may take property.create back from a %s", (target) => {
    expect(grantRefusal("revoke", "OWNER", templateOf("OWNER"), target, "property.create")).toBeNull();
  });
});
