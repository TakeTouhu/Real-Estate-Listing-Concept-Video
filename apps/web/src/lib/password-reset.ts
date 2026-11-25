import { MIN_PASSWORD_LENGTH, PasswordResetService } from "@app/domain";
import { createLogger, type Logger } from "@app/observability";
import { AppError } from "@app/shared";
import { getIdentityServices } from "./identity";
import { getMailer, tokenLink } from "./mailer";
import { getRateLimiter, refusalText, retryMinutes } from "./rate-limit";
import { pathWithQuery } from "./redirect";

/** The page that asks for a reset link and that the link opens (ADR-0133). */
export const RESET_PASSWORD_PATH = "/reset-password";

/**
 * What the reset page says, by the code a route sends it back with
 * (`?notice=`). The page shows only these: never text the address carries.
 * `sent` is the answer to every request, whether or not an account uses the
 * address and whatever went wrong (ADR-0131). `invalid` covers every link that
 * resets nothing, whatever the reason (ADR-0132). `limited` answers a request
 * a limit refused, the same for every address (ADR-0172 Decision 2).
 */
export const RESET_PASSWORD_NOTICES = {
  sent: "If an account uses that email address, we sent it a link to choose a new password. It works once, for 1 hour.",
  invalid: "This link does not work. It may have expired or been used already. You can ask for a new one.",
  "too-short":
    `The new password must be at least ${MIN_PASSWORD_LENGTH} characters. ` +
    "The link still works: open it again from the email.",
  failed: "Something went wrong, and your password was not changed. Open the link again from the email to try again.",
  reset: "Your password was changed, and your account was signed out everywhere. Sign in with your new password.",
  limited: "Too many reset requests. Try again later.",
} as const;

export type ResetPasswordNotice = keyof typeof RESET_PASSWORD_NOTICES;

/** The notice a `?notice=` code names, or `null` for anything else. */
export function resetPasswordNotice(param: string | readonly string[] | undefined): ResetPasswordNotice | null {
  return typeof param === "string" && Object.hasOwn(RESET_PASSWORD_NOTICES, param)
    ? (param as ResetPasswordNotice)
    : null;
}

/** A notice's text; `limited` names the wait a whole number of minutes in `?retry=` gives. */
export function resetPasswordNoticeText(notice: ResetPasswordNotice, retry?: string | readonly string[]): string {
  const minutes = retryMinutes(retry);
  return notice === "limited" && minutes !== null
    ? refusalText("PASSWORD_RESET_EMAIL", minutes)
    : RESET_PASSWORD_NOTICES[notice];
}

/**
 * The reset page's path with `notice`, and the minutes a refusal waits: a
 * redirect's, never an emailed link.
 */
export function resetPasswordPage(notice: ResetPasswordNotice, retry?: number): string {
  return pathWithQuery(RESET_PASSWORD_PATH, { notice, retry: retry?.toString() });
}

/** The address of the reset page for `token`, on the configured base address and never on a request's. */
export function resetUrl(baseUrl: string, token: string): string {
  return tokenLink(baseUrl, RESET_PASSWORD_PATH, token);
}

/**
 * Password reset in the web app (ADR-0133), mailing through `getMailer`. With
 * no email sender or no `APP_BASE_URL`, asking for a link fails with
 * `CONFIGURATION_ERROR` before anything is written. Opening a link needs
 * neither.
 */
export function getPasswordResetService(): PasswordResetService {
  const mailer = getMailer();
  return new PasswordResetService({
    ...getIdentityServices().deps,
    email: mailer,
    resetUrl: (token) => mailer.link(RESET_PASSWORD_PATH, token),
  });
}

let logger: Logger | undefined;

function getPasswordResetLogger(): Pick<Logger, "error"> {
  logger ??= createLogger({ base: { component: "password-reset" } });
  return logger;
}

const errorCode = (error: unknown) => (error instanceof AppError ? error.code : "UNEXPECTED");

/**
 * Ask for a reset link for `address`. It resolves the same way whatever
 * happened, so the caller cannot tell whether an account uses the address
 * (ADR-0131). A failure is logged by its error code alone: never the address,
 * the link or the message.
 */
export async function askForResetLink(
  address: string,
  log: Pick<Logger, "error"> = getPasswordResetLogger(),
): Promise<void> {
  try {
    await getPasswordResetService().requestReset(address);
  } catch (error) {
    log.error("A password reset link could not be sent", { code: errorCode(error) });
  }
}

/**
 * Ask for a reset link, counted first by the request's client address, when
 * it has one, then by the typed address, whether or not an account uses it
 * (ADR-0172). The whole minutes to wait when a limit refuses it; otherwise
 * `null`, as `askForResetLink` resolves. A limiter that cannot answer sends
 * nothing, and its failure is logged by its error code alone.
 */
export async function askForLimitedResetLink(
  headers: Pick<Headers, "get">,
  address: string,
  log: Pick<Logger, "error"> = getPasswordResetLogger(),
): Promise<number | null> {
  try {
    const now = getIdentityServices().deps.clock.now();
    const attempt = await getRateLimiter().passwordResetEmail(headers, address, now);
    if (!attempt.allowed) return attempt.minutes;
  } catch (error) {
    log.error("A password reset request could not be counted", { code: errorCode(error) });
    return null;
  }
  await askForResetLink(address, log);
  return null;
}

/**
 * Whether an opened link would reset a password, writing nothing (ADR-0133).
 * `failed` when that could not be told, logged by its error code alone.
 */
export async function openResetLink(
  token: string | readonly string[],
  log: Pick<Logger, "error"> = getPasswordResetLogger(),
): Promise<"usable" | "invalid" | "failed"> {
  if (typeof token !== "string") return "invalid";
  try {
    return (await getPasswordResetService().checkResetLink(token)) === "USABLE" ? "usable" : "invalid";
  } catch (error) {
    log.error("A password reset link could not be checked", { code: errorCode(error) });
    return "failed";
  }
}

/**
 * Replace the password with a link, and say how it went (ADR-0132,
 * ADR-0133). A failure other than a password too short is logged by its error
 * code alone. A reset forgets the failed sign-ins of the link's address
 * (ADR-0172 Decision 4); when that fails, the password is still changed, and
 * the failure is logged by its code.
 */
export async function resetPasswordWith(
  token: string,
  password: string,
  log: Pick<Logger, "error"> = getPasswordResetLogger(),
): Promise<"reset" | "invalid" | "too-short" | "failed"> {
  let address: string | null;
  try {
    address = await getPasswordResetService().resetPasswordReturningAddress(token, password);
  } catch (error) {
    if (error instanceof AppError && error.code === "VALIDATION_FAILED") return "too-short";
    log.error("A password could not be reset", { code: errorCode(error) });
    return "failed";
  }
  if (address === null) return "invalid";
  try {
    await getRateLimiter().forgetSignInAddress(address);
  } catch (error) {
    log.error("A reset could not forget the address's failed sign-ins", { code: errorCode(error) });
  }
  return "reset";
}
