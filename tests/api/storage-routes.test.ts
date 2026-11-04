import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { managedCleanMasterKey, managedDeliverableOutputKey, managedGenerationOutputKey } from "@app/domain";
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
    expect(response.headers.get("content-type")).toBe("image/jpeg");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(BYTES);
  });

  it("never serves the Clean Master, answering as for a forged token", async () => {
    const response = await download(new Request(url("download", minted(MASTER, "download"))));
    expect(response.status).toBe(401);
    expect(await response.text()).toBe("Unauthorized");
  });
});

describe("a video through the signed download route (ADR-0115)", () => {
  const VIDEO = managedDeliverableOutputKey({ organizationId: "org_a", deliverableVersionId: "gdv_1" });
  const CLIP = new Uint8Array([10, 11, 12, 13, 14]);

  beforeEach(async () => {
    await local.putObject(VIDEO, CLIP);
  });

  function get(key: string, range?: string): Promise<Response> {
    const headers = range === undefined ? undefined : { range };
    return download(new Request(url("download", minted(key, "download")), { headers }));
  }

  it("serves the whole video as one, privately, saying ranges are served", async () => {
    const response = await get(VIDEO);
    expect(response.status).toBe(200);
    expect(Object.fromEntries(response.headers)).toMatchObject({
      "content-type": "video/mp4",
      "content-length": "5",
      "accept-ranges": "bytes",
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
    });
    expect(response.headers.get("content-range")).toBeNull();
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(CLIP);
  });

  it("serves the bytes a range names, as part of the video", async () => {
    const middle = await get(VIDEO, "bytes=1-2");
    expect(middle.status).toBe(206);
    expect(middle.headers.get("content-range")).toBe("bytes 1-2/5");
    expect(middle.headers.get("content-length")).toBe("2");
    expect(middle.headers.get("content-type")).toBe("video/mp4");
    expect(new Uint8Array(await middle.arrayBuffer())).toEqual(new Uint8Array([11, 12]));
    const last = await get(VIDEO, "bytes=-2");
    expect(last.status).toBe(206);
    expect(last.headers.get("content-range")).toBe("bytes 3-4/5");
    expect(new Uint8Array(await last.arrayBuffer())).toEqual(new Uint8Array([13, 14]));
    const rest = await get(VIDEO, "bytes=0-");
    expect(rest.status).toBe(206);
    expect(rest.headers.get("content-range")).toBe("bytes 0-4/5");
  });

  it("answers a range past the end with the video's size and no bytes", async () => {
    const response = await get(VIDEO, "bytes=5-");
    expect(response.status).toBe(416);
    expect(response.headers.get("content-range")).toBe("bytes */5");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.text()).toBe("");
  });

  it("serves the whole video for a range it does not serve", async () => {
    for (const range of ["bytes=4-1", "bytes=0-1,3-4"]) {
      const response = await get(VIDEO, range);
      expect(response.status).toBe(200);
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(CLIP);
    }
  });

  it("answers not found for a video no longer stored", async () => {
    await local.deleteObject(VIDEO);
    expect((await get(VIDEO)).status).toBe(404);
    expect((await get(VIDEO, "bytes=0-1")).status).toBe(404);
  });

  it("never serves a scene video, answering as for a forged token", async () => {
    const scene = managedGenerationOutputKey({ organizationId: "org_a", attemptId: "sgen_1" });
    await local.putObject(scene, CLIP);
    const response = await get(scene);
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
