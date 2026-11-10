import { AppError } from "@app/shared";
import { isDeliverableEmailAddress } from "../email/outgoing-email";
import { AuditAction, recordAudit } from "./audit";
import type { IdentityServiceDeps } from "./ports";
import type { Session, User } from "./types";
import { normalizeEmail } from "./util";

export interface AuthServiceOptions {
  readonly sessionTtlSeconds: number;
}

export interface RegisterInput {
  readonly email: string;
  readonly name: string;
  readonly password: string;
}

export interface LoginResult {
  readonly user: User;
  readonly session: Session;
  /** Raw session token — returned once; only its hash is stored. */
  readonly token: string;
}

const MIN_PASSWORD_LENGTH = 10;

function emailTaken(): AppError {
  return new AppError("VALIDATION_FAILED", "Email is already registered");
}

export class AuthService {
  constructor(
    private readonly deps: IdentityServiceDeps,
    private readonly options: AuthServiceOptions,
  ) {}

  async register(input: RegisterInput): Promise<User> {
    const email = normalizeEmail(input.email);
    // An address no email can be sent to could never be verified (ADR-0129).
    if (!isDeliverableEmailAddress(email)) {
      throw new AppError("VALIDATION_FAILED", "Enter an email address that can receive email");
    }
    if (input.password.length < MIN_PASSWORD_LENGTH) {
      throw new AppError("VALIDATION_FAILED", "Password is too short");
    }
    // Checked first only to spare hashing a password for a taken email; the
    // registration below is what decides (ADR-0130).
    if (await this.deps.repos.users.findByEmail(email)) throw emailTaken();
    const id = this.deps.ids.generate("usr");
    const registration = await this.deps.repos.users.register({
      user: { id, email, name: input.name.trim(), status: "ACTIVE" },
      passwordHash: await this.deps.passwords.hash(input.password),
      audit: {
        organizationId: null,
        actorUserId: id,
        action: AuditAction.UserRegistered,
        resourceType: "user",
        resourceId: id,
        metadata: { email },
      },
    });
    if (registration.outcome === "EMAIL_TAKEN") throw emailTaken();
    return registration.user;
  }

  async login(email: string, password: string): Promise<LoginResult> {
    const user = await this.deps.repos.users.findByEmail(normalizeEmail(email));
    const credential = user ? await this.deps.repos.credentials.findByUserId(user.id) : null;
    // Always run a verify to reduce user-enumeration timing differences.
    const ok =
      user !== null &&
      user.status === "ACTIVE" &&
      credential !== null &&
      (await this.deps.passwords.verify(password, credential.passwordHash));
    if (!ok || !user) {
      throw new AppError("UNAUTHENTICATED", "Invalid email or password");
    }
    const token = this.deps.tokens.generate();
    const now = this.deps.clock.now();
    const session = await this.deps.repos.sessions.create({
      id: this.deps.ids.generate("ses"),
      userId: user.id,
      tokenHash: this.deps.tokens.hash(token),
      expiresAt: new Date(now.getTime() + this.options.sessionTtlSeconds * 1000),
    });
    await recordAudit(this.deps, {
      organizationId: null,
      actorUserId: user.id,
      action: AuditAction.UserLoggedIn,
      resourceType: "session",
      resourceId: session.id,
    });
    return { user, session, token };
  }

  async resolveSession(token: string): Promise<{ user: User; session: Session } | null> {
    const session = await this.deps.repos.sessions.findByTokenHash(this.deps.tokens.hash(token));
    if (!session) return null;
    if (session.expiresAt.getTime() <= this.deps.clock.now().getTime()) return null;
    const user = await this.deps.repos.users.findById(session.userId);
    if (!user || user.status !== "ACTIVE") return null;
    return { user, session };
  }

  async logout(token: string): Promise<void> {
    const tokenHash = this.deps.tokens.hash(token);
    const session = await this.deps.repos.sessions.findByTokenHash(tokenHash);
    await this.deps.repos.sessions.deleteByTokenHash(tokenHash);
    if (session) {
      await recordAudit(this.deps, {
        organizationId: null,
        actorUserId: session.userId,
        action: AuditAction.SessionRevoked,
        resourceType: "session",
        resourceId: session.id,
      });
    }
  }
}
