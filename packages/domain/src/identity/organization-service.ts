import { AppError, slugify } from "@app/shared";
import { AuditAction, recordAudit } from "./audit";
import { effectivePermissionsOf } from "./authorization";
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

export class OrganizationService {
  constructor(private readonly deps: IdentityServiceDeps) {}

  /** Create an organization and make the actor its OWNER, with an audit event. */
  async createOrganization(
    actorUserId: string,
    input: CreateOrganizationInput,
  ): Promise<CreateOrganizationResult> {
    const name = input.name.trim();
    if (name.length === 0) {
      throw new AppError("VALIDATION_FAILED", "Organization name is required");
    }
    const slug = await this.uniqueSlug(name);
    const organization = await this.deps.repos.organizations.create({
      id: this.deps.ids.generate("org"),
      name,
      slug,
      status: "ACTIVE",
    });
    const membership = await this.deps.repos.memberships.create({
      organizationId: organization.id,
      userId: actorUserId,
      role: "OWNER",
    });
    await recordAudit(this.deps, {
      organizationId: organization.id,
      actorUserId,
      action: AuditAction.OrganizationCreated,
      resourceType: "organization",
      resourceId: organization.id,
      metadata: { slug },
    });
    return { organization, membership };
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
