import { cookies } from "next/headers";
import { signSession, timingSafeEqualString, verifySession, type SessionPayload } from "@app/shared";
import { getServerEnv } from "./env";

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
 * operator token. Phase 0 uses a single shared operator credential; Phase 1
 * replaces this with the full identity/session system.
 */
export function verifyOperatorToken(provided: string | undefined): boolean {
  if (!provided) return false;
  return timingSafeEqualString(provided, getServerEnv().HEALTHCHECK_API_TOKEN);
}

export function createSessionToken(nowSeconds: number = Math.floor(Date.now() / 1000)): string {
  const env = getServerEnv();
  return signSession({ sub: "operator", exp: nowSeconds + env.SESSION_TTL_SECONDS }, env.SESSION_SECRET);
}

export async function getSession(): Promise<SessionPayload | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  return verifySession(token, getServerEnv().SESSION_SECRET);
}
