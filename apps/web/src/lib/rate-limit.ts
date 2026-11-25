import {
  normalizeEmail,
  RateLimiter,
  rateLimitPolicies,
  type RateLimiterDecision,
  type RateLimitKey,
  type RateLimitPolicies,
  type RateLimitPolicyName,
  type RateLimitStore,
} from "@app/domain";
import { createPrismaRateLimitStore, getRateLimitPrismaClient, statementLimitedDatabaseUrl } from "@app/database";
import { createLogger, type Logger } from "@app/observability";
import {
  rateLimitSubject,
  rateLimitSubjectKey,
  type RateLimitSetting,
  type RateLimitSubjectFamily,
  type ServerEnv,
} from "@app/shared";
import { clientAddressKey } from "./client-address";
import { getServerEnv } from "./env";

/**
 * How many connections the limiter's own database client keeps (ADR-0171
 * Decision 6). A hit holds one for about a millisecond, so three serve many
 * sign-ins at once, and a flood on one key waits for these three, never for
 * the web app's own connections.
 */
export const RATE_LIMIT_DATABASE_CONNECTIONS = 3;

/**
 * How long PostgreSQL lets one of the limiter's statements run, in
 * milliseconds, before it ends it: a limit the database keeps for one query,
 * as ADR-0153 allows. A hit that waits longer fails, and the route refuses
 * the attempt through its own answer (ADR-0169 Decision 7).
 */
export const RATE_LIMIT_STATEMENT_MILLISECONDS = 1000;

/** What a limit guards, as its refusal is logged. */
export type RateLimitedAction = "SIGN_IN" | "MFA_CODE" | "PASSWORD_RESET_EMAIL" | "VERIFICATION_EMAIL" | "SIGN_UP";

/** An attempt the limits let through, with what its success settles; or the text that refuses it. */
export type LimitedAttempt =
  | { readonly allowed: true; readonly succeeded: () => Promise<void> }
  | { readonly allowed: false; readonly message: string };

/** A request the limits let through, with nothing to give back, or the text that refuses it (ADR-0173). */
export type LimitedRequest = { readonly allowed: true } | { readonly allowed: false; readonly message: string };

/** An email the limits let through, or the whole minutes until another may be asked for. */
export type LimitedEmail = { readonly allowed: true } | { readonly allowed: false; readonly minutes: number };

/** The settings the limits are read from. */
export type RateLimitSettings = Pick<ServerEnv, RateLimitSetting | "SESSION_SECRET" | "FORWARDED_FOR_TRUSTED_ENTRIES">;

const REFUSALS: Readonly<Record<RateLimitedAction, string>> = {
  SIGN_IN: "Too many sign-in attempts.",
  MFA_CODE: "Too many wrong codes.",
  PASSWORD_RESET_EMAIL: "Too many reset requests.",
  VERIFICATION_EMAIL: "Too many verification emails.",
  SIGN_UP: "Too many sign-ups.",
};

/** Whole minutes until `retryAt`, rounded up, at least one. */
export function refusalMinutes(retryAt: Date, now: Date): number {
  return Math.max(1, Math.ceil((retryAt.getTime() - now.getTime()) / 60_000));
}

/** The text of a refusal that waits `minutes`, as a page shows it from `?retry=` (ADR-0172). */
export function refusalText(action: RateLimitedAction, minutes: number): string {
  return `${REFUSALS[action]} Try again in ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`;
}

/** The text a refused attempt is answered with. It names no address, IP, subject or user. */
export function refusalMessage(action: RateLimitedAction, retryAt: Date, now: Date): string {
  return refusalText(action, refusalMinutes(retryAt, now));
}

/**
 * The whole minutes a page's `?retry=` names (ADR-0172 Decision 2), or `null`
 * for anything but 1 to 99,999, which covers the longest window a setting
 * takes.
 */
export function retryMinutes(param: string | readonly string[] | undefined): number | null {
  return typeof param === "string" && /^[1-9][0-9]{0,4}$/.test(param) ? Number(param) : null;
}

let logger: Logger | undefined;
const limiterLog = (): Pick<Logger, "warn"> => (logger ??= createLogger({ base: { component: "rate-limit" } }));

/**
 * The web app's abuse limits (ADR-0171): the limiter over a store, its
 * policies and the key every subject is made with. Every line it logs is a
 * code: never a header, an address, an IP, a subject or a user id.
 */
export class WebRateLimits {
  readonly limiter: RateLimiter;
  readonly policies: RateLimitPolicies;
  private readonly subjectKey: Buffer;
  private readonly trustedEntries: number | undefined;

  constructor(
    store: RateLimitStore,
    settings: RateLimitSettings,
    private readonly log: Pick<Logger, "warn"> = limiterLog(),
  ) {
    this.limiter = new RateLimiter(store);
    this.policies = rateLimitPolicies(settings);
    this.subjectKey = rateLimitSubjectKey(settings.SESSION_SECRET);
    const trusted = settings.FORWARDED_FOR_TRUSTED_ENTRIES;
    this.trustedEntries = trusted === undefined ? undefined : Number(trusted);
  }

  private key(policy: RateLimitPolicyName, family: RateLimitSubjectFamily, value: string): RateLimitKey {
    return { policy: this.policies[policy], subject: rateLimitSubject(this.subjectKey, family, value) };
  }

  /** The key of a typed address, normalized as sign-in looks it up, whether or not an account uses it. */
  addressKey(policy: RateLimitPolicyName, typed: string): RateLimitKey {
    return this.key(policy, "address", normalizeEmail(typed));
  }

