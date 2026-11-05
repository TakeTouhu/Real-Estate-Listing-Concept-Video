import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { managedCleanMasterKey, managedGenerationOutputKey } from "@app/domain";
import { LocalObjectStorage } from "./local-storage";
import { signStorageToken, verifyStorageToken, type SignedPurpose } from "./signing";

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

  describe("the internal namespace (ADR-0074)", () => {
    const MASTER = managedCleanMasterKey({ organizationId: "org_1", deliverableVersionId: "gdv_1" });
    const PURPOSES: readonly SignedPurpose[] = ["upload", "download"];

    /** A token made with the secret but without the signer, as a bypass would. */
    function minted(key: string, purpose: SignedPurpose): string {
      const payload = Buffer.from(JSON.stringify([key, purpose, NOW + 60]), "utf8").toString(
        "base64url",
      );
      return `${payload}.${createHmac("sha256", SECRET).update(payload).digest("base64url")}`;
    }

    it("is never signed, for either purpose", () => {
      for (const purpose of PURPOSES) {
        expect(() =>
          signStorageToken({ key: MASTER, purpose, expiresAtSeconds: NOW + 60 }, SECRET),
        ).toThrow(expect.objectContaining({ code: "INTERNAL_ERROR" }));
      }
    });

    it("is never honoured, however the token was made", () => {
      for (const purpose of PURPOSES) {
        expect(verifyStorageToken(minted(MASTER, purpose), SECRET, purpose, NOW)).toBeNull();
        expect(verifyStorageToken(minted(MASTER.replace("internal/", "internal/x/"), purpose), SECRET, purpose, NOW)).toBeNull();
        // A key a store could rewrite onto the master is ignored too.
        expect(verifyStorageToken(minted(MASTER.replace("/internal/", "//internal/"), purpose), SECRET, purpose, NOW)).toBeNull();
        expect(() =>
          signStorageToken(
            { key: MASTER.replace("/internal/", "/./internal/"), purpose, expiresAtSeconds: NOW + 60 },
            SECRET,
          ),
        ).toThrow(expect.objectContaining({ code: "INTERNAL_ERROR" }));
        // The same hand-made token for a customer's key is honoured: the refusal
        // is the namespace, not the way the token was made.
        expect(verifyStorageToken(minted(KEY, purpose), SECRET, purpose, NOW)?.key).toBe(KEY);
      }
    });

    it("is refused by the local adapter's signed URLs of either kind", async () => {
      const storage = new LocalObjectStorage({ secret: SECRET });
      await storage.putObject(MASTER, new Uint8Array([1, 2, 3]));
      await expect(storage.createSignedDownloadUrl(MASTER, 60)).rejects.toMatchObject({
        code: "INTERNAL_ERROR",
      });
      await expect(storage.createSignedUploadUrl(MASTER, 60)).rejects.toMatchObject({
        code: "INTERNAL_ERROR",
      });
      // Server-side reads are unaffected: composition will read its own master.
      expect(await storage.getObject(MASTER)).toEqual(new Uint8Array([1, 2, 3]));
      await expect(storage.createSignedDownloadUrl(KEY, 60)).resolves.toMatchObject({
        url: expect.stringContaining("/api/storage/download?token="),
      });
    });
  });

  describe("scene videos (ADR-0115)", () => {
    const SCENE = managedGenerationOutputKey({ organizationId: "org_1", attemptId: "sgen_1" });

    it("are never signed nor honoured, for either purpose", () => {
      for (const purpose of ["upload", "download"] as const) {
        expect(() => signStorageToken({ key: SCENE, purpose, expiresAtSeconds: NOW + 60 }, SECRET)).toThrow(
          expect.objectContaining({ code: "INTERNAL_ERROR" }),
        );
        const payload = Buffer.from(JSON.stringify([SCENE, purpose, NOW + 60]), "utf8").toString("base64url");
        const minted = `${payload}.${createHmac("sha256", SECRET).update(payload).digest("base64url")}`;
        expect(verifyStorageToken(minted, SECRET, purpose, NOW)).toBeNull();
      }
    });

    it("are refused by the local adapter's signed URLs, and still read server-side", async () => {
      const storage = new LocalObjectStorage({ secret: SECRET });
      await storage.putObject(SCENE, new Uint8Array([4]));
      await expect(storage.createSignedDownloadUrl(SCENE, 60)).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
      expect(await storage.getObject(SCENE)).toEqual(new Uint8Array([4]));
    });
  });

  describe("a download's file name (ADR-0118)", () => {
    const NAME = "渋谷 Harbour View.mp4";

    /** A token made with the secret but without the signer, as a bypass would. */
    function minted(fields: readonly unknown[]): string {
      const payload = Buffer.from(JSON.stringify(fields), "utf8").toString("base64url");
      return `${payload}.${createHmac("sha256", SECRET).update(payload).digest("base64url")}`;
    }

    it("is carried by a download's token, and by none without one", () => {
      const named = signStorageToken(
        { key: KEY, purpose: "download", expiresAtSeconds: NOW + 60, attachmentFilename: NAME },
        SECRET,
      );
      expect(verifyStorageToken(named, SECRET, "download", NOW)).toEqual({
        key: KEY,
        purpose: "download",
        expiresAtSeconds: NOW + 60,
        attachmentFilename: NAME,
      });
      const plain = signStorageToken({ key: KEY, purpose: "download", expiresAtSeconds: NOW + 60 }, SECRET);
      expect(verifyStorageToken(plain, SECRET, "download", NOW)).toStrictEqual({
        key: KEY,
        purpose: "download",
        expiresAtSeconds: NOW + 60,
      });
      // The name is signed: a token cannot be renamed.
      const [payload, signature] = named.split(".") as [string, string];
      const renamed = Buffer.from(JSON.stringify([KEY, "download", NOW + 60, "other.mp4"]), "utf8").toString(
        "base64url",
      );
      expect(renamed).not.toBe(payload);
      expect(verifyStorageToken(`${renamed}.${signature}`, SECRET, "download", NOW)).toBeNull();
    });

    it("is never signed for an upload, nor when it is not safe to send", () => {
      expect(() =>
        signStorageToken({ key: KEY, purpose: "upload", expiresAtSeconds: NOW + 60, attachmentFilename: NAME }, SECRET),
      ).toThrow(expect.objectContaining({ code: "INTERNAL_ERROR" }));
      for (const unsafe of ["", 'a".mp4', "a\r\nSet-Cookie: x.mp4", "a/b.mp4", "\ud800.mp4", "a".repeat(241)]) {
        expect(() =>
          signStorageToken(
            { key: KEY, purpose: "download", expiresAtSeconds: NOW + 60, attachmentFilename: unsafe },
            SECRET,
          ),
        ).toThrow(expect.objectContaining({ code: "INTERNAL_ERROR" }));
      }
    });

    it("is never honoured on an upload, nor when it is not one safe to send, however the token was made", () => {
      expect(verifyStorageToken(minted([KEY, "upload", NOW + 60, NAME]), SECRET, "upload", NOW)).toBeNull();
      for (const name of [null, 7, ["a.mp4"], "", 'a".mp4', "a\nb.mp4", "a".repeat(241)]) {
        expect(verifyStorageToken(minted([KEY, "download", NOW + 60, name]), SECRET, "download", NOW)).toBeNull();
      }
      expect(verifyStorageToken(minted([KEY, "download", NOW + 60, NAME, "x"]), SECRET, "download", NOW)).toBeNull();
      expect(verifyStorageToken(minted([KEY, "download"]), SECRET, "download", NOW)).toBeNull();
      // An expired or internal key's token is refused as before, name or not.
      expect(verifyStorageToken(minted([KEY, "download", NOW, NAME]), SECRET, "download", NOW)).toBeNull();
      const master = managedCleanMasterKey({ organizationId: "org_1", deliverableVersionId: "gdv_1" });
      expect(verifyStorageToken(minted([master, "download", NOW + 60, NAME]), SECRET, "download", NOW)).toBeNull();
      // The same hand-made token with a safe name is honoured: the refusal is the name.
      expect(verifyStorageToken(minted([KEY, "download", NOW + 60, NAME]), SECRET, "download", NOW)).toMatchObject({
        attachmentFilename: NAME,
      });
    });

    it("is signed by the local adapter only when asked for", async () => {
      const storage = new LocalObjectStorage({ secret: SECRET, now: () => new Date(NOW * 1000) });
      const token = ({ url }: { url: string }) => decodeURIComponent(url.split("token=")[1]!);
      const named = await storage.createSignedDownloadUrl(KEY, 60, { attachmentFilename: NAME });
      expect(verifyStorageToken(token(named), SECRET, "download", NOW)?.attachmentFilename).toBe(NAME);
      const plain = await storage.createSignedDownloadUrl(KEY, 60);
      expect(verifyStorageToken(token(plain), SECRET, "download", NOW)).not.toHaveProperty("attachmentFilename");
      await expect(
        storage.createSignedDownloadUrl(KEY, 60, { attachmentFilename: "a/b.mp4" }),
      ).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
    });
  });
});
