import { EmailVerificationService } from "@app/domain";
import { createLogger, type Logger } from "@app/observability";
import { AppError } from "@app/shared";
import { createDevelopmentEmailOutbox } from "@app/storage";
import { getServerEnv } from "./env";
import { getIdentityServices } from "./identity";

/** The page a verification link opens, and where an unverified sign-in waits (ADR-0129). */
export const VERIFY_EMAIL_PATH = "/verify-email";

/**
 * What the verify page says, by the code a route sends it back with
 * (`?notice=`). The page shows only these: never text the address carries.
 * `invalid` covers every link that verifies nothing, whatever the reason
 * (ADR-0128 Decision 4).
 */
export const VERIFY_EMAIL_NOTICES = {
  sent: "We sent a new link to your email address.",
  "not-sent": "The verification email could not be sent. Try again later.",
  invalid: "This link does not work. It may have expired or been used already.",
  verified: "Your email address is verified.",
} as const;

export type VerifyEmailNotice = keyof typeof VERIFY_EMAIL_NOTICES;

/** The notice a `?notice=` code names, or `null` for anything else. */
export function verifyEmailNotice(param: string | readonly string[] | undefined): VerifyEmailNotice | null {
  return typeof param === "string" && Object.hasOwn(VERIFY_EMAIL_NOTICES, param)
    ? (param as VerifyEmailNotice)
    : null;
}

/** The verify page with `notice`, on the address the request came to: a redirect, never an emailed link. */
export function verifyEmailPage(requestUrl: string, notice?: VerifyEmailNotice): URL {
  const url = new URL(VERIFY_EMAIL_PATH, requestUrl);
  if (notice !== undefined) url.searchParams.set("notice", notice);
  return url;
}

/**
 * The address of the verify page for `token`, on the configured base address
 * and never on a request's (ADR-0128 Decision 3).
 */
export function verificationUrl(baseUrl: string, token: string): string {
  const url = new URL(VERIFY_EMAIL_PATH, baseUrl);
  url.searchParams.set("token", token);
  return url.toString();
}

function emailNotConfigured(): AppError {
  return new AppError("CONFIGURATION_ERROR", "Email cannot be sent right now");
}

/**
 * Email verification in the web app (ADR-0129). Its email is written to the
 * development outbox, `EMAIL_OUTBOX_DIR` (ADR-0126); production has no email
 * service yet. With no outbox or no `APP_BASE_URL`, sending a link fails with
 * `CONFIGURATION_ERROR` before anything is written. Opening a link needs
 * neither, and the outbox is opened only to send.
 */
export function getEmailVerificationService(): EmailVerificationService {
  const env = getServerEnv();
  const folder = env.EMAIL_OUTBOX_DIR;
  const baseUrl = env.APP_BASE_URL;
  const mailing = folder !== undefined && baseUrl !== undefined ? { folder, baseUrl } : null;
  return new EmailVerificationService({
    ...getIdentityServices().deps,
    email: {
      send: async (message) => {
        if (!mailing) throw emailNotConfigured();
        await createDevelopmentEmailOutbox({ folder: mailing.folder, nodeEnv: env.NODE_ENV }).send(message);
      },
    },
    verificationUrl: (token) => {
      if (!mailing) throw emailNotConfigured();
      return verificationUrl(mailing.baseUrl, token);
    },
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
