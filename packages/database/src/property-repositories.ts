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
    async update(asset) {
      return toAsset(
        await prisma.mediaAsset.update({
          where: { id: asset.id },
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
            deletionRequestedAt: asset.deletionRequestedAt,
            retentionExpiresAt: asset.retentionExpiresAt,
          },
        }),
      );
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
