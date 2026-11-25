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
  InMemoryRateLimitStore,
  type TestDeps,
} from "@app/domain/testing";
import { AppError, RATE_LIMIT_DEFAULTS, type RateLimitSetting } from "@app/shared";

/**
 * Reach through the HTTP routes (Phase 6I-1, ADR-0064). Only session
 * resolution is stubbed; the routes run against the real PropertyService and
 * AssetService over in-memory repositories. A CREATOR asking for a Property it
 * is not responsible for, or a photo under it, gets exactly the response it
 * would get for an id that does not exist. The upload and download limits
 * run for real, on an in-memory store made afresh for each test (ADR-0173).
 */
const PASSWORD = "password-123456";
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...Array.from({ length: 2044 }, (_, i) => i % 251)]);

const currentUser = vi.hoisted(() => ({ value: null as { user: { id: string } } | null }));
const propertyServices = vi.hoisted(() => ({ value: null as unknown }));
const identity = vi.hoisted(() => ({ value: null as unknown }));
const limits = vi.hoisted(() => ({ value: null as unknown }));

vi.mock("@/lib/auth", () => ({
  getCurrentUser: () => Promise.resolve(currentUser.value),
}));
vi.mock("@/lib/property", () => ({ getPropertyServices: () => propertyServices.value }));
vi.mock("@/lib/identity", () => ({ getIdentityServices: () => identity.value }));
vi.mock("@/lib/rate-limit", async (original) => ({
  ...(await original<typeof import("@/lib/rate-limit")>()),
  getRateLimiter: () => limits.value,
}));
const { WebRateLimits } = await import("@/lib/rate-limit");
const limitsOf = (settings: Partial<Record<RateLimitSetting, string>>, store = new InMemoryRateLimitStore()) =>
  new WebRateLimits(store, { ...RATE_LIMIT_DEFAULTS, ...settings, SESSION_SECRET: "x".repeat(32) }, { warn: vi.fn() });

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
  readObject() {
    // Nothing these tests serve is read as a stream.
    return Promise.resolve({ kind: "ABSENT" as const });
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
  readonly ownerId: string;
  readonly creatorId: string;
  readonly storage: MapStorage;
  /** The CREATOR is responsible for `mine`; `theirs` is unassigned. */
  readonly mine: { readonly propertyId: string; readonly ready: string; readonly pending: string };
  readonly theirs: { readonly propertyId: string; readonly ready: string; readonly pending: string };
}
let ctx: Ctx;

beforeEach(async () => {
  const deps = createTestDeps();
  identity.value = { deps };
  limits.value = limitsOf({});
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
    ownerId: owner.id,
    creatorId: creator.id,
    storage,
    mine: await seed(creator.id),
    theirs: await seed(),
  };
  currentUser.value = { user: { id: creator.id } };
});

/** Posted as the app's pages post: with no `APP_BASE_URL` here, the host is compared (ADR-0174). */
const SITE = { host: "t", origin: "http://t" };
const json = (body: unknown, headers: Record<string, string> = SITE) =>
  new Request("http://t/api", { method: "POST", headers, body: JSON.stringify(body) });
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

describe("the upload routes' limit per account (ADR-0173)", () => {
  const services = () => (propertyServices.value as { assets: AssetService }).assets;
  const mine = () => ({
    link: () => routes["POST upload-url"]!.call(ctx.mine.propertyId),
    retry: () => routes["POST retry"]!.call(ctx.mine.pending),
    check: () => routes["POST complete"]!.call(ctx.mine.pending),
  });

  it("counts upload links, retries and checks together, and refuses the next with the JSON answer", async () => {
    limits.value = limitsOf({ RATE_LIMIT_UPLOAD: "2/86400" });
    expect((await mine().link()).status).toBe(200);
    expect((await mine().retry()).status).toBe(200);
    const signed = ctx.storage.signed;
    const checks = vi.spyOn(services(), "completeUpload");
    for (const call of [mine().check, mine().link, mine().retry]) {
      const refused = await call();
      expect([refused.status, refused.headers.get("retry-after"), refused.headers.get("cache-control")]).toEqual([
        429,
        "86400",
        "no-store",
      ]);
      expect(await seen(refused)).toEqual({
        status: 429,
        body: {
          error: {
            code: "RATE_LIMITED",
            message: "Too many uploads. Try again in 24 hours.",
            details: { retryAfterSeconds: 86400 },
          },
        },
      });
    }
    expect(checks).not.toHaveBeenCalled();
    expect(ctx.storage.signed).toBe(signed);
    // Another member of the same organization has a count of their own: no key holds the organization.
    currentUser.value = { user: { id: ctx.ownerId } };
    expect((await mine().link()).status).toBe(200);
  });

  it("counts only after the session and the body are checked", async () => {
    limits.value = limitsOf({ RATE_LIMIT_UPLOAD: "1/86400" });
    const property = { params: Promise.resolve({ propertyId: ctx.mine.propertyId }) };
    expect((await requestUpload(json({ organizationId: ctx.orgId }), property)).status).toBe(422);
    expect((await completeUpload(json({}), asset(ctx.mine.pending))).status).toBe(422);
    const unreadable = new Request("http://t/api", { method: "POST", headers: SITE, body: "{" });
    expect((await retryUpload(unreadable, asset(ctx.mine.pending))).status).toBe(422);
    currentUser.value = null;
    expect((await mine().link()).status).toBe(401);
    currentUser.value = { user: { id: ctx.creatorId } };
    expect((await mine().link()).status).toBe(200);
  });

  it("fails closed with the route's own 500, never the limiter's text, and issues nothing", async () => {
    const broken = new InMemoryRateLimitStore();
    broken.hit = () => Promise.reject(new AppError("INTERNAL_ERROR", "The rate-limit hit returned no row"));
    limits.value = limitsOf({}, broken);
    const signed = ctx.storage.signed;
    const checks = vi.spyOn(services(), "completeUpload");
    for (const call of Object.values(mine())) {
      expect(await seen(await call())).toEqual({
        status: 500,
        body: { error: { code: "INTERNAL_ERROR", message: "Unexpected error", details: {} } },
      });
    }
    expect(checks).not.toHaveBeenCalled();
    expect(ctx.storage.signed).toBe(signed);
  });
});

