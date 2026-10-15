import { AppError } from "@app/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { AuthService } from "../identity/auth-service";
import { GroupService } from "../identity/group-service";
import { MembershipService } from "../identity/membership-service";
import { OrganizationService } from "../identity/organization-service";
import { ROLES, type Role } from "../identity/roles";
import { createTestDeps, type TestDeps } from "../testing/in-memory";
import { InMemoryMediaAssetRepository, InMemoryPropertyRepository } from "../testing/in-memory-property";
import { AssetService } from "./asset-service";
import type { ObjectStorage } from "./ports";
import { PropertyService } from "./property-service";

/**
 * Reach on the Property and photo paths (ADR-0052 Decision 10, Phase 6I-1,
 * ADR-0064): every path answers a Property out of the member's reach, and each
 * photo under it, exactly as one that does not exist, and changes nothing.
 */

const PASSWORD = "password-123456";
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...Array.from({ length: 2044 }, (_, i) => i % 251)]);

class MapStorage implements ObjectStorage {
  readonly objects = new Map<string, Uint8Array>();
  /** Every signed URL issued, upload or download. */
  readonly signed: string[] = [];
  createSignedUploadUrl(key: string, ttlSeconds: number) {
    this.signed.push(key);
    return Promise.resolve({ url: `upload://${key}`, expiresAt: new Date(ttlSeconds * 1000) });
  }
  createSignedDownloadUrl(key: string, ttlSeconds: number) {
    this.signed.push(key);
    return Promise.resolve({ url: `download://${key}`, expiresAt: new Date(ttlSeconds * 1000) });
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

/** The fixture's Properties, by what they are assigned to. */
const PROPERTIES = ["unassigned", "creators", "viewers", "east", "west", "north"] as const;
type Name = (typeof PROPERTIES)[number];

/** Which Properties each role reaches, given the fixture's assignments and groups. */
const REACHED: Record<Exclude<Role, "BILLING">, readonly Name[]> = {
  OWNER: PROPERTIES,
  ADMIN: PROPERTIES,
  // East and west are its groups. It is the responsible user of north, which is
  // in a group it is not in, so it does not reach north.
  MANAGER: ["east", "west"],
  // It is in the east group, but OWN reaches only what it is responsible for.
  CREATOR: ["creators"],
  VIEWER: ["viewers"],
};

interface Fixture {
  readonly deps: TestDeps;
  readonly properties: PropertyService;
  readonly assets: AssetService;
  readonly storage: MapStorage;
  readonly groups: GroupService;
  readonly members: MembershipService;
  readonly orgId: string;
  readonly ownerId: string;
  readonly ids: Readonly<Record<Role, string>>;
  readonly groupIds: Readonly<Record<"east" | "west" | "north", string>>;
  readonly propertyIds: Readonly<Record<Name, string>>;
  /** A READY photo of each Property. */
  readonly photos: Readonly<Record<Name, string>>;
  /** A photo of each Property still awaiting its upload. */
  readonly pending: Readonly<Record<Name, string>>;
}

let fx: Fixture;

beforeEach(async () => {
  const deps = createTestDeps();
  const auth = new AuthService(deps, { sessionTtlSeconds: 3600 });
  const owner = await auth.register({ email: "owner@example.com", name: "Owner", password: PASSWORD });
  const { organization } = await new OrganizationService(deps).createOrganization(owner.id, { name: "Org" });
  const orgId = organization.id;
  const ids = {} as Record<Role, string>;
  for (const role of ROLES) {
    const user = await auth.register({ email: `member-${role.toLowerCase()}@example.com`, name: role, password: PASSWORD });
    await deps.repos.memberships.create({ organizationId: orgId, userId: user.id, role });
    ids[role] = user.id;
  }
  const groups = new GroupService(deps);
  const groupIds = {
    east: (await groups.create(owner.id, orgId, "East")).id,
    west: (await groups.create(owner.id, orgId, "West")).id,
    north: (await groups.create(owner.id, orgId, "North")).id,
  };
  await groups.addMember(owner.id, orgId, groupIds.east, ids.MANAGER);
  await groups.addMember(owner.id, orgId, groupIds.west, ids.MANAGER);
  await groups.addMember(owner.id, orgId, groupIds.east, ids.CREATOR);

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
          normalized: new Uint8Array([1, 2, 3]),
          normalizedMimeType: "image/jpeg",
          thumbnail: new Uint8Array([4]),
          thumbnailMimeType: "image/webp",
          width: 1600,
          height: 1200,
          perceptualHash: "0f0f0f0f0f0f0f0f",
        }),
    },
    clock: deps.clock,
    ids: deps.ids,
  });

  const assignments: Record<Name, { responsibleUserId?: string; groupId?: string }> = {
    unassigned: {},
    creators: { responsibleUserId: ids.CREATOR },
    viewers: { responsibleUserId: ids.VIEWER },
    east: { groupId: groupIds.east },
    west: { groupId: groupIds.west },
    north: { groupId: groupIds.north, responsibleUserId: ids.MANAGER },
  };
  const propertyIds = {} as Record<Name, string>;
  const photos = {} as Record<Name, string>;
  const pending = {} as Record<Name, string>;
  for (const name of PROPERTIES) {
    const property = await properties.create(owner.id, {
      organizationId: orgId,
      name,
      propertyType: "HOUSE",
      rightsConfirmed: true,
      ...assignments[name],
    });
    propertyIds[name] = property.id;
    const upload = (filename: string) =>
      assets.requestUpload(owner.id, { organizationId: orgId, propertyId: property.id, originalFilename: filename, declaredSizeBytes: JPEG.length });
    const { asset } = await upload("ready.jpg");
    await storage.putObject(asset.storageKey, JPEG);
    photos[name] = (await assets.completeUpload(owner.id, orgId, asset.id)).asset.id;
    pending[name] = (await upload("pending.jpg")).asset.id;
  }
  fx = {
    deps,
    properties,
    assets,
    storage,
    groups,
    members: new MembershipService(deps, { invitationTtlSeconds: 3600 }),
    orgId,
    ownerId: owner.id,
    ids,
    groupIds,
    propertyIds,
    photos,
    pending,
  };
});

