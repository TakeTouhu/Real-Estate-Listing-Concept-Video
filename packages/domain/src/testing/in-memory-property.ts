import type { Clock } from "../identity/ports";
import type { MediaAssetRepository, PropertyRepository } from "../property/ports";
import type { MediaAsset, Property } from "../property/types";

const ACTIVE_STATUSES: readonly MediaAsset["status"][] = [
  "PENDING_UPLOAD",
  "UPLOADED",
  "SCANNING",
  "PROCESSING",
  "READY",
];

export class InMemoryPropertyRepository implements PropertyRepository {
  private readonly byId = new Map<string, Property>();
  constructor(private readonly clock: Clock) {}

  create(input: Omit<Property, "createdAt" | "updatedAt">): Promise<Property> {
    const now = this.clock.now();
    const property: Property = { ...input, createdAt: now, updatedAt: now };
    this.byId.set(property.id, property);
    return Promise.resolve(property);
  }

  /** Organization-scoped: a row from another tenant is invisible (null). */
  findById(organizationId: string, id: string): Promise<Property | null> {
    const row = this.byId.get(id);
    return Promise.resolve(row && row.organizationId === organizationId ? row : null);
  }

  listByOrganization(organizationId: string): Promise<Property[]> {
    return Promise.resolve(
      [...this.byId.values()].filter(
        (p) => p.organizationId === organizationId && p.status !== "DELETED",
      ),
    );
  }

  update(property: Property): Promise<Property> {
    if (!this.byId.has(property.id)) throw new Error("property not found");
    this.byId.set(property.id, property);
    return Promise.resolve(property);
  }
}

export class InMemoryMediaAssetRepository implements MediaAssetRepository {
  private readonly byId = new Map<string, MediaAsset>();
  constructor(private readonly clock: Clock) {}

  create(input: Omit<MediaAsset, "createdAt" | "updatedAt">): Promise<MediaAsset> {
    const now = this.clock.now();
    const asset: MediaAsset = { ...input, createdAt: now, updatedAt: now };
    this.byId.set(asset.id, asset);
    return Promise.resolve(asset);
  }

  findById(organizationId: string, id: string): Promise<MediaAsset | null> {
    const row = this.byId.get(id);
    return Promise.resolve(row && row.organizationId === organizationId ? row : null);
  }

  listByProperty(organizationId: string, propertyId: string): Promise<MediaAsset[]> {
    return Promise.resolve(
      [...this.byId.values()].filter(
        (a) => a.organizationId === organizationId && a.propertyId === propertyId,
      ),
    );
  }

  update(asset: MediaAsset): Promise<MediaAsset> {
    if (!this.byId.has(asset.id)) throw new Error("asset not found");
    this.byId.set(asset.id, asset);
    return Promise.resolve(asset);
  }

  countActiveByProperty(organizationId: string, propertyId: string): Promise<number> {
    return Promise.resolve(
      [...this.byId.values()].filter(
        (a) =>
          a.organizationId === organizationId &&
          a.propertyId === propertyId &&
          ACTIVE_STATUSES.includes(a.status),
      ).length,
    );
  }

  findBySha256(organizationId: string, sha256: string): Promise<MediaAsset[]> {
    return Promise.resolve(
      [...this.byId.values()].filter(
        (a) => a.organizationId === organizationId && a.sha256 === sha256,
      ),
    );
  }

  listWithPerceptualHash(organizationId: string): Promise<MediaAsset[]> {
    return Promise.resolve(
      [...this.byId.values()].filter(
        (a) => a.organizationId === organizationId && a.perceptualHash !== null,
      ),
    );
  }
}
