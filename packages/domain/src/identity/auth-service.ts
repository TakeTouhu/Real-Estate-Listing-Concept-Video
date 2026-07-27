import { AppError } from "@app/shared";
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

export class AuthService {
  constructor(
    private readonly deps: IdentityServiceDeps,
    private readonly options: AuthServiceOptions,
  ) {}

  async register(input: RegisterInput): Promise<User> {
    const email = normalizeEmail(input.email);
    if (input.password.length < MIN_PASSWORD_LENGTH) {
      throw new AppError("VALIDATION_FAILED", "Password is too short");
    }
    if (await this.deps.repos.users.findByEmail(email)) {
      throw new AppError("VALIDATION_FAILED", "Email is already registered");
    }
    const user = await this.deps.repos.users.create({
      id: this.deps.ids.generate("usr"),
      email,
      name: input.name.trim(),
      status: "ACTIVE",
    });
    await this.deps.repos.credentials.create({
      userId: user.id,
      passwordHash: await this.deps.passwords.hash(input.password),
    });
    await recordAudit(this.deps, {
      organizationId: null,
      actorUserId: user.id,
      action: AuditAction.UserRegistered,
      resourceType: "user",
      resourceId: user.id,
      metadata: { email },
    });
    return user;
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
