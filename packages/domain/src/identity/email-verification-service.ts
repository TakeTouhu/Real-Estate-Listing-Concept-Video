import { AppError } from "@app/shared";
import { outgoingEmail, type OutgoingEmail } from "../email/outgoing-email";
import type { EmailSender } from "../email/ports";
import { AuditAction } from "./audit";
import type { IdentityServiceDeps } from "./ports";

/** How long a verification link works (ADR-0128). */
export const EMAIL_VERIFICATION_LINK_TTL_SECONDS = 24 * 60 * 60;

export interface EmailVerificationDeps extends IdentityServiceDeps {
  readonly email: EmailSender;
  /**
   * The address of the page that verifies `token`. The application builds it
   * from its own configured base URL, never from a request's headers.
   */
  readonly verificationUrl: (token: string) => string;
}

/** `ALREADY_VERIFIED`: nothing was made or sent. */
export type SendVerificationOutcome = "SENT" | "ALREADY_VERIFIED";

/**
 * `INVALID` covers every link that verifies nothing: unknown, of another
 * purpose, used, expired, for an address the account no longer has, or for an
 * account that is disabled or gone. The reason is not told apart.
 */
export type VerifyEmailOutcome = "VERIFIED" | "ALREADY_VERIFIED" | "INVALID";

/** The verification email: one link, in plain text. */
export function emailVerificationMessage(to: string, url: string): OutgoingEmail {
  return outgoingEmail({
    kind: "EMAIL_VERIFICATION",
    to,
    subject: "Verify your email address",
    text: [
      "Open the link below to verify the email address of your account.",
      "",
      url,
      "",
      "The link works once and expires in 24 hours.",
      "If you did not create an account, you can ignore this email.",
    ].join("\n"),
  });
}

/**
 * Email verification (ADR-0128, implementing ADR-0052 Decision 18): a link
 * mailed to the account's address, which verifies that address when opened.
 */
export class EmailVerificationService {
  constructor(private readonly deps: EmailVerificationDeps) {}

  /**
   * Make a verification link for the user's address and mail it. A link is
   * kept, with its audit entry, before the email is sent, so no email carries
   * a link that was never recorded. An earlier link still works until it is
   * used or expires. An address mail cannot reach is refused before anything
   * is written.
   */
  async sendVerificationLink(userId: string): Promise<SendVerificationOutcome> {
    const user = await this.deps.repos.users.findById(userId);
    if (!user || user.status !== "ACTIVE") throw new AppError("NOT_FOUND", "Account not found");
    if (user.emailVerifiedAt !== null) return "ALREADY_VERIFIED";
    const token = this.deps.tokens.generate();
    const message = emailVerificationMessage(user.email, this.deps.verificationUrl(token));
    const now = this.deps.clock.now();
    const id = this.deps.ids.generate("lnk");
    await this.deps.repos.accountLinks.create(
      {
        id,
        userId,
        purpose: "EMAIL_VERIFICATION",
        tokenHash: this.deps.tokens.hash(token),
        email: user.email,
        createdAt: now,
        expiresAt: new Date(now.getTime() + EMAIL_VERIFICATION_LINK_TTL_SECONDS * 1000),
      },
      {
        organizationId: null,
        actorUserId: userId,
        action: AuditAction.EmailVerificationSent,
        resourceType: "user",
        resourceId: userId,
        metadata: { linkId: id },
      },
    );
    await this.deps.email.send(message);
    return "SENT";
  }

  /**
   * Verify the address a link was sent to. Opening a link again after it
   * verified the address answers `ALREADY_VERIFIED` and writes nothing.
   */
  async verifyEmail(token: string): Promise<VerifyEmailOutcome> {
    if (typeof token !== "string" || token.length === 0) return "INVALID";
    const link = await this.deps.repos.accountLinks.findByTokenHash(this.deps.tokens.hash(token));
    if (!link || link.purpose !== "EMAIL_VERIFICATION") return "INVALID";
    const user = await this.deps.repos.users.findById(link.userId);
    if (!user || user.status !== "ACTIVE" || user.email !== link.email) return "INVALID";
    if (user.emailVerifiedAt !== null) return "ALREADY_VERIFIED";
    const now = this.deps.clock.now();
    if (link.usedAt !== null || link.expiresAt.getTime() <= now.getTime()) return "INVALID";
    const outcome = await this.deps.repos.accountLinks.useForEmailVerification({
      linkId: link.id,
      userId: user.id,
      email: link.email,
      usedAt: now,
      audit: {
        organizationId: null,
        actorUserId: user.id,
        action: AuditAction.EmailVerified,
        resourceType: "user",
        resourceId: user.id,
        metadata: { linkId: link.id },
      },
    });
    if (outcome === "APPLIED") return "VERIFIED";
    // Another link, or this one opened twice at once, verified the address first.
    const current = await this.deps.repos.users.findById(user.id);
    return current?.emailVerifiedAt != null && current.email === link.email ? "ALREADY_VERIFIED" : "INVALID";
  }
}
