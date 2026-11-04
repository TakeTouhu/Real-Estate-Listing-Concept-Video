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

const { GET: download, HEAD: downloadHead } = await import("@/app/api/storage/download/route");
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

  function get(key: string, range?: string, more: Record<string, string> = {}): Promise<Response> {
    const headers = range === undefined ? more : { ...more, range };
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

  it("answers a range past the end, or an empty suffix, with the video's size and no bytes", async () => {
    for (const range of ["bytes=5-", "bytes=-0"]) {
      const response = await get(VIDEO, range);
      expect(response.status).toBe(416);
      expect(response.headers.get("content-range")).toBe("bytes */5");
      expect(response.headers.get("accept-ranges")).toBe("bytes");
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(await response.text()).toBe("");
    }
  });

  it("serves the whole video for a range made conditional, as it sends nothing to meet", async () => {
    const response = await get(VIDEO, "bytes=1-2", { "if-range": '"anything"' });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-range")).toBeNull();
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(CLIP);
  });

  it("serves an empty object whole for a suffix, and refuses it a start", async () => {
    await local.putObject(VIDEO, new Uint8Array(0));
    const suffix = await get(VIDEO, "bytes=-3");
    expect(suffix.status).toBe(200);
    expect(suffix.headers.get("content-length")).toBe("0");
    expect(suffix.headers.get("content-range")).toBeNull();
    expect(await suffix.text()).toBe("");
    const start = await get(VIDEO, "bytes=0-");
    expect(start.status).toBe(416);
    expect(start.headers.get("content-range")).toBe("bytes */0");
  });

  it("serves the whole video for a range it does not serve", async () => {
    for (const range of ["bytes=4-1", "bytes=0-1,3-4"]) {
      const response = await get(VIDEO, range);
      expect(response.status).toBe(200);
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(CLIP);
    }
  });

  it("answers not found for a video no longer stored, and unauthorized without a token, never cached", async () => {
    await local.deleteObject(VIDEO);
    for (const response of [await get(VIDEO), await get(VIDEO, "bytes=0-1")]) {
      expect(response.status).toBe(404);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
    const tokenless = await download(new Request("http://localhost/api/storage/download"));
    expect(tokenless.status).toBe(401);
    expect(tokenless.headers.get("cache-control")).toBe("private, no-store");
  });

  it("never serves a scene video, answering as for a forged token", async () => {
    const scene = managedGenerationOutputKey({ organizationId: "org_a", attemptId: "sgen_1" });
    await local.putObject(scene, CLIP);
    const response = await get(scene);
    expect(response.status).toBe(401);
    expect(await response.text()).toBe("Unauthorized");
  });
});

describe("what the signed download route holds open (ADR-0115)", () => {
  const VIDEO = managedDeliverableOutputKey({ organizationId: "org_a", deliverableVersionId: "gdv_1" });
  const CLIP = new Uint8Array([10, 11, 12, 13, 14]);
  let cancelled: number;

  beforeEach(async () => {
    await local.putObject(VIDEO, CLIP);
    cancelled = 0;
    // Each body the store hands out says when it is let go.
    const read = local.readObject.bind(local);
    vi.spyOn(local, "readObject").mockImplementation(async (key, range) => {
      const result = await read(key, range);
      if (result.kind !== "READ") return result;
      const reader = result.body.getReader();
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          const { done, value } = await reader.read();
          if (done) controller.close();
          else controller.enqueue(value);
        },
        async cancel(reason) {
          cancelled += 1;
          await reader.cancel(reason);
        },
      });
      return { ...result, body };
    });
  });

  const request = (init: RequestInit = {}) => new Request(url("download", minted(VIDEO, "download")), init);

  it("answers HEAD as it answers GET, without the body, which it lets go", async () => {
    const whole = await downloadHead(request({ method: "HEAD" }));
    expect(whole.status).toBe(200);
    expect(whole.headers.get("content-length")).toBe("5");
    expect(whole.headers.get("content-type")).toBe("video/mp4");
    expect(whole.headers.get("accept-ranges")).toBe("bytes");
    expect(whole.body).toBeNull();
    const part = await downloadHead(request({ method: "HEAD", headers: { range: "bytes=1-2" } }));
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe("bytes 1-2/5");
    expect(part.body).toBeNull();
    expect(cancelled).toBe(2);
    const forged = await downloadHead(new Request(url("download", minted(MASTER, "download")), { method: "HEAD" }));
    expect(forged.status).toBe(401);
    expect(forged.body).toBeNull();
  });

  it("lets the body go when the client left before it is sent, or leaves after the answer", async () => {
    await download(request({ signal: AbortSignal.abort() }));
    expect(cancelled).toBe(1);
    const leaving = new AbortController();
    const answered = await download(request({ signal: leaving.signal }));
    expect(answered.status).toBe(200);
    expect(cancelled).toBe(1);
    leaving.abort();
    await vi.waitFor(() => expect(cancelled).toBe(2));
  });

  it("leaves a body being sent to what sends it, and lets nothing go once it is sent", async () => {
    const leaving = new AbortController();
    const response = await download(request({ signal: leaving.signal }));
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error("expected a body");
    leaving.abort();
    expect((await reader.read()).value).toEqual(CLIP);
    expect((await reader.read()).done).toBe(true);
    expect(cancelled).toBe(0);
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
