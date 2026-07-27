import { describe, expect, it } from "vitest";
import {
  buildAssetStorageKey,
  extensionFor,
  hammingDistanceHex,
  organizationIdFromStorageKey,
  sniffMimeType,
} from "./media";

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const WEBP = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
]);

describe("sniffMimeType (content-based validation)", () => {
  it("detects supported image types from magic bytes", () => {
    expect(sniffMimeType(JPEG)).toBe("image/jpeg");
    expect(sniffMimeType(PNG)).toBe("image/png");
    expect(sniffMimeType(WEBP)).toBe("image/webp");
  });

  it("rejects non-image and disguised content", () => {
    // A PHP/script payload named "photo.jpg" must not pass.
    expect(sniffMimeType(new Uint8Array(Buffer.from("<?php echo 1; ?>")))).toBeNull();
    // An SVG (XSS vector) is not in the allowlist and has no magic bytes.
    expect(sniffMimeType(new Uint8Array(Buffer.from("<svg onload=alert(1)>")))).toBeNull();
    expect(sniffMimeType(new Uint8Array([0x00, 0x01, 0x02]))).toBeNull();
    expect(sniffMimeType(new Uint8Array())).toBeNull();
  });

  it("does not treat a RIFF container without WEBP as webp", () => {
    const riffOnly = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x41, 0x56, 0x49, 0x20]);
    expect(sniffMimeType(riffOnly)).toBeNull();
  });
});

describe("storage keys", () => {
  it("are organization-prefixed and contain only internal ids", () => {
    const key = buildAssetStorageKey({
      organizationId: "org_1",
      propertyId: "prp_2",
      assetId: "ast_3",
      variant: "normalized",
      extension: "jpg",
    });
    expect(key).toBe("org/org_1/properties/prp_2/assets/ast_3/normalized.jpg");
    expect(organizationIdFromStorageKey(key)).toBe("org_1");
  });

  it("returns null for malformed keys", () => {
    expect(organizationIdFromStorageKey("bad/key")).toBeNull();
    expect(organizationIdFromStorageKey("")).toBeNull();
  });

  it("maps mime types to canonical extensions", () => {
    expect(extensionFor("image/jpeg")).toBe("jpg");
    expect(extensionFor("image/webp")).toBe("webp");
    expect(extensionFor("application/octet-stream")).toBe("bin");
  });
});

describe("hammingDistanceHex (duplicate detection foundation)", () => {
  it("is zero for identical hashes and grows with difference", () => {
    expect(hammingDistanceHex("ffffffffffffffff", "ffffffffffffffff")).toBe(0);
    expect(hammingDistanceHex("0000000000000000", "0000000000000001")).toBe(1);
    expect(hammingDistanceHex("0000000000000000", "ffffffffffffffff")).toBe(64);
  });

  it("rejects mismatched lengths", () => {
    expect(() => hammingDistanceHex("ff", "ffff")).toThrow();
  });
});
