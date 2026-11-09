import { AppError, slugify } from "@app/shared";
import { mayChangeMfaRequirement } from "../mfa/requirement";
import { AuditAction, recordAudit } from "./audit";
import { authorizeOrganization, effectivePermissionsOf } from "./authorization";
import type { IdentityServiceDeps } from "./ports";
import type { Permission, Role } from "./roles";
import type { Membership, Organization } from "./types";

export interface UserOrganization {
  readonly organization: Organization;
  readonly role: Role;
  /** Effective permissions in this organization: the role's plus individual grants. */
  readonly permissions: readonly Permission[];
}

export interface CreateOrganizationInput {
  readonly name: string;
}

export interface CreateOrganizationResult {
  readonly organization: Organization;
  readonly membership: Membership;
}

/**
 * How many times creating an organization looks for a free slug before it gives
 * up, when organizations of the same name keep taking it first (ADR-0127).
 */
export const ORGANIZATION_SLUG_ATTEMPTS = 3;

export class OrganizationService {
  constructor(private readonly deps: IdentityServiceDeps) {}

  /**
   * Create an organization and make the actor its OWNER, with an audit event,
   * in one transaction (ADR-0127). A slug taken meanwhile by an organization
   * of the same name is looked for again, up to
   * {@link ORGANIZATION_SLUG_ATTEMPTS} times.
   */
  async createOrganization(
    actorUserId: string,
    input: CreateOrganizationInput,
  ): Promise<CreateOrganizationResult> {
    const name = input.name.trim();
    if (name.length === 0) {
      throw new AppError("VALIDATION_FAILED", "Organization name is required");
    }
    for (let attempt = 1; attempt <= ORGANIZATION_SLUG_ATTEMPTS; attempt += 1) {
      const slug = await this.uniqueSlug(name);
      const id = this.deps.ids.generate("org");
      const created = await this.deps.repos.organizations.createWithOwner({
        organization: { id, name, slug, status: "ACTIVE" },
        ownerUserId: actorUserId,
        audit: {
          organizationId: id,
          actorUserId,
          action: AuditAction.OrganizationCreated,
          resourceType: "organization",
          resourceId: id,
          metadata: { slug },
        },
      });
      if (created.outcome === "CREATED") {
        return { organization: created.organization, membership: created.membership };
      }
    }
    throw new AppError(
      "VALIDATION_FAILED",
      "Other organizations of the same name were being created at the same moment; try again",
    );
  }

  /**
   * Require MFA of every member of the organization, or stop requiring it
   * (ADR-0065 Decision 18). Only an `OWNER` or `ADMIN` may; anyone else is
   * refused and audited. A change that changes nothing writes nothing
   * (`changed: false`). It applies to each member from their next request.
   */
  async setMfaRequirement(
    actorUserId: string,
    organizationId: string,
    required: boolean,
  ): Promise<{ readonly organization: Organization; readonly changed: boolean }> {
    const actor = await authorizeOrganization(this.deps, actorUserId, organizationId);
    if (!mayChangeMfaRequirement(actor.role)) {
      await recordAudit(this.deps, {
        organizationId,
        actorUserId,
        action: AuditAction.OrganizationMfaRequirementRefused,
        resourceType: "organization",
        resourceId: organizationId,
        metadata: { actorRole: actor.role, required },
      });
      throw new AppError("FORBIDDEN", `Role ${actor.role} may not change whether MFA is required`);
    }
    const organization = await this.deps.repos.organizations.findById(organizationId);
    if (!organization) throw new AppError("NOT_FOUND", "Organization not found");
    if (organization.mfaRequired === required) return { organization, changed: false };
    const outcome = await this.deps.repos.organizations.setMfaRequired({
      organizationId,
      actorUserId,
      actorRole: actor.role,
      expected: organization.mfaRequired,
      required,
      audit: {
        organizationId,
        actorUserId,
        action: AuditAction.OrganizationMfaRequirementChanged,
        resourceType: "organization",
        resourceId: organizationId,
        metadata: { actorRole: actor.role, required },
      },
    });
    if (outcome === "STALE") {
      throw new AppError("VALIDATION_FAILED", "The MFA requirement or your role changed meanwhile; reload and try again");
    }
    return { organization: { ...organization, mfaRequired: required }, changed: true };
  }

  /** List the organizations a user belongs to, with their role and effective permissions in each. */
  async listForUser(userId: string): Promise<UserOrganization[]> {
    const memberships = await this.deps.repos.memberships.listByUser(userId);
    const result: UserOrganization[] = [];
    for (const membership of memberships) {
      const organization = await this.deps.repos.organizations.findById(membership.organizationId);
      if (organization) {
        result.push({ organization, role: membership.role, permissions: await effectivePermissionsOf(this.deps, membership) });
      }
    }
    return result;
  }

  private async uniqueSlug(name: string): Promise<string> {
    const base = slugify(name);
    let slug = base;
    let suffix = 1;
    while (await this.deps.repos.organizations.findBySlug(slug)) {
      slug = `${base}-${suffix}`;
      suffix += 1;
    }
    return slug;
  }
}
