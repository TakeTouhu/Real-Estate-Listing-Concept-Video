import { cookies } from "next/headers";
import { timingSafeEqualString } from "@app/shared";
import type { Session, User } from "@app/domain";
import { getServerEnv } from "./env";
import { getIdentityServices } from "./identity";

/** Cookie holding the raw user session token (only its hash is persisted). */
export const SESSION_COOKIE = "rev_session";

/**
 * Extract a bearer token from an Authorization header value.
 * Pure helper so it can be unit-tested without the Next runtime.
 */
export function bearerFrom(header: string | null): string | undefined {
  if (!header) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1];
}

/**
 * Constant-time comparison of a presented token against the configured
 * operator token, used only by the infrastructure readiness probe.
 */
export function verifyOperatorToken(provided: string | undefined): boolean {
  if (!provided) return false;
  return timingSafeEqualString(provided, getServerEnv().HEALTHCHECK_API_TOKEN);
}

export interface SessionCookieOptions {
  readonly httpOnly: true;
  readonly sameSite: "lax";
  readonly secure: boolean;
  readonly path: string;
  readonly maxAge: number;
}

export function sessionCookieOptions(): SessionCookieOptions {
  const env = getServerEnv();
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: env.NODE_ENV === "production",
    path: "/",
    maxAge: env.USER_SESSION_TTL_SECONDS,
  };
}

export interface CurrentUser {
  readonly user: User;
  readonly session: Session;
}

/** Resolve the authenticated user from the session cookie, or null. */
export async function getCurrentUser(): Promise<CurrentUser | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return getIdentityServices().auth.resolveSession(token);
}
