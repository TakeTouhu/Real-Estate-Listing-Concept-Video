import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AssetService,
  AuthService,
  OrganizationService,
  PropertyService,
  type ObjectStorage,
} from "@app/domain";
import {
  createTestDeps,
  InMemoryMediaAssetRepository,
  InMemoryPropertyRepository,
} from "@app/domain/testing";

/**
 * Reach through the HTTP routes (Phase 6I-1, ADR-0064). Only session
 * resolution is stubbed; the routes run against the real PropertyService and
 * AssetService over in-memory repositories. A CREATOR asking for a Property it
 * is not responsible for, or a photo under it, gets exactly the response it
 * would get for an id that does not exist.
 */
const PASSWORD = "password-123456";
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...Array.from({ length: 2044 }, (_, i) => i % 251)]);

const currentUser = vi.hoisted(() => ({ value: null as { user: { id: string } } | null }));
const propertyServices = vi.hoisted(() => ({ value: null as unknown }));

vi.mock("@/lib/auth", () => ({
  getCurrentUser: () => Promise.resolve(currentUser.value),
}));
vi.mock("@/lib/property", () => ({ getPropertyServices: () => propertyServices.value }));

const { GET: listProperties } = await import("@/app/api/properties/route");
const { POST: requestUpload } = await import("@/app/api/properties/[propertyId]/assets/upload-url/route");
const { POST: completeUpload } = await import("@/app/api/assets/[assetId]/complete/route");
const { GET: downloadUrl } = await import("@/app/api/assets/[assetId]/download-url/route");
const { POST: retryUpload } = await import("@/app/api/assets/[assetId]/retry/route");

class MapStorage implements ObjectStorage {
  readonly objects = new Map<string, Uint8Array>();
  signed = 0;
  createSignedUploadUrl() {
    this.signed += 1;
    return Promise.resolve({ url: "upload://signed", expiresAt: new Date(0) });
  }
  createSignedDownloadUrl() {
    this.signed += 1;
    return Promise.resolve({ url: "download://signed", expiresAt: new Date(0) });
  }
  putObject(key: string, data: Uint8Array) {
    this.objects.set(key, data);
    return Promise.resolve();
  }
  getObject(key: string) {
    return Promise.resolve(this.objects.get(key) ?? null);
  }
  deleteObject(key: string) {
    this.objects.delete(key);
    return Promise.resolve();
  }
  exists(key: string) {
    return Promise.resolve(this.objects.has(key));
  }
}

interface Ctx {
  readonly orgId: string;
  readonly creatorId: string;
  readonly storage: MapStorage;
  /** The CREATOR is responsible for `mine`; `theirs` is unassigned. */
  readonly mine: { readonly propertyId: string; readonly ready: string; readonly pending: string };
  readonly theirs: { readonly propertyId: string; readonly ready: string; readonly pending: string };
}
let ctx: Ctx;

