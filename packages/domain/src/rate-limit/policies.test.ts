import { describe, expect, it } from "vitest";
import { AppError, RATE_LIMIT_DEFAULTS } from "@app/shared";
import { RATE_LIMIT_COOLDOWN, RATE_LIMIT_POLICY_NAMES, rateLimitPolicies, type RateLimitPolicy } from "./index";

const OUT_OF_RANGE = new AppError("CONFIGURATION_ERROR", "A rate-limit policy is out of range");

describe("the policies from the settings (ADR-0170)", () => {
  const withCooldown = (name: string, limit: number, windowSeconds: number): RateLimitPolicy => {
    const cooldown = { cooldownBaseSeconds: windowSeconds, cooldownMaxSeconds: 3600, decaySeconds: 86_400 };
    return { name, limit, windowSeconds, ...cooldown };
  };
  const plain = (name: string, limit: number, windowSeconds: number): RateLimitPolicy =>
    ({ name, limit, windowSeconds, cooldownBaseSeconds: 0, cooldownMaxSeconds: 0, decaySeconds: 0 });

  it("are the documented limits by default, checked and frozen", () => {
    const policies = rateLimitPolicies(RATE_LIMIT_DEFAULTS);
    expect(policies).toEqual({
      "sign-in.address": withCooldown("sign-in.address", 5, 900),
      "sign-in.client": withCooldown("sign-in.client", 5, 900),
      "mfa-code.user": withCooldown("mfa-code.user", 5, 900),
      "password-reset-email.address": plain("password-reset-email.address", 3, 3600),
      "password-reset-email.client": plain("password-reset-email.client", 20, 3600),
      "verification-email.address": plain("verification-email.address", 3, 3600),
      "sign-up.client": plain("sign-up.client", 60, 3600),
      "upload.user": plain("upload.user", 1000, 86400),
      "invitation.user": plain("invitation.user", 50, 86400),
      "analysis.user": plain("analysis.user", 300, 3600),
      "download.user": plain("download.user", 60, 3600),
      "generation-start.user": plain("generation-start.user", 30, 3600),
    });
    expect(Object.keys(policies)).toEqual([...RATE_LIMIT_POLICY_NAMES]);
    expect(Object.isFrozen(policies)).toBe(true);
    for (const policy of Object.values(policies)) expect(Object.isFrozen(policy)).toBe(true);
    expect(RATE_LIMIT_COOLDOWN).toEqual({ maxSeconds: 3_600, decaySeconds: 86_400 });
  });

  it("read each limit from its own setting", () => {
    const policies = rateLimitPolicies({
      RATE_LIMIT_SIGN_IN: "7/700",
      RATE_LIMIT_MFA_CODE: "6/600",
      RATE_LIMIT_PASSWORD_RESET_EMAIL: "4/400",
      RATE_LIMIT_PASSWORD_RESET_EMAIL_PER_IP: "9/900",
      RATE_LIMIT_VERIFICATION_EMAIL: "2/200",
      RATE_LIMIT_SIGN_UP_PER_IP: "8/800",
      RATE_LIMIT_UPLOAD: "6/600",
      RATE_LIMIT_INVITATION: "5/500",
      RATE_LIMIT_ANALYSIS: "3/300",
      RATE_LIMIT_DOWNLOAD: "4/40",
      RATE_LIMIT_GENERATION_START: "2/20",
    });
    expect(policies).toEqual({
      "sign-in.address": withCooldown("sign-in.address", 7, 700),
      "sign-in.client": withCooldown("sign-in.client", 7, 700),
      "mfa-code.user": withCooldown("mfa-code.user", 6, 600),
      "password-reset-email.address": plain("password-reset-email.address", 4, 400),
      "password-reset-email.client": plain("password-reset-email.client", 9, 900),
      "verification-email.address": plain("verification-email.address", 2, 200),
      "sign-up.client": plain("sign-up.client", 8, 800),
      "upload.user": plain("upload.user", 6, 600),
      "invitation.user": plain("invitation.user", 5, 500),
      "analysis.user": plain("analysis.user", 3, 300),
      "download.user": plain("download.user", 4, 40),
      "generation-start.user": plain("generation-start.user", 2, 20),
    });
  });

  it("take each setting's count and window, the cap rising to a window longer than an hour", () => {
    const policies = rateLimitPolicies({
      ...RATE_LIMIT_DEFAULTS,
      RATE_LIMIT_SIGN_IN: "1/1",
      RATE_LIMIT_MFA_CODE: "99999/999999",
      RATE_LIMIT_PASSWORD_RESET_EMAIL_PER_IP: "40/60",
    });
    expect(policies["sign-in.client"]).toEqual(withCooldown("sign-in.client", 1, 1));
    expect(policies["mfa-code.user"]).toEqual({
      ...withCooldown("mfa-code.user", 99_999, 999_999),
      cooldownMaxSeconds: 999_999,
    });
    expect(policies["password-reset-email.client"]).toEqual(plain("password-reset-email.client", 40, 60));
    expect(policies["password-reset-email.address"]).toEqual(plain("password-reset-email.address", 3, 3600));
  });

  it.each(["", "0/900", "5/0", "5", "5/900/3600", " 5/900", "05/900", "100000/900", "5/1000000", "5.0/900", "a/b"])(
    "refuse %j with the policy check's own error",
    (text) => {
      expect(() => rateLimitPolicies({ ...RATE_LIMIT_DEFAULTS, RATE_LIMIT_VERIFICATION_EMAIL: text })).toThrow(
        OUT_OF_RANGE,
      );
    },
  );
});
