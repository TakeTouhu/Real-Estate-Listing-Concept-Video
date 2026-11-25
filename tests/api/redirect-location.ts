import { expect } from "vitest";

/**
 * A route's redirect `Location`: a path on this site, never an address
 * (ADR-0175 Decision 7, RD-10b). Read as a browser reads it, against the
 * address it asked (RFC 9110 section 10.2.2), for its path and query.
 */
export function pathOf(response: Response): URL {
  const location = response.headers.get("location") ?? "";
  expect(location).toMatch(/^\/(?![/\\])/);
  return new URL(location, "http://browser.invalid");
}
