import { isDeliverableEmailAddress, outgoingEmail, type OutgoingEmail } from "../email/outgoing-email";
import type { EmailSender } from "../email/ports";
import { AuditAction } from "./audit";
import type { IdentityServiceDeps } from "./ports";
import { normalizeEmail } from "./util";

/** How long a password reset link works (ADR-0131). */
export const PASSWORD_RESET_LINK_TTL_SECONDS = 60 * 60;

export interface PasswordResetDeps extends IdentityServiceDeps {
  readonly email: EmailSender;
  /**
   * The address of the page that resets the password with `token`. The
   * application builds it from its own configured base URL, never from a
   * request's headers.
   */
  readonly resetUrl: (token: string) => string;
}

/** The reset email: one link, in plain text. */
export function passwordResetMessage(to: string, url: string): OutgoingEmail {
  return outgoingEmail({
    kind: "PASSWORD_RESET",
    to,
    subject: "Reset your password",
    text: [
      "Open the link below to choose a new password for your account.",
      "",
      url,
      "",
      "The link works once and expires in 1 hour.",
      "Choosing a new password signs your account out everywhere.",
      "If you did not ask to reset your password, you can ignore this email.",
    ].join("\n"),
  });
}

/**
 * Password reset (ADR-0131, implementing ADR-0052 Decision 18): a link mailed
 * to the account's address. Using it to replace the password follows in
 * AT-4b-2; no page or route reaches this service until AT-4c.
 */
export class PasswordResetService {
  constructor(private readonly deps: PasswordResetDeps) {}

  /**
   * Mail a reset link to the account with this address. The caller learns
   * nothing: an address with no account, or with a disabled one, or one mail
   * cannot reach, makes and sends nothing and answers the same. A link is kept,
   * with its audit entry, before the email is sent. Each request makes a new
   * link; an earlier one is not withdrawn.
   */
  async requestReset(address: string): Promise<void> {
    const email = normalizeEmail(address);
    if (!isDeliverableEmailAddress(email)) return;
    const user = await this.deps.repos.users.findByEmail(email);
    if (!user || user.status !== "ACTIVE") return;
    const token = this.deps.tokens.generate();
    const message = passwordResetMessage(user.email, this.deps.resetUrl(token));
    const now = this.deps.clock.now();
    const id = this.deps.ids.generate("lnk");
    await this.deps.repos.accountLinks.create(
      {
        id,
        userId: user.id,
        purpose: "PASSWORD_RESET",
        tokenHash: this.deps.tokens.hash(token),
        email: user.email,
        createdAt: now,
        expiresAt: new Date(now.getTime() + PASSWORD_RESET_LINK_TTL_SECONDS * 1000),
      },
      {
        organizationId: null,
        // Anyone may ask: the request is not the account owner's act.
        actorUserId: null,
        action: AuditAction.PasswordResetLinkCreated,
        resourceType: "user",
        resourceId: user.id,
        metadata: { linkId: id, email: user.email },
      },
    );
    await this.deps.email.send(message);
  }
}
