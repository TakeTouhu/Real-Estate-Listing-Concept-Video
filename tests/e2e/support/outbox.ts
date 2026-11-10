import type { EmailKind } from "@app/domain";
import { readDevelopmentEmailOutbox } from "@app/storage";
import { E2E_BASE_URL, E2E_EMAIL_OUTBOX_DIR } from "./environment";

/**
 * The link last mailed to `to` of this kind, read from the web app's outbox as
 * a person reads their inbox (ADR-0126, ADR-0129, ADR-0133). The link is a
 * one-time secret: it is never printed, and a failure names neither it nor the
 * folder.
 */
async function mailedLink(kind: EmailKind, path: string, to: string): Promise<string> {
  const mail = (await readDevelopmentEmailOutbox(E2E_EMAIL_OUTBOX_DIR)).filter(
    (message) => message.kind === kind && message.to === to,
  );
  const prefix = `${E2E_BASE_URL}${path}?token=`;
  const link = mail.at(-1)?.text.split("\n").find((line) => line.startsWith(prefix));
  if (link === undefined) throw new Error(`No ${kind} link was mailed to the account`);
  return link;
}

/** The verification link last mailed to `to`. */
export function verificationLink(to: string): Promise<string> {
  return mailedLink("EMAIL_VERIFICATION", "/verify-email", to);
}

/** The password reset link last mailed to `to`. */
export function passwordResetLink(to: string): Promise<string> {
  return mailedLink("PASSWORD_RESET", "/reset-password", to);
}
