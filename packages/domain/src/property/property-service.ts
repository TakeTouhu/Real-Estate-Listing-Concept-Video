import { AppError } from "@app/shared";
import { recordAudit } from "../identity/audit";
import { authorizeOrganization, type AuthContext } from "../identity/authorization";
import type { Clock, IdentityServiceDeps, IdGenerator } from "../identity/ports";
import { PropertyAuditAction } from "./audit";
import type { MediaAssetRepository, PropertyAssignment, PropertyRepository } from "./ports";
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
  /**
   * The responsible user an `OWNER` or `ADMIN` chooses; omitted leaves the
   * Property unassigned. A `MANAGER` or `CREATOR` is always its own responsible
   * user, and naming anyone else is refused (ADR-0052 Decision 10).
   */
  readonly responsibleUserId?: string;
  /**
   * The group an `OWNER` or `ADMIN` chooses, omitted for none; or the one of
   * its own groups a `MANAGER` in several names, omitted for one in a single
   * group. A `CREATOR` names none.
   */
  readonly groupId?: string;
}

/** A change to a Property's assignments: an omitted field keeps its value, null unsets it. */
export interface AssignPropertyInput {
  readonly responsibleUserId?: string | null;
  readonly groupId?: string | null;
}

/** Why a member's assignment was refused, as its audit entry records it. */
export type PropertyAssignmentRefusal =
  /** A `MANAGER` or `CREATOR` named a responsible user other than itself. */
  | "responsible_user_fixed"
  /** A `CREATOR` named a group. */
  | "group_not_selectable"
  /** A `MANAGER` named a group it does not belong to. */
  | "group_not_own"
  /** A `MANAGER` that belongs to no group, so its Property could not be grouped. */
  | "no_group"
  /** Anyone but an `OWNER` or `ADMIN` changing an existing Property's assignments. */
  | "reassignment_role";

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
    const actor = await authorizeOrganization(
      this.deps.identity,
      actorUserId,
      input.organizationId,
      "property.create",
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
    const assignment = await this.initialAssignment(actor, input);
    const id = this.deps.ids.generate("prp");
    const created = await this.deps.properties.create(
      {
        id,
        organizationId: input.organizationId,
        name,
        propertyType: input.propertyType,
        addressMasked: input.addressMasked?.trim() || null,
        description: input.description?.trim() || null,
        status: "ACTIVE",
        createdBy: actorUserId,
        ...assignment,
      },
      {
        organizationId: input.organizationId,
        actorUserId,
        action: PropertyAuditAction.PropertyCreated,
        resourceType: "property",
        resourceId: id,
        metadata: { propertyType: input.propertyType, creatorRole: actor.role, ...assignment },
      },
    );
    if (created.outcome === "STALE") throw assignmentChanged();
    return created.property;
  }

  /**
   * Change an existing Property's responsible user, group or both (ADR-0052
   * Decision 10). An authorization change, so only an `OWNER` or `ADMIN` makes
   * it: `property.edit` alone does not. Anyone else is refused and audited,
   * before the Property is looked up. A change that changes nothing writes
   * nothing (`changed: false`).
   */
  async assign(
    actorUserId: string,
    organizationId: string,
    propertyId: string,
    input: AssignPropertyInput,
  ): Promise<{ readonly property: Property; readonly changed: boolean }> {
    const actor = await authorizeOrganization(this.deps.identity, actorUserId, organizationId);
    if (!mayReassign(actor)) {
      await this.refuse(actor, "assign", "reassignment_role", input, propertyId);
    }
    const existing = await this.deps.properties.findById(organizationId, propertyId);
    if (!existing || existing.status === "DELETED") {
      throw new AppError("NOT_FOUND", "Property not found");
    }
    const expected: PropertyAssignment = { responsibleUserId: existing.responsibleUserId, groupId: existing.groupId };
    const next: PropertyAssignment = {
      responsibleUserId: input.responsibleUserId === undefined ? expected.responsibleUserId : input.responsibleUserId,
      groupId: input.groupId === undefined ? expected.groupId : input.groupId,
    };
    if (next.responsibleUserId === expected.responsibleUserId && next.groupId === expected.groupId) {
      return { property: existing, changed: false };
    }
    // Only a new choice is checked: a member whose role changed after it was
    // assigned keeps the assignment (ADR-0052 Decision 10).
    if (next.responsibleUserId !== expected.responsibleUserId) await this.requireEligible(organizationId, next.responsibleUserId);
    if (next.groupId !== expected.groupId) await this.requireGroup(organizationId, next.groupId);
    const assigned = await this.deps.properties.assign(organizationId, propertyId, expected, next, {
      organizationId,
      actorUserId,
      action: PropertyAuditAction.PropertyAssignmentChanged,
      resourceType: "property",
      resourceId: propertyId,
      metadata: {
        actorRole: actor.role,
        previousResponsibleUserId: expected.responsibleUserId,
        responsibleUserId: next.responsibleUserId,
        previousGroupId: expected.groupId,
        groupId: next.groupId,
      },
    });
    if (assigned.outcome === "STALE") throw assignmentChanged();
    return { property: assigned.property, changed: true };
  }

  async list(actorUserId: string, organizationId: string): Promise<Property[]> {
    await authorizeOrganization(this.deps.identity, actorUserId, organizationId, "property.view");
    return this.deps.properties.listByOrganization(organizationId);
  }

  /** Read a single property, enforcing organization scope. */
  async get(actorUserId: string, organizationId: string, propertyId: string): Promise<Property> {
    await authorizeOrganization(this.deps.identity, actorUserId, organizationId, "property.view");
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
    await authorizeOrganization(this.deps.identity, actorUserId, organizationId, "property.edit");
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
    await authorizeOrganization(this.deps.identity, actorUserId, organizationId, "property.delete");
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

  /**
   * A new Property's assignments, by its creator's role (ADR-0052 Decision 10).
   * An `OWNER` or `ADMIN` chooses either or neither. A `MANAGER` is its
   * responsible user, and its Property goes to one of its own groups: the only
   * one, or the one it names. A `CREATOR` is its responsible user, ungrouped.
   */
  private async initialAssignment(actor: AuthContext, input: CreatePropertyInput): Promise<PropertyAssignment> {
    if (mayReassign(actor)) {
      const responsibleUserId = input.responsibleUserId ?? null;
      const groupId = input.groupId ?? null;
      await this.requireEligible(actor.organizationId, responsibleUserId);
      await this.requireGroup(actor.organizationId, groupId);
      return { responsibleUserId, groupId };
    }
    if (input.responsibleUserId !== undefined && input.responsibleUserId !== actor.userId) {
      await this.refuse(actor, "create", "responsible_user_fixed", input);
    }
    if (actor.role !== "MANAGER") {
      // A CREATOR: VIEWER and BILLING never hold `property.create`.
      if (input.groupId !== undefined) await this.refuse(actor, "create", "group_not_selectable", input);
      return { responsibleUserId: actor.userId, groupId: null };
    }
    const own = await this.deps.identity.repos.groups.listGroupIdsForMember(actor.organizationId, actor.userId);
    if (input.groupId !== undefined) {
      if (!own.includes(input.groupId)) await this.refuse(actor, "create", "group_not_own", input);
      return { responsibleUserId: actor.userId, groupId: input.groupId };
    }
    const [only, ...others] = own;
    if (only === undefined) return this.refuse(actor, "create", "no_group", input);
    if (others.length > 0) {
      throw new AppError("VALIDATION_FAILED", "Choose which of your groups this property belongs to");
    }
    return { responsibleUserId: actor.userId, groupId: only };
  }

  /** A responsible user an `OWNER` or `ADMIN` may choose: any member of the organization but a `BILLING` one. */
  private async requireEligible(organizationId: string, userId: string | null): Promise<void> {
    if (userId === null) return;
    const member = await this.deps.identity.repos.memberships.find(organizationId, userId);
    if (!member || member.role === "BILLING") {
      throw new AppError("VALIDATION_FAILED", "The responsible user must be a member of this organization who is not BILLING");
    }
  }

  /** A group of the organization; a group of another organization is not one. */
  private async requireGroup(organizationId: string, groupId: string | null): Promise<void> {
    if (groupId === null) return;
    if (!(await this.deps.identity.repos.groups.find(organizationId, groupId))) {
      throw new AppError("VALIDATION_FAILED", "The group must be a group of this organization");
    }
  }

  private async refuse(
    actor: AuthContext,
    operation: "create" | "assign",
    reason: PropertyAssignmentRefusal,
    requested: AssignPropertyInput,
    propertyId?: string,
  ): Promise<never> {
    await recordAudit(this.deps.identity, {
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      action: PropertyAuditAction.PropertyAssignmentRefused,
      resourceType: propertyId === undefined ? "organization" : "property",
      resourceId: propertyId ?? actor.organizationId,
      metadata: {
        operation,
        reason,
        actorRole: actor.role,
        responsibleUserId: requested.responsibleUserId ?? null,
        groupId: requested.groupId ?? null,
      },
    });
    throw new AppError("FORBIDDEN", `Role ${actor.role} may not choose this property's responsible user or group`);
  }
}

/** Only an `OWNER` or `ADMIN` chooses a Property's assignments freely, or changes them later. */
function mayReassign(actor: AuthContext): boolean {
  return actor.role === "OWNER" || actor.role === "ADMIN";
}

function assignmentChanged(): AppError {
  return new AppError("VALIDATION_FAILED", "The responsible user or group changed meanwhile; reload and try again");
}