  /**
   * The key of the request's client address, or none (ADR-0170 Decision 4).
   * Without one the request keeps its other keys; the reason is logged unless
   * the setting is simply not set.
   */
  clientKey(policy: RateLimitPolicyName, headers: Pick<Headers, "get">): RateLimitKey | undefined {
    const address = clientAddressKey(headers, this.trustedEntries);
    if (address.kind === "key") return this.key(policy, "client", address.key);
    if (address.reason !== "NOT_CONFIGURED") {
      this.log.warn("A request has no client address", { code: "CLIENT_ADDRESS_UNAVAILABLE", reason: address.reason });
    }
    return undefined;
  }

  /** The key of a user, by id. */
  userKey(policy: RateLimitPolicyName, userId: string): RateLimitKey {
    return this.key(policy, "user", userId);
  }

  /** The text of a refusal, logged once by its code, the action and the refusing key's dimension. */
  refuse(action: RateLimitedAction, decision: Extract<RateLimiterDecision, { allowed: false }>, now: Date): string {
    const { name } = decision.refusedBy.policy;
    const dimension = name.slice(name.lastIndexOf(".") + 1);
    this.log.warn("An attempt was refused by a rate limit", { code: "RATE_LIMITED", action, dimension });
    return refusalMessage(action, decision.retryAt, now);
  }

  /**
   * One sign-in, counted by its client address, then by the typed address,
   * before the password is looked up (ADR-0171 Decision 1). Its success
   * forgets the address and gives back the client address's hit; a wrong
   * password keeps both.
   */
  async signIn(headers: Pick<Headers, "get">, typedAddress: string, now: Date): Promise<LimitedAttempt> {
    const client = this.clientKey("sign-in.client", headers);
    const address = this.addressKey("sign-in.address", typedAddress);
    const decision = await this.limiter.hit(client === undefined ? [address] : [client, address], now);
    if (!decision.allowed) return { allowed: false, message: this.refuse("SIGN_IN", decision, now) };
    return {
      allowed: true,
      succeeded: async () => {
        await this.limiter.forget(address);
        for (const hit of decision.hits) if (hit.policy === client?.policy) await this.limiter.giveBack(hit);
      },
    };
  }

  /** One MFA code at sign-in, counted by its user before it is checked; an accepted code forgets the user. */
  async mfaCode(userId: string, now: Date): Promise<LimitedAttempt> {
    const user = this.userKey("mfa-code.user", userId);
    const decision = await this.limiter.hit([user], now);
    if (!decision.allowed) return { allowed: false, message: this.refuse("MFA_CODE", decision, now) };
    return { allowed: true, succeeded: () => this.limiter.forget(user) };
  }

  /**
   * One reset request, counted by its client address, then by the typed
   * address, whether or not an account uses it, before any lookup (ADR-0172
   * Decision 1). No success gives a hit back; a refusal by the typed address
   * gives back the client address's, as every refusal does.
   */
  passwordResetEmail(headers: Pick<Headers, "get">, typedAddress: string, now: Date): Promise<LimitedEmail> {
    const client = this.clientKey("password-reset-email.client", headers);
    const address = this.addressKey("password-reset-email.address", typedAddress);
    return this.email("PASSWORD_RESET_EMAIL", client === undefined ? [address] : [client, address], now);
  }

  /** One verification email, counted by the account's address, sign-up's own included (ADR-0172 Decision 3). */
  verificationEmail(storedAddress: string, now: Date): Promise<LimitedEmail> {
    return this.email("VERIFICATION_EMAIL", [this.addressKey("verification-email.address", storedAddress)], now);
  }

  /**
   * One sign-up, counted by its client address before its form is read
   * (ADR-0173 Decision 2). Without a client address it is not counted at all.
   * Nothing gives the hit back, whatever the sign-up's outcome.
   */
  async signUp(headers: Pick<Headers, "get">, now: Date): Promise<LimitedRequest> {
    const client = this.clientKey("sign-up.client", headers);
    if (client === undefined) return { allowed: true };
    const decision = await this.limiter.hit([client], now);
    return decision.allowed ? { allowed: true } : { allowed: false, message: this.refuse("SIGN_UP", decision, now) };
  }

  /** Forgets an address's failed sign-ins, as a completed reset does (ADR-0172 Decision 4). */
  forgetSignInAddress(address: string): Promise<void> {
    return this.limiter.forget(this.addressKey("sign-in.address", address));
  }

  private async email(action: RateLimitedAction, keys: RateLimitKey[], now: Date): Promise<LimitedEmail> {
    const decision = await this.limiter.hit(keys, now);
    if (decision.allowed) return { allowed: true };
    this.refuse(action, decision, now);
    return { allowed: false, minutes: refusalMinutes(decision.retryAt, now) };
  }
}

/**
 * The limiter's answer, or its failure as a plain `Error`, so a route that
 * shows an `AppError`'s text answers its own failure instead of the limiter's
 * (ADR-0173 Decision 9, as ADR-0171 Decision 8 intends).
 */
export function withoutLimiterText<T>(answer: Promise<T>): Promise<T> {
  return answer.catch(() => {
    throw new Error("The rate limiter could not answer");
  });
}

let limits: WebRateLimits | undefined;

/**
 * The process's limits, built on first use over the PostgreSQL store on the
 * limiter's own small database client (ADR-0171 Decision 6).
 */
export function getRateLimiter(): WebRateLimits {
  if (limits) return limits;
  const env = getServerEnv();
  const url =
    env.DATABASE_URL &&
    statementLimitedDatabaseUrl(env.DATABASE_URL, RATE_LIMIT_DATABASE_CONNECTIONS, RATE_LIMIT_STATEMENT_MILLISECONDS);
  return (limits = new WebRateLimits(createPrismaRateLimitStore(getRateLimitPrismaClient(url)), env));
}
