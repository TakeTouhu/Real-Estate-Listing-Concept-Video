import { AppError } from "@app/shared";
import { recordAudit } from "../identity/audit";
import { authorizeOrganization } from "../identity/authorization";
import type { Clock, IdentityServiceDeps, IdGenerator } from "../identity/ports";
import { PropertyAuditAction } from "./audit";
import type { MediaAssetRepository, PropertyRepository } from "./ports";
import { PROPERTY_TYPES, type Property, type PropertyType } from "./types";

export interface PropertyServiceDeps {
  /** Identity deps supply membership lookup (authorization) and the audit sink. */
  readonly identity: IdentityServiceDeps;
  readonly properties: PropertyRepository;
  readonly assets: MediaAssetRepository;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

export interface CreatePropertyInput {
  readonly organizationId: string;
  readonly name: string;
  readonly propertyType: PropertyType;
  readonly addressMasked?: string | null;
  readonly description?: string | null;
  /**
   * The customer must confirm they own or have licensed the photos they will
   * upload for this property (mandatory product rule).
   */
  readonly rightsConfirmed: boolean;
}

export interface UpdatePropertyInput {
  readonly name?: string;
  readonly propertyType?: PropertyType;
  readonly addressMasked?: string | null;
  readonly description?: string | null;
}

const MAX_NAME_LENGTH = 200;

export class PropertyService {
  constructor(private readonly deps: PropertyServiceDeps) {}

  async create(actorUserId: string, input: CreatePropertyInput): Promise<Property> {
    await authorizeOrganization(
      this.deps.identity,
      actorUserId,
      input.organizationId,
      "property:write",
    );
    if (!input.rightsConfirmed) {
      throw new AppError(
        "VALIDATION_FAILED",
        "You must confirm you own or have licensed the photos for this property",
      );
    }
    const name = input.name.trim();
    if (name.length === 0 || name.length > MAX_NAME_LENGTH) {
      throw new AppError("VALIDATION_FAILED", "Property name is required");
    }
    if (!PROPERTY_TYPES.includes(input.propertyType)) {
      throw new AppError("VALIDATION_FAILED", "Unsupported property type");
    }
    const property = await this.deps.properties.create({
      id: this.deps.ids.generate("prp"),
      organizationId: input.organizationId,
      name,
      propertyType: input.propertyType,
      addressMasked: input.addressMasked?.trim() || null,
      description: input.description?.trim() || null,
      status: "ACTIVE",
      createdBy: actorUserId,
    });
    await recordAudit(this.deps.identity, {
      organizationId: input.organizationId,
      actorUserId,
      action: PropertyAuditAction.PropertyCreated,
      resourceType: "property",
      resourceId: property.id,
      metadata: { propertyType: property.propertyType },
    });
    return property;
  }

  async list(actorUserId: string, organizationId: string): Promise<Property[]> {
    await authorizeOrganization(this.deps.identity, actorUserId, organizationId);
    return this.deps.properties.listByOrganization(organizationId);
  }

  /** Read a single property, enforcing organization scope. */
  async get(actorUserId: string, organizationId: string, propertyId: string): Promise<Property> {
    await authorizeOrganization(this.deps.identity, actorUserId, organizationId);
    const property = await this.deps.properties.findById(organizationId, propertyId);
    if (!property || property.status === "DELETED") {
      throw new AppError("NOT_FOUND", "Property not found");
    }
    return property;
  }

  async update(
    actorUserId: string,
    organizationId: string,
    propertyId: string,
    input: UpdatePropertyInput,
  ): Promise<Property> {
    await authorizeOrganization(this.deps.identity, actorUserId, organizationId, "property:write");
    const existing = await this.deps.properties.findById(organizationId, propertyId);
    if (!existing || existing.status === "DELETED") {
      throw new AppError("NOT_FOUND", "Property not found");
    }
    const name = input.name === undefined ? existing.name : input.name.trim();
    if (name.length === 0 || name.length > MAX_NAME_LENGTH) {
      throw new AppError("VALIDATION_FAILED", "Property name is required");
    }
    const updated = await this.deps.properties.update({
      ...existing,
      name,
      propertyType: input.propertyType ?? existing.propertyType,
      addressMasked:
        input.addressMasked === undefined ? existing.addressMasked : input.addressMasked?.trim() || null,
      description:
        input.description === undefined ? existing.description : input.description?.trim() || null,
      updatedAt: this.deps.clock.now(),
    });
    await recordAudit(this.deps.identity, {
      organizationId,
      actorUserId,
      action: PropertyAuditAction.PropertyUpdated,
      resourceType: "property",
      resourceId: propertyId,
    });
    return updated;
  }

  /**
   * Soft-delete a property. Assets are moved to DELETION_PENDING so the
   * retention/deletion job can physically remove objects after the recovery
   * window (retention foundation; automation lands in Phase 7).
   */
  async remove(actorUserId: string, organizationId: string, propertyId: string): Promise<void> {
    await authorizeOrganization(this.deps.identity, actorUserId, organizationId, "property:write");
    const existing = await this.deps.properties.findById(organizationId, propertyId);
    if (!existing || existing.status === "DELETED") {
      throw new AppError("NOT_FOUND", "Property not found");
    }
    const now = this.deps.clock.now();
    await this.deps.properties.update({ ...existing, status: "DELETED", updatedAt: now });
    for (const asset of await this.deps.assets.listByProperty(organizationId, propertyId)) {
      if (asset.status === "DELETED" || asset.status === "DELETION_PENDING") continue;
      // Deliberately not checked for `null`. Removal's requirement is that the
      // asset stops being an ordinary active one, and a `null` here means some
      // other writer already moved it in exactly that direction — a concurrent
      // deletion request, or one that landed between the list and this call.
      // Failing property removal over that would refuse the customer's request
      // because it had already partly come true.
      await this.deps.assets.requestDeletion(organizationId, asset.id, now);
    }
    await recordAudit(this.deps.identity, {
      organizationId,
      actorUserId,
      action: PropertyAuditAction.PropertyDeleted,
      resourceType: "property",
      resourceId: propertyId,
    });
  }
}
