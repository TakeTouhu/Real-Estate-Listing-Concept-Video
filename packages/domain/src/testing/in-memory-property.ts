import type { Clock } from "../identity/ports";
import type {
  MediaAssetRepository,
  PropertyAssignment,
  PropertyChangeAudit,
  PropertyCreation,
  PropertyDetailsChange,
  PropertyReassignment,
  PropertyRepository,
} from "../property/ports";
import { reaches, type Reach } from "../property/reach";
import type { MediaAsset, MediaAssetStatus, Property } from "../property/types";
import type { TestRepositories } from "./in-memory";

const ACTIVE_STATUSES: readonly MediaAsset["status"][] = [
  "PENDING_UPLOAD",
  "UPLOADED",
  "SCANNING",
  "PROCESSING",
  "READY",
];

/**
 * Properties, with the identity doubles standing in for the database: each
 * change writes its audit entry to their audit log, an assignment must name a
 * member and a group they hold, and a member's removal or a group's deletion
 * there releases what refers to it here. Each change checks and writes with no
 * `await` in between, as a transaction would.
 */
export class InMemoryPropertyRepository implements PropertyRepository {
  private readonly byId = new Map<string, Property>();
  constructor(
    private readonly clock: Clock,
    private readonly repos: Pick<TestRepositories, "auditLogs" | "propertyLinks">,
  ) {
    repos.propertyLinks.register({
      unassign: (organizationId, userId) =>
        this.release(organizationId, (p) => p.responsibleUserId === userId, { responsibleUserId: null }),
      ungroup: (organizationId, groupId) => this.release(organizationId, (p) => p.groupId === groupId, { groupId: null }),
    });
  }

  async create(input: Omit<Property, "createdAt" | "updatedAt">, audit: PropertyChangeAudit): Promise<PropertyCreation> {
    if (!this.assignable(input.organizationId, input)) return { outcome: "STALE" };
    const now = this.clock.now();
    const property: Property = { ...input, createdAt: now, updatedAt: now };
    this.byId.set(property.id, property);
    await this.repos.auditLogs.append(audit);
    return { outcome: "CREATED", property };
  }

  /** Organization-scoped: a row from another tenant is invisible (null). */
  findById(organizationId: string, id: string): Promise<Property | null> {
    const row = this.byId.get(id);
    return Promise.resolve(row && row.organizationId === organizationId ? row : null);
  }

  listReachable(reach: Reach): Promise<Property[]> {
    return Promise.resolve(
      [...this.byId.values()].filter((p) => p.status !== "DELETED" && reaches(reach, p)),
    );
  }

  updateDetails(organizationId: string, id: string, change: PropertyDetailsChange): Promise<Property | null> {
    const stored = this.byId.get(id);
    if (stored?.organizationId !== organizationId || stored.status === "DELETED") return Promise.resolve(null);
    // The named fields alone, as the database's conditional write.
    const updated: Property = { ...stored, ...definedOnly(change), updatedAt: this.clock.now() };
    this.byId.set(id, updated);
    return Promise.resolve(updated);
  }

  markDeleted(organizationId: string, id: string): Promise<boolean> {
    const stored = this.byId.get(id);
    if (stored?.organizationId !== organizationId || stored.status === "DELETED") return Promise.resolve(false);
    this.byId.set(id, { ...stored, status: "DELETED", updatedAt: this.clock.now() });
    return Promise.resolve(true);
  }

  async assign(
    organizationId: string,
    propertyId: string,
    expected: PropertyAssignment,
    next: PropertyAssignment,
    audit: PropertyChangeAudit,
  ): Promise<PropertyReassignment> {
    const stored = this.byId.get(propertyId);
    if (
      stored?.organizationId !== organizationId ||
      stored.status === "DELETED" ||
      stored.responsibleUserId !== expected.responsibleUserId ||
      stored.groupId !== expected.groupId ||
      !this.assignable(organizationId, next)
    ) {
      return { outcome: "STALE" };
    }
    const property: Property = { ...stored, ...next, updatedAt: this.clock.now() };
    this.byId.set(propertyId, property);
    await this.repos.auditLogs.append(audit);
    return { outcome: "ASSIGNED", property };
  }

  /** Mirrors the foreign keys: a member of the organization, and a group of it. */
  private assignable(organizationId: string, assignment: PropertyAssignment): boolean {
    const links = this.repos.propertyLinks;
    return (
      (assignment.responsibleUserId === null || links.isMember(organizationId, assignment.responsibleUserId)) &&
      (assignment.groupId === null || links.isGroup(organizationId, assignment.groupId))
    );
  }

  private release(organizationId: string, matches: (p: Property) => boolean, released: Partial<PropertyAssignment>): number {
    let count = 0;
    for (const [id, property] of this.byId) {
      if (property.organizationId !== organizationId || !matches(property)) continue;
      this.byId.set(id, { ...property, ...released, updatedAt: this.clock.now() });
      count += 1;
    }
    return count;
  }
}

/** The fields a change names, as Prisma leaves an `undefined` one unwritten. */
function definedOnly(change: PropertyDetailsChange): PropertyDetailsChange {
  return Object.fromEntries(Object.entries(change).filter(([, value]) => value !== undefined));
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

/**
 * Properties for suites whose subject is not reach (ADR-0064). Every id asked
 * is a live Property of the organization asked, so photos and projects may name
 * a Property no test created. It is unassigned until a test assigns it: an
 * `OWNER` or `ADMIN` reaches it either way, a `MANAGER` through the group it is
 * given, a `CREATOR` or `VIEWER` once made its responsible user.
 */
export class StandInProperties implements Pick<PropertyRepository, "findById"> {
  private readonly assignments = new Map<string, PropertyAssignment>();

  assign(propertyId: string, assignment: Partial<PropertyAssignment>): void {
    this.assignments.set(propertyId, { responsibleUserId: null, groupId: null, ...assignment });
  }

  findById(organizationId: string, id: string): Promise<Property | null> {
    const at = new Date(0);
    return Promise.resolve({
      id,
      organizationId,
      name: id,
      propertyType: "OTHER",
      addressMasked: null,
      description: null,
      status: "ACTIVE",
      createdBy: "usr_stand_in",
      responsibleUserId: null,
      groupId: null,
      ...this.assignments.get(id),
      createdAt: at,
      updatedAt: at,
    });
  }
}
