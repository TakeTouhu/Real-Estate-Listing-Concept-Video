import { describe, expect, it } from "vitest";
import { signStorageToken, verifyStorageToken } from "./signing";

const SECRET = "storage-signing-secret-abc123";
const KEY = "org/org_1/properties/prp_1/assets/ast_1/original.bin";
const NOW = 1_000_000;

describe("storage token signing", () => {
  it("round-trips a valid token", () => {
    const raw = signStorageToken({ key: KEY, purpose: "upload", expiresAtSeconds: NOW + 60 }, SECRET);
    const verified = verifyStorageToken(raw, SECRET, "upload", NOW);
    expect(verified?.key).toBe(KEY);
  });

  it("rejects an expired token", () => {
    const raw = signStorageToken({ key: KEY, purpose: "upload", expiresAtSeconds: NOW - 1 }, SECRET);
    expect(verifyStorageToken(raw, SECRET, "upload", NOW)).toBeNull();
  });

  it("rejects a purpose mismatch (upload token cannot download)", () => {
    const raw = signStorageToken({ key: KEY, purpose: "upload", expiresAtSeconds: NOW + 60 }, SECRET);
    expect(verifyStorageToken(raw, SECRET, "download", NOW)).toBeNull();
  });

  it("rejects a token signed with another secret", () => {
    const raw = signStorageToken({ key: KEY, purpose: "download", expiresAtSeconds: NOW + 60 }, SECRET);
    expect(verifyStorageToken(raw, "other-secret-value", "download", NOW)).toBeNull();
  });

  it("rejects a tampered key (cross-tenant key substitution)", () => {
    const raw = signStorageToken({ key: KEY, purpose: "download", expiresAtSeconds: NOW + 60 }, SECRET);
    const payload = raw.split(".")[0]!;
    const signature = raw.split(".")[1]!;
    const evil = Buffer.from(
      JSON.stringify(["org/org_OTHER/properties/p/assets/a/normalized.jpg", "download", NOW + 60]),
      "utf8",
    ).toString("base64url");
    expect(verifyStorageToken(`${evil}.${signature}`, SECRET, "download", NOW)).toBeNull();
    expect(payload).not.toBe(evil);
  });

  it("rejects malformed tokens", () => {
    expect(verifyStorageToken("", SECRET, "upload", NOW)).toBeNull();
    expect(verifyStorageToken("nodot", SECRET, "upload", NOW)).toBeNull();
    expect(verifyStorageToken("not-base64.sig", SECRET, "upload", NOW)).toBeNull();
  });
});
