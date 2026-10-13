import { describe, expect, it } from "vitest";
import {
  PERMISSIONS,
  ROLES,
  hasPermission,
  isRole,
  mayAssignRole,
  scopeForRole,
  type Permission,
  type Role,
} from "./roles";

/**
 * ADR-0052 Decision 10, "The approved template-to-permission matrix and Scope",
 * transcribed row for row in the ADR's own column order:
 * OWNER ADMIN MANAGER CREATOR VIEWER BILLING. "x" is granted, "-" is not.
 *
 * Deliberately a second, independent statement of the matrix: the
 * implementation groups grants by template, this table by permission, so a
 * slip in either fails here.
 */
const ADR_MATRIX: Readonly<Record<Permission, string>> = {
  "organization.view": "xxxxxx",
  "organization.manage": "xx----",
  "member.view": "xxx--x",
  "member.manage": "xx----",
  "group.view": "xxx---",
  "group.manage": "xx----",
  "permission.manage": "xx----",
  "property.view": "xxxxx-",
  "property.create": "xxxx--",
  "property.edit": "xxxx--",
  "property.delete": "xxxx--",
  "asset.upload": "xxxx--",
  "asset.delete": "xxxx--",
  "analysis.review": "xxxx--",
  "video.view": "xxxxx-",
  "video.generate": "xxxx--",
  "video.regenerate": "xxxx--",
  "video.download": "xxxxx-",
  "disclosure.change": "xxxx--",
  "disclosure.none": "------",
  "unit.consume": "xxxx--",
  "unit.view": "xxxx-x",
  "billing.view": "xx---x",
  "billing.manage": "x----x",
  "audit.view": "xx----",
  "audit.export": "xx----",
  "video.share": "------",
};

const ADR_COLUMNS: readonly Role[] = ["OWNER", "ADMIN", "MANAGER", "CREATOR", "VIEWER", "BILLING"];

describe("the role templates", () => {
  it("are exactly the six ADR-0052 templates, with no REVIEWER", () => {
    expect([...ROLES]).toEqual(ADR_COLUMNS);
    expect(isRole("REVIEWER")).toBe(false);
    for (const role of ROLES) expect(isRole(role)).toBe(true);
  });

  it("each have their fixed Scope", () => {
    expect(ROLES.map((role) => [role, scopeForRole(role)])).toEqual([
      ["OWNER", "ORGANIZATION"],
      ["ADMIN", "ORGANIZATION"],
      ["MANAGER", "GROUP"],
      ["CREATOR", "OWN"],
      ["VIEWER", "OWN"],
      ["BILLING", "ORGANIZATION"],
    ]);
  });
});

describe("the permission matrix", () => {
  it("names exactly the 27 ADR-0052 permissions, once each", () => {
    expect(PERMISSIONS).toHaveLength(27);
    expect(new Set(PERMISSIONS).size).toBe(27);
    expect([...PERMISSIONS].sort()).toEqual(Object.keys(ADR_MATRIX).sort());
  });

  it.each(Object.entries(ADR_MATRIX) as [Permission, string][])("grants %s exactly as approved", (permission, row) => {
    const granted = ADR_COLUMNS.map((role) => (hasPermission(role, permission) ? "x" : "-")).join("");
    expect(granted).toBe(row);
  });

  it("grants disclosure.none and video.share through no template", () => {
    for (const role of ROLES) {
      expect(hasPermission(role, "disclosure.none")).toBe(false);
      expect(hasPermission(role, "video.share")).toBe(false);
    }
  });

  it("keeps paying for capacity apart from spending it", () => {
    // BILLING manages billing but neither generates nor consumes Units; ADMIN
    // manages members and permissions but not billing.
    expect(hasPermission("BILLING", "billing.manage")).toBe(true);
    expect(hasPermission("BILLING", "unit.consume")).toBe(false);
    expect(hasPermission("BILLING", "video.generate")).toBe(false);
    expect(hasPermission("ADMIN", "permission.manage")).toBe(true);
    expect(hasPermission("ADMIN", "billing.manage")).toBe(false);
  });
});

describe("the role-assignment ceiling", () => {
  /** Rows: the actor's role. Columns, in ADR order: the role assigned or removed. */
  const CEILING: Readonly<Record<Role, string>> = {
    OWNER: "xxxxxx",
    ADMIN: "--xxx-",
    MANAGER: "------",
    CREATOR: "------",
    VIEWER: "------",
    BILLING: "------",
  };

  it.each(Object.entries(CEILING) as [Role, string][])("lets %s assign exactly what ADR-0052 allows", (actor, row) => {
    const allowed = ADR_COLUMNS.map((role) => (mayAssignRole(actor, role) ? "x" : "-")).join("");
    expect(allowed).toBe(row);
  });

  it("never lets a role assign a role above its own ceiling, itself included", () => {
    for (const role of ["OWNER", "ADMIN", "BILLING"] as const) {
      for (const actor of ROLES.filter((r) => r !== "OWNER")) {
        expect(mayAssignRole(actor, role)).toBe(false);
      }
    }
  });
});
