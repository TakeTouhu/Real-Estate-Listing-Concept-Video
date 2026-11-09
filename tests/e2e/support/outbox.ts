import { readDevelopmentEmailOutbox } from "@app/storage";
import { E2E_BASE_URL, E2E_EMAIL_OUTBOX_DIR } from "./environment";

/**
 * The verification link last mailed to `to`, read from the web app's outbox as
 * a person reads their inbox (ADR-0126, ADR-0129). The link is a one-time
 * secret: it is never printed, and a failure names neither it nor the folder.
 */
export async function verificationLink(to: string): Promise<string> {
  const mail = (await readDevelopmentEmailOutbox(E2E_EMAIL_OUTBOX_DIR)).filter(
    (message) => message.kind === "EMAIL_VERIFICATION" && message.to === to,
  );
  const prefix = `${E2E_BASE_URL}/verify-email?token=`;
  const link = mail.at(-1)?.text.split("\n").find((line) => line.startsWith(prefix));
  if (link === undefined) throw new Error("No verification link was mailed to the new account");
  return link;
}
