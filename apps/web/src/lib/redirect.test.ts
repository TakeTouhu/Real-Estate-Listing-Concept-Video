import { describe, expect, it } from "vitest";
import { isSitePath, pathWithQuery, seeOther, seeOtherToSignedLink } from "./redirect";

describe("seeOther", () => {
  it("answers 303 with the path as it is, query and fragment kept", () => {
    for (const path of ["/", "/login", "/login?error=Sign%20in", "/properties/p1?notice=saved#top"]) {
      const response = seeOther(path);
      expect([response.status, response.headers.get("location")]).toEqual([303, path]);
    }
  });

  it("keeps the response's cookies usable", () => {
    const response = seeOther("/login");
    response.cookies.delete("session");
    expect(response.headers.get("set-cookie")).toMatch(/^session=;/);
    expect(response.headers.get("location")).toBe("/login");
  });

  it("refuses anything but a path on this site", () => {
    const refused = ["", "x", "login", "//x", "//x/login", "/\\x", "https://x", "http://x/login", "/\t/x", "/x\n"];
    for (const path of refused) {
      expect(isSitePath(path)).toBe(false);
      expect(() => seeOther(path)).toThrow("A redirect must name a path on this site");
    }
  });

  it("sends the path a browser would resolve, and refuses one that resolves to `//`", () => {
    expect(seeOther("/a/../b?c=d").headers.get("location")).toBe("/b?c=d");
    expect(seeOther("/caf\u00e9").headers.get("location")).toBe("/caf%C3%A9");
    for (const path of ["/a/../\\evil", "/a/..//evil", "/%2e%2e//evil", "/.%2e//evil"]) {
      expect(() => seeOther(path)).toThrow("A redirect must name a path on this site");
    }
    for (const path of ["/a\\b", "/caf\u00e9", "/a b", "/a\u007f"]) expect(isSitePath(path)).toBe(false);
  });
});

describe("pathWithQuery", () => {
  it("writes the query as URL.searchParams.set does, in the order given, skipping undefined", () => {
    const old = new URL("/organizations/o%201/members", "http://0.0.0.0:3000/api/x");
    old.searchParams.set("error", "Too many; wait a minute & retry");
    old.searchParams.set("retry", "2");
    const path = pathWithQuery("/organizations/o%201/members", {
      error: "Too many; wait a minute & retry",
      notice: undefined,
      retry: "2",
    });
    expect(path).toBe(`${old.pathname}${old.search}`);
    expect(path).toBe("/organizations/o%201/members?error=Too+many%3B+wait+a+minute+%26+retry&retry=2");
  });

  it("keeps a query already in the path, replaces a name set again, and keeps a fragment", () => {
    expect(pathWithQuery("/x?a=1&error=old#f", { error: "new" })).toBe("/x?a=1&error=new#f");
    expect(pathWithQuery("/verify-email")).toBe("/verify-email");
  });

  it("refuses a path that is not one, or that parses into another host's", () => {
    expect(() => pathWithQuery("//x", {})).toThrow("A redirect must name a path on this site");
    expect(() => pathWithQuery("/.//x", {})).toThrow("A redirect must name a path on this site");
  });
});

describe("seeOtherToSignedLink", () => {
  it("sends a path on this site as it is, and the store's absolute address as it parses", () => {
    const local = seeOtherToSignedLink("/api/storage/download?token=t");
    expect([local.status, local.headers.get("location")]).toEqual([303, "/api/storage/download?token=t"]);
    const store = seeOtherToSignedLink("https://storage.example/b/o?X-Sig=s");
    expect([store.status, store.headers.get("location")]).toEqual([303, "https://storage.example/b/o?X-Sig=s"]);
  });

  it("refuses a link that is neither", () => {
    expect(() => seeOtherToSignedLink("//x/o")).toThrow();
    expect(() => seeOtherToSignedLink("o?token=t")).toThrow();
    const refused = "A signed link must be a path on this site or an https: address";
    for (const link of ["http://storage.example/o", "javascript:alert(1)", "data:text/html,x"]) {
      expect(() => seeOtherToSignedLink(link)).toThrow(refused);
    }
  });
});
