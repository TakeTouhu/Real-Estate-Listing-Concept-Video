import { describe, expect, it } from "vitest";
import { managedDeliverableOutputKey } from "@app/domain";
import { parseRangeHeader, storageContentType } from "./storage-read";

/**
 * How the signed download route reads a request (ADR-0115): the one byte range
 * it asks for, or none, and the content type of what it names.
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