describe("the photo download link's limit per account (ADR-0173)", () => {
  type Audited = { deps: { repos: { auditLogs: { all: () => readonly { action: string }[] } } } };
  const issued = () =>
    (identity.value as Audited).deps.repos.auditLogs.all().filter((e) => e.action === "asset.download_url_issued");
  const link = () => routes["GET download-url"]!.call(ctx.mine.ready);

  it("refuses past the limit with the JSON answer, signing and auditing no link", async () => {
    limits.value = limitsOf({ RATE_LIMIT_DOWNLOAD: "1/3600" });
    expect((await link()).status).toBe(200);
    const [signed, audited] = [ctx.storage.signed, issued().length];
    const refused = await link();
    expect([refused.status, refused.headers.get("retry-after"), refused.headers.get("cache-control")]).toEqual([
      429,
      "3600",
      "no-store",
    ]);
    expect(await seen(refused)).toEqual({
      status: 429,
      body: {
        error: {
          code: "RATE_LIMITED",
          message: "Too many downloads. Try again in 60 minutes.",
          details: { retryAfterSeconds: 3600 },
        },
      },
    });
    expect([ctx.storage.signed, issued().length]).toEqual([signed, audited]);
    // Another member of the same organization has a count of their own.
    currentUser.value = { user: { id: ctx.ownerId } };
    expect((await link()).status).toBe(200);
  });

  it("counts only after the session and the organization are checked", async () => {
    limits.value = limitsOf({ RATE_LIMIT_DOWNLOAD: "1/3600" });
    expect((await downloadUrl(new Request("http://t/api"), asset(ctx.mine.ready))).status).toBe(422);
    currentUser.value = null;
    expect((await link()).status).toBe(401);
    currentUser.value = { user: { id: ctx.creatorId } };
    expect((await link()).status).toBe(200);
  });

  it("fails closed with the route's own 500, never the limiter's text, signing and auditing nothing", async () => {
    const broken = new InMemoryRateLimitStore();
    broken.hit = () => Promise.reject(new AppError("INTERNAL_ERROR", "The rate-limit hit returned no row"));
    limits.value = limitsOf({}, broken);
    const [signed, audited] = [ctx.storage.signed, issued().length];
    expect(await seen(await link())).toEqual({
      status: 500,
      body: { error: { code: "INTERNAL_ERROR", message: "Unexpected error", details: {} } },
    });
    expect([ctx.storage.signed, issued().length]).toEqual([signed, audited]);
  });
});

describe("the origin check (ADR-0174)", () => {
  it.each([
    ["no origin", { host: "t" }],
    ["another site", { host: "t", origin: "https://evil.example.net" }],
  ])("refuses a post from %s before reading, counting or signing anything, signed in or not", async (_, headers) => {
    const store = new InMemoryRateLimitStore();
    const hits = vi.spyOn(store, "hit");
    limits.value = limitsOf({}, store);
    const checks = vi.spyOn((propertyServices.value as { assets: AssetService }).assets, "completeUpload");
    const audits = () => (identity.value as { deps: TestDeps }).deps.repos.auditLogs.all().length;
    const before = [ctx.storage.signed, audits()];
    const routes = [
      [(r: Request) => requestUpload(r, property(ctx.mine.propertyId)), "started"],
      [(r: Request) => completeUpload(r, asset(ctx.mine.pending)), "completed"],
      [(r: Request) => retryUpload(r, asset(ctx.mine.pending)), "retried"],
    ] as const;
    for (const user of [{ user: { id: ctx.creatorId } }, null]) {
      currentUser.value = user;
      for (const [call, done] of routes) {
        const request = json({ organizationId: ctx.orgId, filename: "x.jpg", sizeBytes: 10 }, headers);
        const message = `A photo's upload must be ${done} from this site`;
        expect(await seen(await call(request))).toEqual({
          status: 403,
          body: { error: { code: "FORBIDDEN", message, details: {} } },
        });
        expect(request.bodyUsed).toBe(false);
      }
    }
    expect(hits).not.toHaveBeenCalled();
    expect(checks).not.toHaveBeenCalled();
    expect([ctx.storage.signed, audits()]).toEqual(before);
  });
});