beforeEach(async () => {
  const deps = createTestDeps();
  const auth = new AuthService(deps, { sessionTtlSeconds: 3600 });
  const owner = await auth.register({ email: "o@e.com", password: PASSWORD, name: "Owner" });
  const creator = await auth.register({ email: "c@e.com", password: PASSWORD, name: "Creator" });
  const { organization } = await new OrganizationService(deps).createOrganization(owner.id, { name: "Acme" });
  await deps.repos.memberships.create({ organizationId: organization.id, userId: creator.id, role: "CREATOR" });
  const propertyRepo = new InMemoryPropertyRepository(deps.clock, deps.repos);
  const assetRepo = new InMemoryMediaAssetRepository(deps.clock);
  const storage = new MapStorage();
  const properties = new PropertyService({ identity: deps, properties: propertyRepo, assets: assetRepo, clock: deps.clock, ids: deps.ids });
  const assets = new AssetService({
    identity: deps,
    properties: propertyRepo,
    assets: assetRepo,
    storage,
    scanner: { scan: () => Promise.resolve({ verdict: "CLEAN" as const }) },
    images: {
      process: () =>
        Promise.resolve({
          normalized: new Uint8Array([1]),
          normalizedMimeType: "image/jpeg",
          thumbnail: new Uint8Array([2]),
          thumbnailMimeType: "image/webp",
          width: 1600,
          height: 1200,
          perceptualHash: "0f0f0f0f0f0f0f0f",
        }),
    },
    clock: deps.clock,
    ids: deps.ids,
  });
  propertyServices.value = { properties, assets };

  const seed = async (responsibleUserId?: string) => {
    const property = await properties.create(owner.id, {
      organizationId: organization.id,
      name: responsibleUserId ? "Mine" : "Theirs",
      propertyType: "HOUSE",
      rightsConfirmed: true,
      ...(responsibleUserId ? { responsibleUserId } : {}),
    });
    const upload = () =>
      assets.requestUpload(owner.id, { organizationId: organization.id, propertyId: property.id, originalFilename: "a.jpg", declaredSizeBytes: JPEG.length });
    const ready = (await upload()).asset;
    await storage.putObject(ready.storageKey, JPEG);
    await assets.completeUpload(owner.id, organization.id, ready.id);
    const pending = (await upload()).asset;
    // Its bytes are in place, so only reach can stop a completion.
    await storage.putObject(pending.storageKey, JPEG);
    return { propertyId: property.id, ready: ready.id, pending: pending.id };
  };
  ctx = {
    orgId: organization.id,
    creatorId: creator.id,
    storage,
    mine: await seed(creator.id),
    theirs: await seed(),
  };
  currentUser.value = { user: { id: creator.id } };
});

const json = (body: unknown) => new Request("http://t/api", { method: "POST", body: JSON.stringify(body) });
const query = () => new Request(`http://t/api?organizationId=${encodeURIComponent(ctx.orgId)}`);
const asset = (assetId: string) => ({ params: Promise.resolve({ assetId }) });
const property = (propertyId: string) => ({ params: Promise.resolve({ propertyId }) });

/** A response as a member sees it, without the per-request id. */
async function seen(res: Response): Promise<{ status: number; body: unknown }> {
  const body = (await res.json()) as { error?: { requestId?: string } };
  if (body.error) delete body.error.requestId;
  return { status: res.status, body };
}

/** Each route, called for a Property id or a photo id. */
const routes: Record<string, { readonly call: (id: string) => Promise<Response>; readonly of: (c: Ctx["mine"]) => string }> = {
  "POST upload-url": {
    call: (id) => requestUpload(json({ organizationId: ctx.orgId, filename: "x.jpg", sizeBytes: 10 }), property(id)),
    of: (c) => c.propertyId,
  },
  "POST complete": { call: (id) => completeUpload(json({ organizationId: ctx.orgId }), asset(id)), of: (c) => c.pending },
  "GET download-url": { call: (id) => downloadUrl(query(), asset(id)), of: (c) => c.ready },
  "POST retry": { call: (id) => retryUpload(json({ organizationId: ctx.orgId }), asset(id)), of: (c) => c.pending },
};

describe("Property and photo routes for a member out of reach", () => {
  it("GET /api/properties lists only the Properties the member reaches", async () => {
    const res = await listProperties(query());
    expect(res.status).toBe(200);
    const { properties } = (await res.json()) as { properties: { id: string }[] };
    expect(properties.map((p) => p.id)).toEqual([ctx.mine.propertyId]);
  });

  for (const [name, route] of Object.entries(routes)) {
    it(`${name}: answers out of reach exactly as an id that does not exist, and issues nothing`, async () => {
      const missing = await seen(await route.call(name === "POST upload-url" ? "prp_missing" : "ast_missing"));
      expect(missing.status).toBe(404);
      const signed = ctx.storage.signed;
      expect(await seen(await route.call(route.of(ctx.theirs)))).toEqual(missing);
      expect(ctx.storage.signed).toBe(signed);
    });

    it(`${name}: serves the member's own Property`, async () => {
      expect((await route.call(route.of(ctx.mine))).status).toBe(200);
    });
  }
});
