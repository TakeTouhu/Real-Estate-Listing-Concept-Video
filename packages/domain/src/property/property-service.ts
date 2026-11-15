import { AppError } from "@app/shared";
import { recordAudit } from "../identity/audit";
import { authorizeOrganization, type AuthContext } from "../identity/authorization";
import type { Clock, IdentityServiceDeps, IdGenerator } from "../identity/ports";
import type { Role } from "../identity/roles";
import { compareMembers } from "../team/member-order";
import { PropertyAuditAction } from "./audit";
import type { MediaAssetRepository, PropertyAssignment, PropertyRepository } from "./ports";
import { findReachableProperty, reachOf } from "./reach";
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

/**
 * Why a choice of a Property's assignments was invalid, as `details.reason` of
 * its `VALIDATION_FAILED` (ADR-0144).
 */
export type PropertyAssignmentProblem =
  /** The responsible user is not a member of this organization, or is a `BILLING` one. */
  | "RESPONSIBLE_USER"
  /** The group is not a group of this organization. */
  | "GROUP"
  /** The assignment changed meanwhile. */
  | "STALE";

/** A member the Property page offers as a Property's responsible user (ADR-0144). */
export interface AssignableMember {
  readonly userId: string;
  readonly name: string;
  /** The member's address, for a viewer who holds `member.view`; `null` for anyone else. */
  readonly email: string | null;
  readonly role: Role;
}

/** A group a Property may be put in, as the forms list it. */
export interface GroupChoice {
  readonly id: string;
  readonly name: string;
}

/** What an `OWNER` or `ADMIN` may choose for a Property, and what it has now (ADR-0144). */
export interface PropertyAssignmentChoices {
  readonly responsibleUserId: string | null;
  readonly groupId: string | null;
  /**
   * Any member but a `BILLING` one, and the current responsible user whatever
   * their role now, in the members page's order.
   */
  readonly members: readonly AssignableMember[];
  /** The organization's groups, by name. */
  readonly groups: readonly GroupChoice[];
}