/** The refusal a call ends in, as a member would see it. */
async function refusal(call: () => Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await call();
  } catch (error) {
    if (error instanceof AppError) return { code: error.code, message: error.message };
    throw error;
  }
  throw new Error("expected a refusal");
}

/** What a call could have changed: audit entries, signed URLs, the stored photos and Properties. */
async function snapshot(): Promise<string> {
  const props = await Promise.all(
    PROPERTIES.map((name) => fx.properties.get(fx.ownerId, fx.orgId, fx.propertyIds[name]).catch(() => null)),
  );
  const photos = await Promise.all(
    PROPERTIES.map((name) => fx.assets.list(fx.ownerId, fx.orgId, fx.propertyIds[name])),
  );
  return JSON.stringify({ audits: fx.deps.repos.auditLogs.all().length, signed: fx.storage.signed.length, props, photos });
}

const READ_ROLES = ["OWNER", "ADMIN", "MANAGER", "CREATOR", "VIEWER"] as const;

describe("the Property list", () => {
  it("lists exactly the Properties each role reaches", async () => {
    for (const role of READ_ROLES) {
      const listed = (await fx.properties.list(fx.ids[role], fx.orgId)).map((p) => p.name).sort();
      expect({ role, listed }).toEqual({ role, listed: [...REACHED[role]].sort() });
    }
  });

  it("lists nothing to a MANAGER in no group", async () => {
    await fx.groups.removeMember(fx.ownerId, fx.orgId, fx.groupIds.east, fx.ids.MANAGER);
    await fx.groups.removeMember(fx.ownerId, fx.orgId, fx.groupIds.west, fx.ids.MANAGER);
    expect(await fx.properties.list(fx.ids.MANAGER, fx.orgId)).toEqual([]);
  });
});

