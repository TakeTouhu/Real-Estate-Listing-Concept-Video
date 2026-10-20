import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { managedCleanMasterKey } from "@app/domain";
import { LocalObjectStorage, signStorageToken, type SignedPurpose } from "@app/storage";

/**
 * The signed storage routes never serve or accept the Clean Master (ADR-0074).
 *
 * Only the environment and the storage are stubbed; the routes run as they are.
 * A token for the master is made here with the signing secret but without the
 * signer, which refuses it, so the routes are tested against exactly what a
 * signer bypass would hand them: a valid signature over an internal key.
 */
const SECRET = "storage-signing-secret-for-routes";
const storage = vi.hoisted(() => ({ value: null as unknown }));

vi.mock("@/lib/env", () => ({ getServerEnv: () => ({ STORAGE_SIGNING_SECRET: SECRET }) }));
vi.mock("@/lib/property", () => ({ getPropertyServices: () => ({ storage: storage.value }) }));

const { GET: download } = await import("@/app/api/storage/download/route");
const { PUT: upload } = await import("@/app/api/storage/upload/route");

const MASTER = managedCleanMasterKey({ organizationId: "org_a", deliverableVersionId: "gdv_1" });
const ASSET = "org/org_a/properties/prp_1/assets/ast_1/normalized.jpg";
const BYTES = new Uint8Array([7, 7, 7]);

function minted(key: string, purpose: SignedPurpose): string {
  const expires = Math.floor(Date.now() / 1000) + 60;
  const payload = Buffer.from(JSON.stringify([key, purpose, expires]), "utf8").toString("base64url");
  return `${payload}.${createHmac("sha256", SECRET).update(payload).digest("base64url")}`;
}

const url = (route: string, token: string) =>
  `http://localhost/api/storage/${route}?token=${encodeURIComponent(token)}`;

let local: LocalObjectStorage;

beforeEach(async () => {
  local = new LocalObjectStorage({ secret: SECRET });
  storage.value = local;
  await local.putObject(MASTER, BYTES);
  await local.putObject(ASSET, BYTES);
});

describe("the signed download route", () => {
  it("serves a customer's object for a valid token", async () => {
    const token = signStorageToken(
      { key: ASSET, purpose: "download", expiresAtSeconds: Math.floor(Date.now() / 1000) + 60 },
      SECRET,
    );
    const response = await download(new Request(url("download", token)));
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(BYTES);
  });

  it("never serves the Clean Master, answering as for a forged token", async () => {
    const response = await download(new Request(url("download", minted(MASTER, "download"))));
    expect(response.status).toBe(401);
    expect(await response.text()).toBe("Unauthorized");
  });
});

describe("the signed upload route", () => {
  it("never writes over the Clean Master", async () => {
    const response = await upload(
      new Request(url("upload", minted(MASTER, "upload")), { method: "PUT", body: new Uint8Array([9]) }),
    );
    expect(response.status).toBe(401);
    expect(await local.getObject(MASTER)).toEqual(BYTES);
  });

  it("accepts a customer's upload for a valid token", async () => {
    const response = await upload(
      new Request(url("upload", minted(ASSET, "upload")), { method: "PUT", body: new Uint8Array([9]) }),
    );
    expect(response.status).toBe(200);
    expect(await local.getObject(ASSET)).toEqual(new Uint8Array([9]));
  });
});
