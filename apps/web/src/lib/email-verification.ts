import { EmailVerificationService } from "@app/domain";
import { createLogger, type Logger } from "@app/observability";
import { AppError } from "@app/shared";
import { getIdentityServices } from "./identity";
import { getMailer, tokenLink } from "./mailer";
import { getRateLimiter, refusalText, retryMinutes } from "./rate-limit";
import { pathWithQuery } from "./redirect";

/** The page a verification link opens, and where an unverified sign-in waits (ADR-0129). */
export const VERIFY_EMAIL_PATH = "/verify-email";

/**
 * What the verify page says, by the code a route sends it back with
 * (`?notice=`). The page shows only these: never text the address carries.
 * `invalid` covers every link that verifies nothing, whatever the reason
 * (ADR-0128 Decision 4). `limited` answers a send a limit refused (ADR-0172).
 */
export const VERIFY_EMAIL_NOTICES = {
  sent: "We sent a new link to your email address.",
  "not-sent": "The verification email could not be sent. Try again later.",
  invalid: "This link does not work. It may have expired or been used already.",
  verified: "Your email address is verified.",
  limited: "Too many verification emails. Try again later.",
} as const;

export type VerifyEmailNotice = keyof typeof VERIFY_EMAIL_NOTICES;

/** The notice a `?notice=` code names, or `null` for anything else. */
export function verifyEmailNotice(param: string | readonly string[] | undefined): VerifyEmailNotice | null {
  return typeof param === "string" && Object.hasOwn(VERIFY_EMAIL_NOTICES, param)
    ? (param as VerifyEmailNotice)
    : null;
}

/** A notice's text; `limited` names the wait a whole number of minutes in `?retry=` gives. */
export function verifyEmailNoticeText(notice: VerifyEmailNotice, retry?: string | readonly string[]): string {
  const minutes = retryMinutes(retry);
  return notice === "limited" && minutes !== null
    ? refusalText("VERIFICATION_EMAIL", minutes)
    : VERIFY_EMAIL_NOTICES[notice];
}

/**
 * The verify page's path with `notice`, and the minutes a refusal waits: a
 * redirect's, never an emailed link.
 */
export function verifyEmailPage(notice?: VerifyEmailNotice, retry?: number): string {
  return pathWithQuery(VERIFY_EMAIL_PATH, { notice, retry: retry?.toString() });
}

/**
 * The address of the verify page for `token`, on the configured base address
 * and never on a request's (ADR-0128 Decision 3).
 */
export function verificationUrl(baseUrl: string, token: string): string {
  return tokenLink(baseUrl, VERIFY_EMAIL_PATH, token);
}

/**
 * Email verification in the web app (ADR-0129), mailing through `getMailer`:
 * with no email sender or no `APP_BASE_URL`, sending a link fails with
 * `CONFIGURATION_ERROR` before anything is written. Opening a link needs
 * neither.
 */
export function getEmailVerificationService(): EmailVerificationService {
  const mailer = getMailer();
  return new EmailVerificationService({
    ...getIdentityServices().deps,
    email: mailer,
    verificationUrl: (token) => mailer.link(VERIFY_EMAIL_PATH, token),
  });
}

let logger: Logger | undefined;

function getEmailVerificationLogger(): Pick<Logger, "error"> {
  logger ??= createLogger({ base: { component: "email-verification" } });
  return logger;
}

/**
 * Mail the user a verification link. `NOT_SENT` when it could not be, which is
 * logged by its error code and the user's id alone: never the address, the
 * link or the message.
 */
export async function sendVerificationLinkTo(
  userId: string,
  log: Pick<Logger, "error"> = getEmailVerificationLogger(),
): Promise<"SENT" | "ALREADY_VERIFIED" | "NOT_SENT"> {
  try {
    return await getEmailVerificationService().sendVerificationLink(userId);
  } catch (error) {
    const code = error instanceof AppError ? error.code : "UNEXPECTED";
    log.error("A verification email could not be sent", { code, userId });
    return "NOT_SENT";
  }
}

/** A verification email a limit refused, with the whole minutes to wait. */
export interface LimitedSend {
  readonly waitMinutes: number;
}

/**
 * Mail the user a verification link, counted first by the address it goes
 * to, the account's (ADR-0172 Decision 3). A limiter that cannot answer
 * sends nothing: `NOT_SENT`, logged by its error code alone.
 */
export async function sendLimitedVerificationLinkTo(
  user: { readonly id: string; readonly email: string },
  log: Pick<Logger, "error"> = getEmailVerificationLogger(),
): Promise<Awaited<ReturnType<typeof sendVerificationLinkTo>> | LimitedSend> {
  try {
    const attempt = await getRateLimiter().verificationEmail(user.email, getIdentityServices().deps.clock.now());
    if (!attempt.allowed) return { waitMinutes: attempt.minutes };
  } catch (error) {
    const code = error instanceof AppError ? error.code : "UNEXPECTED";
    log.error("A verification email could not be counted", { code });
    return "NOT_SENT";
  }
  return sendVerificationLinkTo(user.id, log);
}
