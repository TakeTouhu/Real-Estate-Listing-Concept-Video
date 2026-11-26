export const REDACTED = "[REDACTED]";

/**
 * Object keys whose values must never be logged. Matches are case-insensitive
 * and substring-based so e.g. `authorization`, `apiKey`, `wavespeedApiKey`,
 * `webhookSecret`, `signedUrl` are all covered.
 *
 * Ref: SecurityCompliance.md — "Never log Authorization headers, API keys,
 * signed input URLs, temporary output URLs, or raw provider payloads."
 */
const SENSITIVE_KEY_PATTERNS = [
  "authorization",
  "apikey",
  "api_key",
  "secret",
  "token",
  "password",
  "signedurl",
  "signed_url",
  "outputurl",
  "output_url",
  "inputurl",
  "input_url",
  "downloadurl",
  "download_url",
  "predictionid",
  "prediction_id",
];

function isSensitiveKey(key: string): boolean {
  const k = key.toLowerCase();
  return SENSITIVE_KEY_PATTERNS.some((p) => k.includes(p));
}

/**
 * Redact a URL string: strip query/fragment (which carry signatures and
 * tokens) and keep only origin + path so logs remain useful without leaking
 * credentials. A user name or password in the URL is dropped even when there
 * is no query or fragment (ADR-0182 Decision 3). A value that is not a
 * parseable URL is returned unchanged.
 */
export function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.search || url.hash) return `${url.origin}${url.pathname}?${REDACTED}`;
    if (!url.username && !url.password) return value;
    url.username = "";
    url.password = "";
    return url.href;
  } catch {
    return value;
  }
}

const MAX_DEPTH = 6;

/**
 * Deep-redact an arbitrary value for safe logging. Sensitive keys are replaced
 * with REDACTED, URL strings have their signed query strings stripped, and
 * cyclic/over-deep structures are truncated.
 */
export function redact(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value !== "object") {
    if (typeof value === "string" && /^https?:\/\//i.test(value)) {
      return redactUrl(value);
    }
    return value;
  }
  if (depth >= MAX_DEPTH) return "[TRUNCATED]";
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((v) => redact(v, depth + 1, seen));
  }

  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    out[key] = isSensitiveKey(key) ? REDACTED : redact(v, depth + 1, seen);
  }
  return out;
}