describe("reads of one Property or photo", () => {
  it("answers a Property or photo out of reach exactly as one that does not exist", async () => {
    const missingProperty = await refusal(() => fx.properties.get(fx.ownerId, fx.orgId, "prp_missing"));
    const missingPhoto = await refusal(() => fx.assets.createDownloadUrl(fx.ownerId, fx.orgId, "ast_missing"));
    expect(missingProperty).toEqual({ code: "NOT_FOUND", message: "Property not found" });
    expect(missingPhoto).toEqual({ code: "NOT_FOUND", message: "Asset not found" });
    expect(await fx.assets.list(fx.ownerId, fx.orgId, "prp_missing")).toEqual([]);

    for (const role of READ_ROLES) {
      const actor = fx.ids[role];
      for (const name of PROPERTIES) {
        const id = fx.propertyIds[name];
        const reached = REACHED[role].includes(name);
        const label = `${role} on ${name}`;
        if (reached) {
          expect((await fx.properties.get(actor, fx.orgId, id)).id, label).toBe(id);
          expect((await fx.assets.list(actor, fx.orgId, id)).map((a) => a.id).sort(), label).toEqual(
            [fx.photos[name], fx.pending[name]].sort(),
          );
          expect((await fx.assets.createDownloadUrl(actor, fx.orgId, fx.photos[name])).url, label).toContain("download://");
        } else {
          const before = fx.storage.signed.length;
          expect(await refusal(() => fx.properties.get(actor, fx.orgId, id)), label).toEqual(missingProperty);
          expect(await fx.assets.list(actor, fx.orgId, id), label).toEqual([]);
          expect(await refusal(() => fx.assets.createDownloadUrl(actor, fx.orgId, fx.photos[name])), label).toEqual(missingPhoto);
          expect(fx.storage.signed.length, label).toBe(before);
        }
      }
    }
  });

  it("checks reach before a photo's state, so a state message never reveals a photo out of reach", async () => {
    // Within reach, a pending photo is refused for its state...
    expect(await refusal(() => fx.assets.createDownloadUrl(fx.ids.CREATOR, fx.orgId, fx.pending.creators))).toEqual({
      code: "VALIDATION_FAILED",
      message: "Asset is not available for download",
    });
    // ...out of reach, the same photo state is answered as not found.
    expect(await refusal(() => fx.assets.createDownloadUrl(fx.ids.CREATOR, fx.orgId, fx.pending.viewers))).toEqual({
      code: "NOT_FOUND",
      message: "Asset not found",
    });
  });
});

describe("writes", () => {
  /** Each write a CREATOR may make, against the Property `name`. */
  const writes: Record<string, (name: Name) => Promise<unknown>> = {
    "update the Property": (name) => fx.properties.update(fx.ids.CREATOR, fx.orgId, fx.propertyIds[name], { name: "Renamed" }),
    "remove the Property": (name) => fx.properties.remove(fx.ids.CREATOR, fx.orgId, fx.propertyIds[name]),
    "request an upload": (name) =>
      fx.assets.requestUpload(fx.ids.CREATOR, { organizationId: fx.orgId, propertyId: fx.propertyIds[name], originalFilename: "x.jpg", declaredSizeBytes: 10 }),
    "complete an upload": async (name) => {
      // The bytes are in place, so only reach can stop the completion.
      const pending = (await fx.assets.list(fx.ownerId, fx.orgId, fx.propertyIds[name])).find((a) => a.id === fx.pending[name]);
      if (pending) await fx.storage.putObject(pending.storageKey, JPEG);
      return fx.assets.completeUpload(fx.ids.CREATOR, fx.orgId, fx.pending[name]);
    },
    "retry an upload": (name) => fx.assets.retryUpload(fx.ids.CREATOR, fx.orgId, fx.pending[name]),
    "delete a photo": (name) => fx.assets.requestDeletion(fx.ids.CREATOR, fx.orgId, fx.photos[name]),
  };
  const missing: Record<string, () => Promise<unknown>> = {
    "update the Property": () => fx.properties.update(fx.ids.CREATOR, fx.orgId, "prp_missing", { name: "Renamed" }),
    "remove the Property": () => fx.properties.remove(fx.ids.CREATOR, fx.orgId, "prp_missing"),
    "request an upload": () =>
      fx.assets.requestUpload(fx.ids.CREATOR, { organizationId: fx.orgId, propertyId: "prp_missing", originalFilename: "x.jpg", declaredSizeBytes: 10 }),
    "complete an upload": () => fx.assets.completeUpload(fx.ids.CREATOR, fx.orgId, "ast_missing"),
    "retry an upload": () => fx.assets.retryUpload(fx.ids.CREATOR, fx.orgId, "ast_missing"),
    "delete a photo": () => fx.assets.requestDeletion(fx.ids.CREATOR, fx.orgId, "ast_missing"),
  };

  for (const [label, write] of Object.entries(writes)) {
    it(`${label}: out of reach is answered as not found and changes nothing`, async () => {
      const expected = await refusal(missing[label] ?? (() => Promise.resolve()));
      expect(expected.message).toMatch(/^(Property|Asset) not found$/);
      expect(expected.code).toBe("NOT_FOUND");
      for (const name of PROPERTIES.filter((n) => !REACHED.CREATOR.includes(n))) {
        const before = await snapshot();
        expect(await refusal(() => write(name)), `${label} on ${name}`).toEqual(expected);
        expect(await snapshot(), `${label} on ${name}`).toBe(before);
      }
    });

    it(`${label}: within reach goes through`, async () => {
      await write("creators");
    });
  }

  it("lets a MANAGER write to its groups' Properties, not to one it is only responsible for", async () => {
    await fx.properties.update(fx.ids.MANAGER, fx.orgId, fx.propertyIds.east, { name: "East renamed" });
    await fx.assets.requestDeletion(fx.ids.MANAGER, fx.orgId, fx.photos.west);
    expect(await refusal(() => fx.properties.update(fx.ids.MANAGER, fx.orgId, fx.propertyIds.north, { name: "North" }))).toEqual({
      code: "NOT_FOUND",
      message: "Property not found",
    });
  });

  it("checks the permission before reach, as it does before existence", async () => {
    const lacking = { code: "FORBIDDEN", message: "Role VIEWER lacks permission 'property.edit'" };
    expect(await refusal(() => fx.properties.update(fx.ids.VIEWER, fx.orgId, fx.propertyIds.east, { name: "x" }))).toEqual(lacking);
    expect(await refusal(() => fx.properties.update(fx.ids.VIEWER, fx.orgId, "prp_missing", { name: "x" }))).toEqual(lacking);
  });
});

