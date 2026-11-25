/**
 * The pages' Content Security Policy (RD-9e, ADR-0174 Decision 10).
 *
 * `middleware.ts` makes a fresh nonce for every page request and sends this
 * policy twice: on the request, where Next.js 15.5.28 reads the nonce from the
 * `script-src` directive and puts it on every script it renders
 * (`app-render.js:108`, `get-script-nonce-from-header.js`), and on the answer,
 * for the browser. Scripts run only when they carry the nonce or are loaded by
 * one that does (`'strict-dynamic'`); `'self'` stays for a browser without CSP
 * level 3. Styles allow `'unsafe-inline'` in every environment, because
 * Next.js's own fallback page renders an inline `<style>` without a nonce.
 *
 * `next dev` (`NODE_ENV=development`) also needs `eval` and its Fast Refresh
 * socket; every other `NODE_ENV` gets the production policy. The `/api` policy
 * is the configuration's (`fixed-headers.mjs`), never this one.
 *
 * Imports nothing: the middleware runs on the Edge runtime.
 */

/** The bytes of randomness in a nonce. */
export const NONCE_BYTES = 16;

/** A nonce Next.js accepts: its own pattern, `get-script-nonce-from-header.js:11`. */
export const NONCE_PATTERN = /^[A-Za-z0-9+/_-]+={0,2}$/;

/** A fresh nonce: 16 random bytes, base64. */
export function newNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  return btoa(String.fromCharCode(...bytes));
}

type Directive = readonly [name: string, ...sources: string[]];

/** The policy in every environment; `{nonce}` is replaced per request. */
const PRODUCTION_DIRECTIVES: readonly Directive[] = [
  ["default-src", "'self'"],
  ["script-src", "'self'", "'nonce-{nonce}'", "'strict-dynamic'"],
  ["style-src", "'self'", "'unsafe-inline'"],
  // The MFA QR code is a `data:` image; every other image and the video are the app's own signed links.
  ["img-src", "'self'", "data:"],
  ["media-src", "'self'"],
  ["font-src", "'self'"],
  ["connect-src", "'self'"],
  ["object-src", "'none'"],
  ["base-uri", "'none'"],
  ["form-action", "'self'"],
  ["frame-src", "'none'"],
  ["frame-ancestors", "'none'"],
];

/**
 * What `next dev` adds, never sent by a production build: `eval` for its source
 * maps and React's development stacks, and the Fast Refresh socket at
 * `/_next/webpack-hmr`.
 */
const DEVELOPMENT_ADDITIONS: Readonly<Record<string, readonly string[]>> = {
  "script-src": ["'unsafe-eval'"],
  "connect-src": ["ws:", "wss:"],
};

/**
 * The page policy for one request. Refuses a nonce Next.js would not read, so
 * nothing but base64 ever reaches the header.
 */
export function pageContentSecurityPolicy(nonce: string, nodeEnv: string | undefined): string {
  if (!NONCE_PATTERN.test(nonce)) throw new Error("A page policy needs a base64 nonce");
  const development = nodeEnv === "development";
  return PRODUCTION_DIRECTIVES.map(([name, ...sources]) => {
    const all = development ? [...sources, ...(DEVELOPMENT_ADDITIONS[name] ?? [])] : sources;
    return [name, ...all.map((source) => source.replace("{nonce}", nonce))].join(" ");
  }).join("; ");
}
