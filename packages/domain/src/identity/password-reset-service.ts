import { AppError } from "@app/shared";
import { isDeliverableEmailAddress, outgoingEmail, type OutgoingEmail } from "../email/outgoing-email";
import type { EmailSender } from "../email/ports";
import { AuditAction } from "./audit";
import { MIN_PASSWORD_LENGTH } from "./auth-service";
import { ACCOUNT_LINK_TOKEN_MAX_LENGTH } from "./email-verification-service";
import type { IdentityServiceDeps } from "./ports";
import type { AccountLink, User } from "./types";
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

/**
 * `INVALID` covers every link that resets nothing: unknown, of another
 * purpose, used, expired, for an address the account no longer has, or for an
 * account that is disabled, gone or has no password. The reason is not told
 * apart.
 */
export type ResetLinkState = "USABLE" | "INVALID";
export type ResetPasswordOutcome = "RESET" | "INVALID";

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
 * Password reset (ADR-0131 and ADR-0132, implementing ADR-0052 Decision 18):
 * a link mailed to the account's address, which replaces the password once
 * and ends every session of the account. MFA is left as it is (ADR-0132).
 * The web app's `/reset-password` page and its routes reach it (AT-4c,
 * ADR-0133).
 */
export class PasswordResetService {
  constructor(private readonly deps: PasswordResetDeps) {}

  /**
   * Mail a reset link to the account with this address. The caller learns
   * nothing: an address with no account, or with a disabled one, or one mail
   * cannot reach, makes and sends nothing and answers the same. A link is kept,
   * with its audit entry, before the email is sent. An earlier link still
   * works until it is used or expires, or a reset deletes it.
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

  /** Whether a link would reset a password now. Writes nothing. */
  async checkResetLink(token: string): Promise<ResetLinkState> {
    return (await this.usableLink(token)) ? "USABLE" : "INVALID";
  }

  /**
   * Replace the password of the account a link was sent to, end every session
   * of the account and delete its other unused reset links, all in one
   * transaction. A password too short is refused (`VALIDATION_FAILED`) and
   * leaves the link unused.
   */
  async resetPassword(token: string, password: string): Promise<ResetPasswordOutcome> {
    const usable = await this.usableLink(token);
    if (!usable) return "INVALID";
    if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
      throw new AppError("VALIDATION_FAILED", "Password is too short");
    }
    const { link, user } = usable;
    // Hashed before the transaction opens, so it holds no lock meanwhile.
    const passwordHash = await this.deps.passwords.hash(password);
    const outcome = await this.deps.repos.accountLinks.useForPasswordReset({
      linkId: link.id,
      userId: user.id,
      email: link.email,
      usedAt: this.deps.clock.now(),
      passwordHash,
      audit: {
        organizationId: null,
        actorUserId: user.id,
        action: AuditAction.PasswordReset,
        resourceType: "user",
        resourceId: user.id,
        metadata: { linkId: link.id, email: link.email },
      },
    });
    // STALE: since the check, the link was used (this reset opened twice at
    // once) or deleted by another reset, its hour ended, or the account
    // changed.
    return outcome === "APPLIED" ? "RESET" : "INVALID";
  }

  private async usableLink(token: string): Promise<{ link: AccountLink; user: User } | null> {
    if (typeof token !== "string" || token.length === 0 || token.length > ACCOUNT_LINK_TOKEN_MAX_LENGTH) return null;
    const link = await this.deps.repos.accountLinks.findByTokenHash(this.deps.tokens.hash(token));
    if (!link || link.purpose !== "PASSWORD_RESET") return null;
    if (link.usedAt !== null || link.expiresAt.getTime() <= this.deps.clock.now().getTime()) return null;
    const user = await this.deps.repos.users.findById(link.userId);
    if (!user || user.status !== "ACTIVE" || user.email !== link.email) return null;
    if (!(await this.deps.repos.credentials.findByUserId(user.id))) return null;
    return { link, user };
  }
}
