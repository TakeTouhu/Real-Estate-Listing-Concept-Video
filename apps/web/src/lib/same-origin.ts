/**
 * Whether a cookie-authenticated form post came from a page of this site
 * (ADR-0068 Decision 4).
 *
 * The session cookie is `SameSite=Lax`, which already keeps it off a form posted
 * from another site. This also refuses a post from another origin of the same
 * site, and one that names no origin at all. The host compared against is the
 * one the browser addressed: the first `X-Forwarded-Host` a proxy set, else
 * `Host`. A browser page cannot set either header on a cross-origin form post.
 */
export function isSameOriginPost(request: Request): boolean {
  const origin = request.headers.get("origin");
  const host = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim() || request.headers.get("host");
  if (origin === null || !host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