describe("changes take effect through the Property, on the next request", () => {
  it("follows a responsible-user reassignment", async () => {
    const id = fx.propertyIds.unassigned;
    await expect(fx.properties.get(fx.ids.CREATOR, fx.orgId, id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await fx.properties.assign(fx.ownerId, fx.orgId, id, { responsibleUserId: fx.ids.CREATOR });
    expect((await fx.properties.get(fx.ids.CREATOR, fx.orgId, id)).id).toBe(id);
    expect((await fx.assets.list(fx.ids.CREATOR, fx.orgId, id)).length).toBe(2);
    await fx.properties.assign(fx.ownerId, fx.orgId, id, { responsibleUserId: fx.ids.VIEWER });
    await expect(fx.properties.get(fx.ids.CREATOR, fx.orgId, id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await fx.properties.get(fx.ids.VIEWER, fx.orgId, id)).id).toBe(id);
  });

  it("follows a group reassignment and a group membership change", async () => {
    const id = fx.propertyIds.north;
    await fx.properties.assign(fx.ownerId, fx.orgId, id, { groupId: fx.groupIds.east });
    expect((await fx.properties.get(fx.ids.MANAGER, fx.orgId, id)).id).toBe(id);
    await fx.groups.removeMember(fx.ownerId, fx.orgId, fx.groupIds.east, fx.ids.MANAGER);
    await expect(fx.properties.get(fx.ids.MANAGER, fx.orgId, id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(fx.assets.createDownloadUrl(fx.ids.MANAGER, fx.orgId, fx.photos.east)).rejects.toMatchObject({ code: "NOT_FOUND" });
    // The west group still reaches west.
    expect((await fx.properties.get(fx.ids.MANAGER, fx.orgId, fx.propertyIds.west)).id).toBe(fx.propertyIds.west);
  });

  it("judges a member by its new role's scope, with every assignment left as it was", async () => {
    // A CREATOR made MANAGER is judged by GROUP: its east group, no longer the Property it is responsible for.
    await fx.members.changeRole(fx.ownerId, fx.orgId, fx.ids.CREATOR, "MANAGER");
    const listed = (await fx.properties.list(fx.ids.CREATOR, fx.orgId)).map((p) => p.name);
    expect(listed).toEqual(["east"]);
    expect((await fx.properties.get(fx.ownerId, fx.orgId, fx.propertyIds.creators)).responsibleUserId).toBe(fx.ids.CREATOR);
  });
});
