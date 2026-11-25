import type { OutgoingEmail } from "./outgoing-email";

/**
 * Where the product's emails go (ADR-0126). Domain code sends through this and
 * never through a delivery service's own client.
 *
 * Two implementations, in `@app/storage`: the outbox folder, for development
 * and CI and refused in production (ADR-0126), and the SMTP sender (ADR-0166),
 * which the web app uses when `SMTP_HOST` is set (ADR-0168). Which service
 * production sends through is not chosen yet.
 */
export interface EmailSender {
  /**
   * Hands one email over for delivery. Resolves once it is accepted. Rejects
   * when it was not; a delivery service may still have sent it, so every flow
   * that sends must tolerate the same email arriving twice, as asking for a
   * link again already does.
   */
  send(email: OutgoingEmail): Promise<void>;
}
