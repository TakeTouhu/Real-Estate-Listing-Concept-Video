import { describe, expect, it } from "vitest";
import { isAuthorizedFalOutputUrl } from "./output-url-policy";

/**
 * The fal output URL authority, fail-closed. The interesting cases are the
 * deceptive hosts: authority confusion is how a fetch is steered somewhere the
 * signed credential should never travel.
 */

describe("isAuthorizedFalOutputUrl accepts the fal.media artifact family", () => {
  it.each([
    "https://fal.media/files/panda/out.mp4",
    "https://fal.media/files/panda/out.mp4?X-Fal-Signature=abc123",
    "https://v3.fal.media/files/x.mp4",
    "https://v3b.fal.media/files/nested/path/x.mp4?sig=z",
    "https://cdn.fal.media/files/x",
  ])("accepts %s", (url) => {
    expect(isAuthorizedFalOutputUrl(url)).toBe(true);
  });
});

describe("isAuthorizedFalOutputUrl refuses everything else, fail-closed", () => {
  it.each([
    ["plain http", "http://fal.media/files/x"],
    ["a suffixed look-alike host", "https://fal.media.evil.example/files/x"],
    ["a prefixed look-alike host", "https://evilfal.media/files/x"],
    ["a hyphen look-alike host", "https://fal-media.example/files/x"],
    ["userinfo smuggling the host", "https://fal.media@evil.example/files/x"],
    ["basic auth userinfo", "https://user:password@fal.media/files/x"],
    ["an explicit port", "https://fal.media:8443/files/x"],
    ["a non-files path", "https://fal.media/not-files/x"],
    ["a bare files path prefix without a slash", "https://fal.media/filesx"],
    ["a loopback IP", "https://127.0.0.1/files/x"],
    ["localhost", "https://localhost/files/x"],
    ["a file URL", "file:///tmp/output.mp4"],
    ["a fragment", "https://fal.media/files/x#frag"],
    ["a query that names fal on another host", "https://evil.example/files/x?next=https://fal.media/files/x"],
    ["a userinfo-at trick", "https://fal.media@evil.example/files/x?ok=1"],
  ])("refuses %s", (_label, url) => {
    expect(isAuthorizedFalOutputUrl(url)).toBe(false);
  });

  it.each([
    ["a non-string", 42],
    ["null", null],
    ["undefined", undefined],
    ["a blank string", "   "],
    ["not a URL at all", "not a url"],
    ["a relative path", "/files/x"],
  ])("refuses %s", (_label, value) => {
    expect(isAuthorizedFalOutputUrl(value)).toBe(false);
  });

  it("never returns anything but a boolean, and never the candidate", () => {
    // The verdict is a boolean. There is no path here that echoes the URL.
    const verdict = isAuthorizedFalOutputUrl("https://fal.media/files/x?sig=SECRET");
    expect(typeof verdict).toBe("boolean");
  });
});
