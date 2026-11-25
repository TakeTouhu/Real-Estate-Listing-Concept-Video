import { NextResponse } from "next/server";

/**
 * Redirects from route handlers (ADR-0175 Decision 7, built in RD-10b). A
 * route answers a path, never an address built from `request.url`, which a
 * production server builds on its bind address (`0.0.0.0:3000` in the image)
 * whatever `Host` said. The browser resolves a relative `Location` against the
 * address it asked (RFC 9110 section 10.2.2), so it stays on that host, and
 * the page's `form-action 'self'` lets it follow one after a form post.
 */

/** Parses a path on its own; the host is never sent, only the path and query. */
const PATH_BASE = "http://path.invalid";

/**
 * A path on this site, as a `Location` may carry it: one leading `/`, never
 * `//` or `/\`, and only printable ASCII but `\`. A browser reads `//host`
 * as another host, reads `\` as `/`, drops a tab or line break before it
 * reads, and Node refuses a header beyond Latin-1.
 */
export function isSitePath(path: string): boolean {
  return opensSitePath(path) && /^[\x21-\x5b\x5d-\x7e]*$/.test(path);
}

/** One leading `/`, never `//` or `/\`, and no control character: a path before it is parsed. */
function opensSitePath(path: string): boolean {
  return path.startsWith("/") && path[1] !== "/" && path[1] !== "\\" && !hasControl(path);
}

function hasControl(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const unit = text.charCodeAt(i);
    if (unit < 0x20 || unit === 0x7f) return true;
  }
  return false;
}

const REFUSED = "A redirect must name a path on this site";

/**
 * `path` with each defined value set in its query, written as
 * `URL.searchParams.set` writes it: the path, query and fragment a redirect
 * built on `request.url` carried, without the address. The path is parsed as
 * a browser would resolve it, dot-segments and all, and what comes out must
 * still be a path on this site.
 */
export function pathWithQuery(path: string, query: Readonly<Record<string, string | undefined>> = {}): string {
  if (!opensSitePath(path)) throw new Error(REFUSED);
  const url = new URL(path, PATH_BASE);
  for (const [name, value] of Object.entries(query)) if (value !== undefined) url.searchParams.set(name, value);
  const parsed = `${url.pathname}${url.search}${url.hash}`;
  if (!isSitePath(parsed)) throw new Error(REFUSED);
  return parsed;
}

/**
 * A `303 See Other` to a path on this site, sent as a browser would resolve
 * it; the response's cookies can still be set or deleted.
 */
export function seeOther(path: string): NextResponse {
  return new NextResponse(null, { status: 303, headers: { Location: pathWithQuery(path) } });
}

/**
 * A `303 See Other` to a download link the storage adapter signed: a path on
 * this site, or the store's own `https:` address as it parses. The one
 * absolute `Location` a route sends, and only the download route calls it;
 * never an address built from a request.
 */
export function seeOtherToSignedLink(link: string): NextResponse {
  if (link.startsWith("/")) return seeOther(link);
  const store = new URL(link);
  if (store.protocol !== "https:") throw new Error("A signed link must be a path on this site or an https: address");
  return new NextResponse(null, { status: 303, headers: { Location: store.href } });
}
