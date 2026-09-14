/**
 * The fal output-download URL authority: fail-closed to signed `fal.media`
 * artifact URLs, and nothing else.
 *
 * A provider's output location is a bearer credential in URL form, and it is
 * also external text this application will dereference with a real network
 * request. Both facts demand the same discipline: decide, with no room for
 * interpretation, whether a candidate is a location this application is willing
 * to GET — and decide it the same way every time it matters, which is at least
 * twice (when the fal result is mapped, and again immediately before every
 * request the byte source makes).
 *
 * The rule is deliberately narrow. Broadening the host family, allowing a port,
 * or tolerating a non-`/files/` path are all one-line changes that would each
 * widen where this application can be steered into sending a request — so each
 * is refused here and a widening is a reviewed change to this function.
 *
 * Nothing about a candidate is logged, returned in a diagnostic, or attached to
 * an error. The answer is a boolean; the URL that produced it — signature and
 * all — never leaves the caller.
 */

/** The apex fal media host. Subdomains such as `v3.fal.media` are also allowed. */
const FAL_OUTPUT_APEX_HOST = "fal.media";
const FAL_OUTPUT_HOST_SUFFIX = ".fal.media";

/** The one path prefix a fal artifact URL uses. */
const FAL_OUTPUT_PATH_PREFIX = "/files/";

/**
 * Whether a candidate string is an authorized fal output URL.
 *
 * Accepts only:
 * - a syntactically valid absolute URL,
 * - over `https:`,
 * - whose host is exactly `fal.media` or ends in `.fal.media`,
 * - with no userinfo (username or password),
 * - with no explicit non-default port,
 * - with no fragment,
 * - whose path begins with `/files/`.
 *
 * Query parameters are allowed and untouched: the signed bearer credential
 * lives there, and it must reach the request exactly as issued.
 */
export function isAuthorizedFalOutputUrl(candidate: unknown): boolean {
  if (typeof candidate !== "string" || candidate.trim().length === 0) return false;

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return false;
  }

  if (url.protocol !== "https:") return false;
  // Userinfo is the classic authority-confusion vector: `https://fal.media@evil`
  // parses with host `evil`. Refuse any username or password outright.
  if (url.username !== "" || url.password !== "") return false;
  // A non-default port is refused rather than pinned: 443 renders as "" here,
  // and any explicit port is a different endpoint than the one this allows.
  if (url.port !== "") return false;
  if (url.hash !== "") return false;

  const host = url.hostname.toLowerCase();
  const hostAllowed = host === FAL_OUTPUT_APEX_HOST || host.endsWith(FAL_OUTPUT_HOST_SUFFIX);
  if (!hostAllowed) return false;

  if (!url.pathname.startsWith(FAL_OUTPUT_PATH_PREFIX)) return false;

  return true;
}
