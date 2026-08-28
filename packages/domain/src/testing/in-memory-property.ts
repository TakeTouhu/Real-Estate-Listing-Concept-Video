import type { Clock } from "../identity/ports";
import type { MediaAssetRepository, PropertyRepository } from "../property/ports";
import type { MediaAsset, MediaAssetStatus, Property } from "../property/types";

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

  /** Test-only: capture state so a transaction double can roll back. */
  snapshot(): Map<string, MediaAsset> {
    return new Map(this.byId);
  }

  /** Test-only: discard writes made since {@link snapshot}. */
  restore(state: Map<string, MediaAsset>): void {
    this.byId.clear();
    for (const [id, row] of state) this.byId.set(id, row);
  }

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

  /**
   * Mirrors the production predicate, and mirrors what it refuses to write.
   *
   * The durable row decides — not the caller's snapshot. `deletionRequestedAt`
   * is carried over from the stored row rather than the argument, which is the
   * in-memory equivalent of leaving that column out of the SQL `data`: a stale
   * caller cannot clear deletion intent even by passing `null`.
   */
  updateIfCurrent(asset: MediaAsset, expectedStatus: MediaAssetStatus): Promise<MediaAsset | null> {
    const current = this.byId.get(asset.id);
    if (!current) return Promise.resolve(null);
    if (current.organizationId !== asset.organizationId) return Promise.resolve(null);
    if (current.status !== expectedStatus) return Promise.resolve(null);
    if (current.deletionRequestedAt !== null) return Promise.resolve(null);

    const updated: MediaAsset = {
      ...asset,
      deletionRequestedAt: current.deletionRequestedAt,
      updatedAt: this.clock.now(),
    };
    this.byId.set(updated.id, updated);
    return Promise.resolve(updated);
  }

  requestDeletion(
    organizationId: string,
    assetId: string,
    requestedAt: Date,
  ): Promise<MediaAsset | null> {
    const current = this.byId.get(assetId);
    if (!current) return Promise.resolve(null);
    if (current.organizationId !== organizationId) return Promise.resolve(null);
    if (current.deletionRequestedAt !== null) return Promise.resolve(null);
    if (current.status === "DELETED") return Promise.resolve(null);

    const updated: MediaAsset = {
      ...current,
      status: "DELETION_PENDING",
      deletionRequestedAt: requestedAt,
      updatedAt: this.clock.now(),
    };
    this.byId.set(updated.id, updated);
    return Promise.resolve(updated);
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
