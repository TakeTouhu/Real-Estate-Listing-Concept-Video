import { NextResponse, type MiddlewareConfig, type NextRequest } from "next/server";
import { newNonce, pageContentSecurityPolicy, REPORTING_ENDPOINTS } from "./lib/security-headers";

/**
 * The pages' Content Security Policy, with a fresh nonce per request (RD-9e,
 * ADR-0174 Decision 10).
 *
 * The policy goes on the request, replacing any the client sent, so the page's
 * render reads this nonce and puts it on Next.js's scripts; and on the answer,
 * for the browser. Pages only: `/api` keeps the configuration's own policy
 * (Decision 9), so no path ever gets two. It does not run for `/_next`, under
 * `/_next/` or for `/favicon.ico`, the addresses where a production build sends
 * the API policy instead (ADR-0188 Decision 4): Next.js's files there need no
 * page policy, and an address there that names no file is answered with the
 * not-found page. Next.js's own router prefetches (`Next-Router-Prefetch`) fetch
 * a payload, not a document, and get none; a browser's document prefetch or
 * prerender (`Purpose: prefetch`) does.
 *
 * Every page answer also names where the policy's `report-to` group posts
 * (`Reporting-Endpoints`, ADR-0189): a relative address, so the middleware
 * reads no setting. `/api` gets none, as it gets no page policy.
 *
 * Runs on the Edge runtime and imports nothing but the policy itself; the
 * origin check stays in each route (Decision 6).
 */
export function middleware(request: NextRequest): NextResponse {
  const policy = pageContentSecurityPolicy(newNonce(), process.env.NODE_ENV);
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("content-security-policy", policy);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("content-security-policy", policy);
  response.headers.set("reporting-endpoints", REPORTING_ENDPOINTS);
  return response;
}

export const config = {
  matcher: [
    {
      // Everything but `/api` and `/_next` and below (the configuration's `/api/:path*` and `/_next/:path*`) and
      // the icon's address.
      source: "/((?!api(?:/|$)|_next(?:/|$)|favicon\\.ico$).*)",
      missing: [{ type: "header", key: "next-router-prefetch" }],
    },
  ],
} satisfies MiddlewareConfig;
