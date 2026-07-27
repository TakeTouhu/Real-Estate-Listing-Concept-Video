import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Constant-time string comparison. Returns false for length mismatches
 * without leaking timing information about the compared bytes.
 */
export function timingSafeEqualString(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, "utf8");
  const bBuf = Buffer.from(b, "utf8");
  if (aBuf.length !== bBuf.length) {
    // Compare against self to keep the code path timing-uniform.
    timingSafeEqual(aBuf, aBuf);
    return false;
  }
  return timingSafeEqual(aBuf, bBuf);
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function hmac(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export interface SessionPayload {
  readonly sub: string;
  readonly exp: number; // epoch seconds
}

/**
 * Sign a compact, tamper-evident session token: `<payload>.<hmac>`.
 * This is an interim Phase 0 mechanism for the authenticated health-check
 * app; Phase 1 replaces it with the full identity/session system.
 */
export function signSession(payload: SessionPayload, secret: string): string {
  const body = base64url(JSON.stringify(payload));
  return `${body}.${hmac(secret, body)}`;
}

export function verifySession(
  token: string | undefined,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): SessionPayload | null {
  if (!token) return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  if (!timingSafeEqualString(signature, hmac(secret, body))) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as SessionPayload).sub !== "string" ||
    typeof (parsed as SessionPayload).exp !== "number"
  ) {
    return null;
  }
  const payload = parsed as SessionPayload;
  if (payload.exp <= nowSeconds) return null;
  return payload;
}
