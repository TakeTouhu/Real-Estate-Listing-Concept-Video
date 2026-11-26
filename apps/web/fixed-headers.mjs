/**
 * The fixed security headers and the API policy (ADR-0174 Decisions 8, 9 and
 * 11), which `next.config.mjs` sends through `headers()`.
 *
 * A header set here is applied before a route handler runs, and the handler's
 * header of the same name is then dropped (Next.js 15.5.28,
 * `send-response.js:46-52`). So nothing a handler must decide per answer is
 * named here: no `Cache-Control`, no `Content-Disposition`, and no page policy.
 * The API policy is a superset of the download route's own, so replacing it
 * never weakens it. `headers()` is frozen at `next build` for `next start`, so
 * the only thing these rules branch on is the `NODE_ENV` in effect when
 * `next build` runs. `next build` sets it to `production` only when it is
 * unset: a build run with another `NODE_ENV` sends no HSTS.
 *
 * Plain JavaScript, so the configuration can import it and a test can read it.
 */

/** @typedef {{ key: string, value: string }} FixedHeader */
/** @typedef {{ source: string, headers: FixedHeader[] }} FixedHeaderRule */

/** On every answer, in every environment. */
export const EVERY_ANSWER_HEADERS = [
  // A mislabelled answer is never run as a script or a style.
  { key: "X-Content-Type-Options", value: "nosniff" },
  // Another site learns at most the origin. Never `no-referrer`: the browser would then send
  // `Origin: null` on the site's own posts, which the origin check refuses (Decision 11).
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // No other site frames a page, for browsers that ignore `frame-ancestors`.
  { key: "X-Frame-Options", value: "DENY" },
  // Features the app never uses are off; the video player keeps its fullscreen button.
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), fullscreen=(self)",
  },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  // Another site cannot embed a signed image or video, even with a leaked link.
  { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
];

/** Every API answer is JSON, a redirect or stored bytes, never a page (Decision 9). */
export const API_POLICY = "default-src 'none'; frame-ancestors 'none'; sandbox";

/**
 * Production builds only, for the app's own host: no `includeSubDomains` and no
 * `preload` while the public domain is not chosen (Decision 12). A browser
 * ignores it over plain `http`. When either may be added is ADR-0190's rule;
 * `next-config.test.ts` pins the grammar the value may move within.
 */
export const STRICT_TRANSPORT_SECURITY = "max-age=31536000";

/**
 * The `headers()` rules for a build whose `NODE_ENV` is the one given. Each call
 * returns new objects, which Next.js may annotate.
 *
 * @param {string | undefined} nodeEnv
 * @returns {FixedHeaderRule[]}
 */
export function fixedHeaderRules(nodeEnv) {
  /** @type {FixedHeader[]} */
  const everyAnswer = EVERY_ANSWER_HEADERS.map(({ key, value }) => ({ key, value }));
  if (nodeEnv === "production") {
    everyAnswer.push({ key: "Strict-Transport-Security", value: STRICT_TRANSPORT_SECURITY });
  }
  /** @param {string} source @returns {FixedHeaderRule} */
  const apiPolicy = (source) => ({ source, headers: [{ key: "Content-Security-Policy", value: API_POLICY }] });
  const rules = [{ source: "/:path*", headers: everyAnswer }, apiPolicy("/api/:path*")];
  // A production build also sends the API policy where the middleware does not run, so an address there that
  // names no file is never a page without a policy (ADR-0188 Decision 4). Never under `next dev`, whose socket
  // and development files are there.
  if (nodeEnv === "production") rules.push(apiPolicy("/_next/:path*"), apiPolicy("/favicon.ico"));
  return rules;
}
