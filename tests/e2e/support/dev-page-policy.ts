/**
 * `next dev`'s page policy for a nonce (ADR-0174 Decision 10), which serves
 * the browser test, without its last directive, `report-to csp` (PT-7c3).
 * `csp-report.spec.ts` serves this to see a `report-uri` post.
 */
export const devReportUriPolicy = (nonce: string): string =>
  `default-src 'self'; script-src 'self' 'nonce-${nonce}' 'strict-dynamic' 'unsafe-eval'; ` +
  "style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self'; font-src 'self'; " +
  "connect-src 'self' ws: wss:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-src 'none'; " +
  "frame-ancestors 'none'; report-uri /api/csp-report";

/**
 * `next dev`'s whole page policy for a nonce, as the middleware sends it; it
 * reports (ADR-0189, PT-7c3). `security-headers.spec.ts` holds it equal to the
 * policy on `/login`, so the policy above cannot drift from the middleware's.
 */
export const devPagePolicy = (nonce: string): string => `${devReportUriPolicy(nonce)}; report-to csp`;
