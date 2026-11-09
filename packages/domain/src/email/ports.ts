import type { OutgoingEmail } from "./outgoing-email";

/**
 * Where the product's emails go (ADR-0126). Domain code sends through this and
 * never through a delivery service's own client.
 *
 * In development and CI the only implementation is the outbox folder in
 * `@app/storage`, refused in production. No production service is chosen yet;
 * until one is, production has no sender at all.
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