/** What a member may choose for a Property it creates, by its role (ADR-0145). */
export type PropertyCreationChoices =
  /** An `OWNER` or `ADMIN`: any member but a `BILLING` one, any group, either, both or neither. */
  | {
      readonly kind: "ANY";
      readonly members: readonly AssignableMember[];
      readonly groups: readonly GroupChoice[];
    }
  /** A `MANAGER`: itself as the responsible user, and one of its own groups, by name; none if it is in none. */
  | { readonly kind: "OWN_GROUP"; readonly groups: readonly GroupChoice[] }
  /** A `CREATOR`: itself as the responsible user, in no group. */
  | { readonly kind: "SELF" };

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
   *
   * `shown`, when given, is the assignment the caller saw: a Property whose
   * assignment is no longer that is not changed (ADR-0144). Every invalid
   * choice is `VALIDATION_FAILED` with a {@link PropertyAssignmentProblem} as
   * `details.reason`.
   */
  async assign(
    actorUserId: string,
    organizationId: string,
    propertyId: string,
    input: AssignPropertyInput,
    shown?: PropertyAssignment,
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
    if (shown && (shown.responsibleUserId !== expected.responsibleUserId || shown.groupId !== expected.groupId)) {
      throw assignmentChanged();
    }
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

  /**
   * What the Property page offers an `OWNER` or `ADMIN` to change a Property's
   * assignments (ADR-0144); `null` for anyone else, who may change neither.
   * Reads the members' accounts together, writes nothing and audits nothing.
   *
   * @throws AppError FORBIDDEN without `property.view`, NOT_FOUND for a Property it does not reach.
   */
  async assignmentChoices(
    actorUserId: string,
    organizationId: string,
    propertyId: string,
  ): Promise<PropertyAssignmentChoices | null> {
    const actor = await authorizeOrganization(this.deps.identity, actorUserId, organizationId, "property.view");
    if (!mayReassign(actor)) return null;
    const property = await this.requireReachable(actor, propertyId);
    const [members, groups] = await Promise.all([
      this.assignableMembers(actor, property.responsibleUserId),
      this.groupChoices(organizationId),
    ]);
    return { responsibleUserId: property.responsibleUserId, groupId: property.groupId, members, groups };
  }

  /**
   * What the "Add a property" form offers a member to choose for a Property it
   * creates (ADR-0145), as {@link create} decides it by the member's role;
   * `null` for a member without `property.create`. Reads the members' accounts
   * together, writes nothing and audits nothing.
   *
   * @throws AppError FORBIDDEN for a non-member.
   */
  async creationChoices(actorUserId: string, organizationId: string): Promise<PropertyCreationChoices | null> {
    const actor = await authorizeOrganization(this.deps.identity, actorUserId, organizationId);
    if (!actor.permissions.includes("property.create")) return null;
    if (mayReassign(actor)) {
      const [members, groups] = await Promise.all([
        this.assignableMembers(actor, null),
        this.groupChoices(organizationId),
      ]);
      return { kind: "ANY", members, groups };
    }
    if (actor.role !== "MANAGER") return { kind: "SELF" };
    const [own, groups] = await Promise.all([
      this.deps.identity.repos.groups.listGroupIdsForMember(organizationId, actorUserId),
      this.groupChoices(organizationId),
    ]);
    return { kind: "OWN_GROUP", groups: groups.filter(({ id }) => own.includes(id)) };
  }

  /** The organization's Properties the member reaches (ADR-0052 Decision 10). */
  async list(actorUserId: string, organizationId: string): Promise<Property[]> {
    const actor = await authorizeOrganization(this.deps.identity, actorUserId, organizationId, "property.view");
    return this.deps.properties.listReachable(await reachOf(this.deps.identity, actor));
  }

  /** Read a single property the member reaches. */
  async get(actorUserId: string, organizationId: string, propertyId: string): Promise<Property> {
    const actor = await authorizeOrganization(this.deps.identity, actorUserId, organizationId, "property.view");
    return this.requireReachable(actor, propertyId);
  }

  async update(
    actorUserId: string,
    organizationId: string,
    propertyId: string,
    input: UpdatePropertyInput,
  ): Promise<Property> {
    const actor = await authorizeOrganization(this.deps.identity, actorUserId, organizationId, "property.edit");
    const existing = await this.requireReachable(actor, propertyId);
    const name = input.name === undefined ? existing.name : input.name.trim();
    if (name.length === 0 || name.length > MAX_NAME_LENGTH) {
      throw new AppError("VALIDATION_FAILED", "Property name is required");
    }
    // Only the fields the member changed, and only while the Property still
    // stands: a deletion that saved since the read is not undone (ADR-0101).
    const updated = await this.deps.properties.updateDetails(organizationId, propertyId, {
      ...(input.name === undefined ? {} : { name }),
      ...(input.propertyType === undefined ? {} : { propertyType: input.propertyType }),
      ...(input.addressMasked === undefined ? {} : { addressMasked: input.addressMasked?.trim() || null }),
      ...(input.description === undefined ? {} : { description: input.description?.trim() || null }),
    });
    if (!updated) throw new AppError("NOT_FOUND", "Property not found");
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
    const actor = await authorizeOrganization(this.deps.identity, actorUserId, organizationId, "property.delete");
    await this.requireReachable(actor, propertyId);
    const now = this.deps.clock.now();
    // Its status alone, and once: a second deletion saving first answers this
    // one as not found, as the next request would be, with one audit entry.
    if (!(await this.deps.properties.markDeleted(organizationId, propertyId))) {
      throw new AppError("NOT_FOUND", "Property not found");
    }
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
   * A Property the member reaches and that is not deleted. Out of reach is
   * answered exactly as a Property that does not exist (Phase 6I, ADR-0064).
   */
  private async requireReachable(actor: AuthContext, propertyId: string): Promise<Property> {
    const property = await findReachableProperty(this.deps.identity, this.deps.properties, actor, propertyId);
    if (!property || property.status === "DELETED") {
      throw new AppError("NOT_FOUND", "Property not found");
    }
    return property;
  }

  /**
   * The members an `OWNER` or `ADMIN` may make a Property's responsible user:
   * any but a `BILLING` one, and `keep` whatever its role now, since a role
   * change does not rewrite an assignment; in the members page's order. A
   * member's address only for an actor holding `member.view`.
   */
  private async assignableMembers(actor: AuthContext, keep: string | null): Promise<AssignableMember[]> {
    const { repos } = this.deps.identity;
    const choosable = (await repos.memberships.listByOrganization(actor.organizationId))
      .filter(({ userId, role }) => role !== "BILLING" || userId === keep)
      .sort(compareMembers);
    const users = await Promise.all(choosable.map(({ userId }) => repos.users.findById(userId)));
    const addresses = actor.permissions.includes("member.view");
    return choosable.flatMap(({ userId, role }, index): AssignableMember[] => {
      const user = users[index];
      return user ? [{ userId, name: user.name, email: addresses ? user.email : null, role }] : [];
    });
  }

  /** The organization's groups, by name. */
  private async groupChoices(organizationId: string): Promise<GroupChoice[]> {
    const groups = await this.deps.identity.repos.groups.listByOrganization(organizationId);
    return groups.map(({ id, name }) => ({ id, name }));
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
      const message = "The responsible user must be a member of this organization who is not BILLING";
      throw invalid(message, "RESPONSIBLE_USER");
    }
  }

  /** A group of the organization; a group of another organization is not one. */
  private async requireGroup(organizationId: string, groupId: string | null): Promise<void> {
    if (groupId === null) return;
    if (!(await this.deps.identity.repos.groups.find(organizationId, groupId))) {
      throw invalid("The group must be a group of this organization", "GROUP");
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
  return invalid("The responsible user or group changed meanwhile; reload and try again", "STALE");
}

function invalid(message: string, reason: PropertyAssignmentProblem): AppError {
  return new AppError("VALIDATION_FAILED", message, { details: { reason } });
}
