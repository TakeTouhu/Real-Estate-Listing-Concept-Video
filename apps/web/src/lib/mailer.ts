import type { EmailSender } from "@app/domain";
import { AppError } from "@app/shared";
import { createWebAdapters } from "./adapters";
import { getServerEnv } from "./env";

/**
 * How the web app mails a link: the email goes through the web app's email
 * adapter (ADR-0150), today the development outbox, `EMAIL_OUTBOX_DIR`
 * (ADR-0126), and the link starts with `APP_BASE_URL` (ADR-0129); production
 * has no email service yet. With either unset, both fail with
 * `CONFIGURATION_ERROR` before anything is written, and the outbox is opened
 * only to send.
 */
export interface Mailer extends EmailSender {
  /** The page at `path` with `token`, on the configured base address and never on a request's. */
  readonly link: (path: string, token: string) => string;
}

/** The address of the page at `path` with `token`, on `baseUrl`. */
export function tokenLink(baseUrl: string, path: string, token: string): string {
  const url = new URL(path, baseUrl);
  url.searchParams.set("token", token);
  return url.toString();
}

function emailNotConfigured(): AppError {
  return new AppError("CONFIGURATION_ERROR", "Email cannot be sent right now");
}

export function getMailer(): Mailer {
  const env = getServerEnv();
  const adapters = createWebAdapters(env);
  const baseUrl = env.APP_BASE_URL;
  const mailing = adapters.choice.email !== "none" && baseUrl !== undefined ? { baseUrl } : null;
  return {
    send: async (message) => {
      const sender = mailing ? adapters.email() : null;
      if (!sender) throw emailNotConfigured();
      await sender.send(message);
    },
    link: (path, token) => {
      if (!mailing) throw emailNotConfigured();
      return tokenLink(mailing.baseUrl, path, token);
    },
  };
}
