import { hotp, sha256Hex } from "@app/shared";
import { describe, expect, it } from "vitest";
import { createTestDeps, type TestDeps } from "../testing/in-memory";
import type { Permission, Role } from "../identity/roles";
import { createMfaSecretCipher } from "./adapters";
import type { MfaRandom } from "./ports";
import { RECOVERY_CODE_COUNT, generateRecoveryCode, hashRecoveryCode, normalizeRecoveryCode } from "./recovery-codes";
import { MFA_MANDATORY_PERMISSIONS, isMfaRequired } from "./requirement";
import { matchTotp, totpStep } from "./totp";

const SECRET = Buffer.from("12345678901234567890", "ascii");
const AT = new Date("2026-01-01T00:00:00.000Z");
const STEP = totpStep(AT);

describe("TOTP", () => {
  it("counts 30-second steps since the epoch", () => {
    expect(totpStep(new Date(59_000))).toBe(1);
    expect(totpStep(new Date(60_000))).toBe(2);
    expect(STEP).toBe(1767225600 / 30);
  });

  it("accepts a code of the current step, or one step either side, and says which", () => {
    expect(matchTotp(SECRET, hotp(SECRET, STEP), AT, null)).toBe(STEP);
    expect(matchTotp(SECRET, hotp(SECRET, STEP - 1), AT, null)).toBe(STEP - 1);
    expect(matchTotp(SECRET, hotp(SECRET, STEP + 1), AT, null)).toBe(STEP + 1);
  });

  it("refuses a code two steps away", () => {
    expect(matchTotp(SECRET, hotp(SECRET, STEP - 2), AT, null)).toBeNull();
    expect(matchTotp(SECRET, hotp(SECRET, STEP + 2), AT, null)).toBeNull();
  });

  it("refuses a code for the last step used or an earlier one", () => {
    expect(matchTotp(SECRET, hotp(SECRET, STEP), AT, STEP)).toBeNull();
    expect(matchTotp(SECRET, hotp(SECRET, STEP - 1), AT, STEP - 1)).toBeNull();
    expect(matchTotp(SECRET, hotp(SECRET, STEP + 1), AT, STEP)).toBe(STEP + 1);
  });

  it("reads spaces out of a code and refuses anything but six digits", () => {
    const code = hotp(SECRET, STEP);
    expect(matchTotp(SECRET, `${code.slice(0, 3)} ${code.slice(3)}`, AT, null)).toBe(STEP);
    expect(matchTotp(SECRET, code.slice(0, 5), AT, null)).toBeNull();
    expect(matchTotp(SECRET, `${code}0`, AT, null)).toBeNull();
    expect(matchTotp(SECRET, "abcdef", AT, null)).toBeNull();
    expect(matchTotp(Buffer.from("another secret 0000", "ascii"), code, AT, null)).toBeNull();
  });
});

