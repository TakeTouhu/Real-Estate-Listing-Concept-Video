import { describe, expect, it } from "vitest";
import { managedDeliverableOutputKey } from "@app/domain";
import { attachmentDisposition, parseRangeHeader, storageContentType } from "./storage-read";

/**
 * How the signed download route reads a request (ADR-0115): the one byte range
 * it asks for, or none, and the content type of what it names; and how it
 * names a download (ADR-0118).
 */
describe("a request's byte range", () => {
  it("is none without a header", () => {
    expect(parseRangeHeader(null)).toBeNull();
  });

  it("is a start and an end, a start alone, or a suffix", () => {
    expect(parseRangeHeader("bytes=0-99")).toEqual({ kind: "FROM", start: 0, end: 99 });
    expect(parseRangeHeader("bytes=5-5")).toEqual({ kind: "FROM", start: 5, end: 5 });
    expect(parseRangeHeader("bytes=100-")).toEqual({ kind: "FROM", start: 100, end: null });
    expect(parseRangeHeader("bytes=-500")).toEqual({ kind: "LAST", length: 500 });
    expect(parseRangeHeader("bytes=-0")).toEqual({ kind: "LAST", length: 0 });
  });

  it("allows the unit in any case and spaces around the numbers", () => {
    expect(parseRangeHeader("Bytes=1-2")).toEqual({ kind: "FROM", start: 1, end: 2 });
    expect(parseRangeHeader(" bytes= 1 - 2 ")).toEqual({ kind: "FROM", start: 1, end: 2 });
  });

  it("is ignored, and the whole object served, for anything else", () => {
    for (const header of [
      "",
      "bytes=",
      "bytes=-",
      "bytes=5-4",
      "bytes=0-1,4-5",
      "items=0-1",
      "notbytes=0-1",
      "bytes=a-b",
      "bytes=1.5-2",
      "bytes=-1-2",
      "bytes 0-1",
      "bytes=99999999999999999999-",
    ]) {
      expect(`${header}: ${JSON.stringify(parseRangeHeader(header))}`).toBe(`${header}: null`);
    }
  });
});

describe("the content type it is served with", () => {
  it("is a video for a customer's video, whose key has no extension", () => {
    const key = managedDeliverableOutputKey({ organizationId: "org_1", deliverableVersionId: "gdv_1" });
    expect(storageContentType(key)).toBe("video/mp4");
  });

  it("is the photo's own type, and bytes for anything else", () => {
    expect(storageContentType("org/org_1/properties/prp_1/assets/ast_1/normalized.webp")).toBe("image/webp");
    expect(storageContentType("org/org_1/properties/prp_1/assets/ast_1/thumbnail.jpg")).toBe("image/jpeg");
    expect(storageContentType("org/org_1/properties/prp_1/assets/ast_1/original.bin")).toBe(
      "application/octet-stream",
    );
    expect(storageContentType("org/org_1/deliverables/gdv_1/output.txt")).toBe("application/octet-stream");
  });
});

describe("how a download is named (ADR-0118)", () => {
  /** RFC 6266's two forms, the plain one a quoted string of printable ASCII, the other RFC 8187 `attr-char`s. */
  const SHAPE = new RegExp(
    String.raw`^attachment; filename="([\x20-\x21\x23-\x5b\x5d-\x7e]*)"; ` +
      String.raw`filename\*=UTF-8''([A-Za-z0-9!#$&+\-.^_${"`"}|~%]*)$`,
  );

  function parts(filename: string): { plain: string; encoded: string } {
    const match = SHAPE.exec(attachmentDisposition(filename));
    if (match === null) throw new Error(`not a disposition: ${attachmentDisposition(filename)}`);
    return { plain: match[1]!, encoded: match[2]! };
  }

  it("names a plain name as it is, in both forms", () => {
    expect(attachmentDisposition("Harbour View.mp4")).toBe(
      `attachment; filename="Harbour View.mp4"; filename*=UTF-8''Harbour%20View.mp4`,
    );
  });

  it("carries any other name whole in its UTF-8 form, and as _ where the plain form cannot", () => {
    expect(attachmentDisposition("渋谷 Café 😀.mp4")).toBe(
      `attachment; filename="__ Caf_ _.mp4"; filename*=UTF-8''%E6%B8%8B%E8%B0%B7%20Caf%C3%A9%20%F0%9F%98%80.mp4`,
    );
  });

  it("escapes what either form would misread", () => {
    expect(attachmentDisposition("50% (final)*'s; v1,2.mp4")).toBe(
      `attachment; filename="50_ (final)*'s; v1,2.mp4"; filename*=UTF-8''50%25%20%28final%29%2A%27s%3B%20v1%2C2.mp4`,
    );
  });

  it("keeps its plain form quoted whatever it is given", () => {
    expect(attachmentDisposition('a"b\\c%.mp4')).toBe(
      `attachment; filename="a_b_c_.mp4"; filename*=UTF-8''a%22b%5Cc%25.mp4`,
    );
  });

  it("is one header value that gives back the name, for every name a token may carry", () => {
    for (const name of [
      "Harbour View.mp4",
      "渋谷区 3LDK マンション.mp4",
      "a%20b.mp4",
      "!#$&+-.^_`|~ 'quoted' (x) [y] {z} @=;,.mp4",
      "😀".repeat(60),
    ]) {
      const { plain, encoded } = parts(name);
      expect(decodeURIComponent(encoded)).toBe(name);
      expect([...plain]).toHaveLength([...name].length);
    }
  });
});
