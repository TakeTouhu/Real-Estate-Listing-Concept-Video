import type {
  MediaAsset as DbMediaAsset,
  PrismaClient,
  Property as DbProperty,
} from "@prisma/client";
import type {
  MediaAsset,
  MediaAssetRepository,
  Property,
  PropertyRepository,
} from "@app/domain";

/**
 * Whether a thrown value is Prisma's "no record matched the filter".
 *
 * Duck-typed on `code`, matching how `P2002` is already recognized elsewhere in
 * this package: importing Prisma's error class would tie every call site to a
 * runtime import for a check that is one string comparison.
 *
 * For a conditional update this is the **ordinary** outcome — the predicate did
 * not match — so it becomes `null` rather than an exception. Every other error
 * propagates: a connection failure must not be reported as a lost race.
 */
function isRecordNotFound(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === "P2025";
}

const ACTIVE_STATUSES = [
  "PENDING_UPLOAD",
  "UPLOADED",
  "SCANNING",
  "PROCESSING",
  "READY",
] as const;

function toProperty(r: DbProperty): Property {
  return {
    id: r.id,
    organizationId: r.organizationId,
    name: r.name,
    propertyType: r.propertyType,
    addressMasked: r.addressMasked,
    description: r.description,
    status: r.status,
    createdBy: r.createdBy,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

function toAsset(r: DbMediaAsset): MediaAsset {
  return {
    id: r.id,
    organizationId: r.organizationId,
    propertyId: r.propertyId,
    storageKey: r.storageKey,
    originalFilename: r.originalFilename,
    mimeType: r.mimeType,
    sizeBytes: r.sizeBytes,
    width: r.width,
    height: r.height,
    sha256: r.sha256,
    perceptualHash: r.perceptualHash,
    status: r.status,
    failureReason: r.failureReason,
    thumbnailKey: r.thumbnailKey,
    createdBy: r.createdBy,
    deletionRequestedAt: r.deletionRequestedAt,
    retentionExpiresAt: r.retentionExpiresAt,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

/**
 * Prisma-backed property/asset repositories. Every lookup is filtered by
 * organizationId, so a row belonging to another tenant is simply not found —
 * tenant isolation is enforced in the data-access layer.
 */
export function createPrismaPropertyRepositories(prisma: PrismaClient): {
  properties: PropertyRepository;
  assets: MediaAssetRepository;
} {
  const properties: PropertyRepository = {
    async create(input) {
      return toProperty(
        await prisma.property.create({
          data: {
            id: input.id,
            organizationId: input.organizationId,
            name: input.name,
            propertyType: input.propertyType,
            addressMasked: input.addressMasked,
            description: input.description,
            status: input.status,
            createdBy: input.createdBy,
          },
        }),
      );
    },
    async findById(organizationId, id) {
      const row = await prisma.property.findFirst({ where: { id, organizationId } });
      return row ? toProperty(row) : null;
    },
    async listByOrganization(organizationId) {
      return (
        await prisma.property.findMany({
          where: { organizationId, status: { not: "DELETED" } },
          orderBy: { createdAt: "desc" },
        })
      ).map(toProperty);
    },
    async update(property) {
      return toProperty(
        await prisma.property.update({
          where: { id: property.id },
          data: {
            name: property.name,
            propertyType: property.propertyType,
            addressMasked: property.addressMasked,
            description: property.description,
            status: property.status,
          },
        }),
      );
    },
  };

  const assets: MediaAssetRepository = {
    async create(input) {
      return toAsset(
        await prisma.mediaAsset.create({
          data: {
            id: input.id,
            organizationId: input.organizationId,
            propertyId: input.propertyId,
            storageKey: input.storageKey,
            originalFilename: input.originalFilename,
            mimeType: input.mimeType,
            sizeBytes: input.sizeBytes,
            width: input.width,
            height: input.height,
            sha256: input.sha256,
            perceptualHash: input.perceptualHash,
            status: input.status,
            failureReason: input.failureReason,
            thumbnailKey: input.thumbnailKey,
            createdBy: input.createdBy,
            deletionRequestedAt: input.deletionRequestedAt,
            retentionExpiresAt: input.retentionExpiresAt,
          },
        }),
      );
    },
    async findById(organizationId, id) {
      const row = await prisma.mediaAsset.findFirst({ where: { id, organizationId } });
      return row ? toAsset(row) : null;
    },
    async listByProperty(organizationId, propertyId) {
      return (
        await prisma.mediaAsset.findMany({
          where: { organizationId, propertyId },
          orderBy: { createdAt: "asc" },
        })
      ).map(toAsset);
    },
    async updateIfCurrent(asset, expectedStatus) {
      // One conditional UPDATE decides the winner and returns the row.
      //
      // Prisma 5.22 accepts non-unique filters beside the unique one in
      // `where`, and compiles this to a single
      // `UPDATE ... WHERE id AND organizationId AND status AND
      // deletionRequestedAt IS NULL` — verified against PostgreSQL rather than
      // assumed. A read-then-write, or `updateMany` followed by a re-read
      // outside the statement, would reopen the TOCTOU window this method
      // exists to close: the losing writer could still observe a row it had
      // already failed to claim.
      //
      // `deletionRequestedAt` is absent from `data` deliberately. The predicate
      // rejects a stale writer, and the omission means that even a future edit
      // that weakened the predicate could not clear deletion intent by
      // accident.
      //
      // `P2025` is Prisma's "no record matched" — the ordinary lost-race
      // outcome here, not an error. Anything else is a real failure and
      // propagates.
      try {
        return toAsset(
          await prisma.mediaAsset.update({
            where: {
              id: asset.id,
              organizationId: asset.organizationId,
              status: expectedStatus,
              deletionRequestedAt: null,
            },
            data: {
              storageKey: asset.storageKey,
              mimeType: asset.mimeType,
              sizeBytes: asset.sizeBytes,
              width: asset.width,
              height: asset.height,
              sha256: asset.sha256,
              perceptualHash: asset.perceptualHash,
              status: asset.status,
              failureReason: asset.failureReason,
              thumbnailKey: asset.thumbnailKey,
              retentionExpiresAt: asset.retentionExpiresAt,
            },
          }),
        );
      } catch (error) {
        if (isRecordNotFound(error)) return null;
        throw error;
      }
    },
    async requestDeletion(organizationId, assetId, requestedAt) {
      // Same single-statement compare-and-swap, with the predicate that makes
      // deletion intent establishable exactly once: `deletionRequestedAt` must
      // still be null, and a `DELETED` row cannot be revived into
      // `DELETION_PENDING`.
      //
      // Only the two deletion-owned columns are written. A deletion request
      // must not disturb the storage key, hashes or dimensions that an
      // in-flight lifecycle writer may still be reading.
      try {
        return toAsset(
          await prisma.mediaAsset.update({
            where: {
              id: assetId,
              organizationId,
              deletionRequestedAt: null,
              status: { not: "DELETED" },
            },
            data: { status: "DELETION_PENDING", deletionRequestedAt: requestedAt },
          }),
        );
      } catch (error) {
        if (isRecordNotFound(error)) return null;
        throw error;
      }
    },
    async countActiveByProperty(organizationId, propertyId) {
      return prisma.mediaAsset.count({
        where: { organizationId, propertyId, status: { in: [...ACTIVE_STATUSES] } },
      });
    },
    async findBySha256(organizationId, sha256) {
      return (await prisma.mediaAsset.findMany({ where: { organizationId, sha256 } })).map(toAsset);
    },
    async listWithPerceptualHash(organizationId) {
      return (
        await prisma.mediaAsset.findMany({
          where: { organizationId, perceptualHash: { not: null } },
        })
      ).map(toAsset);
    },
  };

  return { properties, assets };
}