describe("recovery codes", () => {
  const counting = (): MfaRandom => {
    let call = 0;
    return { bytes: (count) => Uint8Array.from({ length: count }, (_, i) => (++call * 37 + i * 11) & 0xff) };
  };

  it("are 16 Crockford characters in four groups, 80 random bits each", () => {
    let asked = 0;
    const code = generateRecoveryCode({ bytes: (count) => ((asked = count), new Uint8Array(count).fill(0xff)) });
    expect(asked).toBe(10);
    expect(code).toBe("ZZZZ-ZZZZ-ZZZZ-ZZZZ");
    expect(generateRecoveryCode(counting())).toMatch(/^([0-9A-HJKMNP-TV-Z]{4}-){3}[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(RECOVERY_CODE_COUNT).toBe(10);
  });

  it("read back however they are typed", () => {
    const code = generateRecoveryCode(counting());
    const stored = code.replace(/-/g, "");
    expect(normalizeRecoveryCode(code)).toBe(stored);
    expect(normalizeRecoveryCode(code.toLowerCase())).toBe(stored);
    expect(normalizeRecoveryCode(` ${stored.slice(0, 8)} ${stored.slice(8)} `)).toBe(stored);
    expect(normalizeRecoveryCode("O0IL-0000-0000-0000")).toBe("0011000000000000");
  });

  it("are refused when they cannot be one", () => {
    for (const input of ["", "123456", "ZZZZ-ZZZZ-ZZZZ-ZZZ", "ZZZZ-ZZZZ-ZZZZ-ZZZZZ", "UZZZ-ZZZZ-ZZZZ-ZZZZ", "ZZZZ_ZZZZ_ZZZZ_ZZZZ"]) {
      expect(normalizeRecoveryCode(input)).toBeNull();
    }
  });

  it("are stored as the SHA-256 of their normalized form", () => {
    expect(hashRecoveryCode("ZZZZZZZZZZZZZZZZ")).toBe(sha256Hex("ZZZZZZZZZZZZZZZZ"));
    expect(hashRecoveryCode("ZZZZZZZZZZZZZZZZ")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("the MFA secret cipher", () => {
  const cipher = createMfaSecretCipher("11".repeat(32));

  it("opens a sealed secret for its user, and names the key", () => {
    const sealed = cipher.seal(SECRET, "usr_1");
    expect(Buffer.from(cipher.open(sealed, "usr_1")).equals(SECRET)).toBe(true);
    expect(sealed).toMatch(/^[0-9a-f]{12}\.[A-Za-z0-9_-]+$/);
    expect(sealed).not.toContain(SECRET.toString("base64url"));
  });

  it("refuses another user's secret, another key's, and an altered one", () => {
    const sealed = cipher.seal(SECRET, "usr_1");
    expect(() => cipher.open(sealed, "usr_2")).toThrow();
    expect(() => createMfaSecretCipher("22".repeat(32)).open(sealed, "usr_1")).toThrow("another key");
    expect(() => cipher.open(sealed.replace(/^[0-9a-f]{12}/, "000000000000"), "usr_1")).toThrow("another key");
    const flipped = sealed[30] === "A" ? "B" : "A";
    expect(() => cipher.open(`${sealed.slice(0, 30)}${flipped}${sealed.slice(31)}`, "usr_1")).toThrow();
  });

  it("takes only a 32-byte hex key", () => {
    for (const key of ["", "11".repeat(31), "11".repeat(33), "zz".repeat(32)]) {
      expect(() => createMfaSecretCipher(key)).toThrow("64 hex characters");
    }
  });
});

describe("who must use MFA (ADR-0052 Decision 18)", () => {
  const ORG = "org_1";
  const OTHER = "org_2";
  const USER = "usr_1";

  async function member(deps: TestDeps, role: Role, organizationId = ORG): Promise<void> {
    await deps.repos.memberships.create({ organizationId, userId: USER, role });
  }
  const audit = { organizationId: ORG, actorUserId: "usr_owner", action: "test", resourceType: "test", resourceId: "x", metadata: {} };

  it("is every OWNER and ADMIN, and the BILLING template through billing.manage", async () => {
    for (const role of ["OWNER", "ADMIN", "BILLING"] as const) {
      const deps = createTestDeps();
      await member(deps, role);
      expect(await isMfaRequired(deps, USER)).toBe(true);
    }
  });

  it("is no MANAGER, CREATOR or VIEWER by role alone, and no one without a membership", async () => {
    for (const role of ["MANAGER", "CREATOR", "VIEWER"] as const) {
      const deps = createTestDeps();
      await member(deps, role);
      expect(await isMfaRequired(deps, USER)).toBe(false);
    }
    expect(await isMfaRequired(createTestDeps(), USER)).toBe(false);
  });

  it("follows permission.manage and billing.manage through an individual grant", async () => {
    for (const permission of MFA_MANDATORY_PERMISSIONS) {
      const deps = createTestDeps();
      await member(deps, "CREATOR");
      await deps.repos.permissionGrants.insertIfAbsent(
        { organizationId: ORG, userId: USER, permission, grantedByUserId: "usr_owner", grantedAt: AT },
        audit,
      );
      expect(await isMfaRequired(deps, USER)).toBe(true);
    }
  });

  it("follows them through a group", async () => {
    for (const permission of MFA_MANDATORY_PERMISSIONS) {
      const deps = createTestDeps();
      await member(deps, "VIEWER");
      await groupGives(deps, permission);
      expect(await isMfaRequired(deps, USER)).toBe(true);
    }
  });

  it("is not made mandatory by another permission", async () => {
    const deps = createTestDeps();
    await member(deps, "CREATOR");
    await groupGives(deps, "member.manage");
    expect(await isMfaRequired(deps, USER)).toBe(false);
  });

  it("holds when any one of the user's organizations makes it mandatory", async () => {
    const deps = createTestDeps();
    await member(deps, "VIEWER");
    await member(deps, "OWNER", OTHER);
    expect(await isMfaRequired(deps, USER)).toBe(true);
  });

  it("is every member of an organization that requires it of all its members (ADR-0065 Decision 18)", async () => {
    for (const role of ["MANAGER", "CREATOR", "VIEWER"] as const) {
      const deps = createTestDeps();
      await deps.repos.organizations.create({ id: ORG, name: "Org", slug: "org", status: "ACTIVE" });
      await deps.repos.memberships.create({ organizationId: ORG, userId: "usr_owner", role: "OWNER" });
      await member(deps, role);
      expect(await isMfaRequired(deps, USER)).toBe(false);
      await deps.repos.organizations.setMfaRequired({
        organizationId: ORG,
        actorUserId: "usr_owner",
        expected: false,
        required: true,
        audit,
      });
      expect(await isMfaRequired(deps, USER)).toBe(true);
    }
  });

  it("is not made mandatory by another organization's requirement", async () => {
    const deps = createTestDeps();
    await deps.repos.organizations.create({ id: OTHER, name: "Other", slug: "other", status: "ACTIVE" });
    await deps.repos.memberships.create({ organizationId: OTHER, userId: "usr_owner", role: "OWNER" });
    await deps.repos.organizations.setMfaRequired({
      organizationId: OTHER,
      actorUserId: "usr_owner",
      expected: false,
      required: true,
      audit,
    });
    await member(deps, "CREATOR");
    expect(await isMfaRequired(deps, USER)).toBe(false);
  });

  it("is read again on every call", async () => {
    const deps = createTestDeps();
    await member(deps, "CREATOR");
    expect(await isMfaRequired(deps, USER)).toBe(false);
    await deps.repos.memberships.changeRole(ORG, USER, "CREATOR", "ADMIN", audit);
    expect(await isMfaRequired(deps, USER)).toBe(true);
  });

  async function groupGives(deps: TestDeps, permission: Permission): Promise<void> {
    await deps.repos.groups.create({ id: "grp_1", organizationId: ORG, name: "Team", createdByUserId: "usr_owner" }, audit);
    await deps.repos.groups.addMember(
      { groupId: "grp_1", organizationId: ORG, userId: USER, addedByUserId: "usr_owner" },
      () => null,
      audit,
    );
    await deps.repos.groups.grantPermission(
      { groupId: "grp_1", organizationId: ORG, permission, grantedByUserId: "usr_owner" },
      () => null,
      () => audit,
    );
  }
});
