import { hotp } from "@app/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { AuthService } from "../identity/auth-service";
import { OrganizationService } from "../identity/organization-service";
import type { Session } from "../identity/types";
import { createTestDeps, markEmailVerified, type TestDeps } from "../testing/in-memory";
import { createMfaSecretCipher, systemMfaRandom } from "./adapters";
import { MfaService } from "./mfa-service";
import { mfaSignInStep, signInStep } from "./sign-in";
import { totpStep } from "./totp";

const PASSWORD = "password-123456";
const EMAIL = "step@example.com";

function decodeBase32(text: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const char of text) bits += alphabet.indexOf(char).toString(2).padStart(5, "0");
  return Buffer.from((bits.match(/.{8}/g) ?? []).map((byte) => parseInt(byte, 2)));
}

describe("mfaSignInStep (ADR-0065 Decisions 12, 15 and 18)", () => {
  let deps: TestDeps;
  let auth: AuthService;
  let mfa: MfaService;

  beforeEach(async () => {
    deps = createTestDeps();
    auth = new AuthService(deps, { sessionTtlSeconds: 3600 });
    mfa = new MfaService({ ...deps, cipher: createMfaSecretCipher("22".repeat(32)), random: systemMfaRandom });
    await auth.register({ email: EMAIL, name: "Step", password: PASSWORD });
  });

  const signIn = async (): Promise<Session> => (await auth.login(EMAIL, PASSWORD)).session;
  const stored = (session: Session): Session => deps.repos.sessions.byId(session.id)!;
  const code = (secret: string, offset = 0): string =>
    hotp(decodeBase32(secret), totpStep(deps.clock.now()) + offset);

  async function enroll(): Promise<{ secret: string; session: Session }> {
    const session = await signIn();
    const { secret } = await mfa.beginSetup(session);
    await mfa.confirmSetup(session, code(secret));
    return { secret, session: stored(session) };
  }

  it("signs in a user without MFA with the password alone", async () => {
    expect(await mfaSignInStep(deps, await signIn())).toBe("SIGNED_IN");
  });

  it("asks every new sign-in of a user with MFA for a code, until it passes", async () => {
    const { secret } = await enroll();
    const session = await signIn();
    expect(await mfaSignInStep(deps, session)).toBe("CODE_REQUIRED");

    await mfa.verify(session, code(secret, 1));
    expect(await mfaSignInStep(deps, stored(session))).toBe("SIGNED_IN");
  });

  it("keeps the sign-in that turned MFA on signed in, and asks one started before it for a code", async () => {
    const earlier = await signIn();
    const { session } = await enroll();
    expect(await mfaSignInStep(deps, session)).toBe("SIGNED_IN");
    expect(await mfaSignInStep(deps, stored(earlier))).toBe("CODE_REQUIRED");
  });

  it("signs in with the password alone again once MFA is turned off", async () => {
    const { secret, session } = await enroll();
    const other = await signIn();
    await mfa.disable(session, code(secret, 1));
    expect(await mfaSignInStep(deps, stored(other))).toBe("SIGNED_IN");
  });

  const becomeOwner = async () =>
    new OrganizationService(deps).createOrganization((await deps.repos.users.findByEmail(EMAIL))!.id, { name: "Studio" });

  it("asks someone who must use MFA to set it up first, then for a code at every later sign-in", async () => {
    await becomeOwner();
    const session = await signIn();
    expect(await mfaSignInStep(deps, session)).toBe("SETUP_REQUIRED");

    const { secret } = await mfa.beginSetup(session);
    await mfa.confirmSetup(session, code(secret));
    expect(await mfaSignInStep(deps, stored(session))).toBe("SIGNED_IN");
    expect(await mfaSignInStep(deps, await signIn())).toBe("CODE_REQUIRED");
  });

  it("applies a new requirement from the next request, even to a sign-in that passed MFA before it was turned off", async () => {
    const { secret, session } = await enroll();
    await mfa.disable(session, code(secret, 1));
    expect(await mfaSignInStep(deps, stored(session))).toBe("SIGNED_IN");

    await becomeOwner();
    expect(stored(session).mfaVerifiedAt).not.toBeNull();
    expect(await mfaSignInStep(deps, stored(session))).toBe("SETUP_REQUIRED");
  });

  it("asks a member of an organization that requires MFA of everyone to set it up first", async () => {
    const owner = (await auth.register({ email: "owner@example.com", name: "Owner", password: PASSWORD })).id;
    const organizations = new OrganizationService(deps);
    const { organization } = await organizations.createOrganization(owner, { name: "Agency" });
    const userId = (await deps.repos.users.findByEmail(EMAIL))!.id;
    await deps.repos.memberships.create({ organizationId: organization.id, userId, role: "VIEWER" });
    const session = await signIn();
    expect(await mfaSignInStep(deps, session)).toBe("SIGNED_IN");

    await organizations.setMfaRequirement(owner, organization.id, true);
    expect(await mfaSignInStep(deps, stored(session))).toBe("SETUP_REQUIRED");
    await organizations.setMfaRequirement(owner, organization.id, false);
    expect(await mfaSignInStep(deps, stored(session))).toBe("SIGNED_IN");
  });
});

describe("signInStep (ADR-0129)", () => {
  let deps: TestDeps;
  let auth: AuthService;
  let mfa: MfaService;
  let userId: string;

  beforeEach(async () => {
    deps = createTestDeps();
    auth = new AuthService(deps, { sessionTtlSeconds: 3600 });
    mfa = new MfaService({ ...deps, cipher: createMfaSecretCipher("22".repeat(32)), random: systemMfaRandom });
    userId = (await auth.register({ email: EMAIL, name: "Step", password: PASSWORD })).id;
  });

  const user = () => deps.repos.users.peek(userId)!;
  const stored = (session: Session): Session => deps.repos.sessions.byId(session.id)!;
  const signIn = async (): Promise<Session> => (await auth.login(EMAIL, PASSWORD)).session;
  const step = (session: Session) => signInStep(deps, user(), stored(session));
  const code = (secret: string, offset = 0): string =>
    hotp(decodeBase32(secret), totpStep(deps.clock.now()) + offset);

  it("keeps a new account on email verification until its address is verified, then lets it in", async () => {
    const session = await signIn();
    expect(await step(session)).toBe("EMAIL_VERIFICATION_REQUIRED");
    markEmailVerified(deps, userId);
    expect(await step(session)).toBe("SIGNED_IN");
  });

  it("asks a sign-in that owes an MFA code for the code before the address", async () => {
    markEmailVerified(deps, userId);
    const enrolling = await signIn();
    const { secret } = await mfa.beginSetup(enrolling);
    await mfa.confirmSetup(enrolling, code(secret));
    deps.repos.users.put({ ...user(), emailVerifiedAt: null });

    const session = await signIn();
    expect(await step(session)).toBe("CODE_REQUIRED");
    await mfa.verify(session, code(secret, 1));
    expect(await step(session)).toBe("EMAIL_VERIFICATION_REQUIRED");
    markEmailVerified(deps, userId);
    expect(await step(session)).toBe("SIGNED_IN");
  });

  it("asks for the address before MFA set-up", async () => {
    await new OrganizationService(deps).createOrganization(userId, { name: "Studio" });
    const session = await signIn();
    expect(await step(session)).toBe("EMAIL_VERIFICATION_REQUIRED");
    markEmailVerified(deps, userId);
    expect(await step(session)).toBe("SETUP_REQUIRED");
  });
});
