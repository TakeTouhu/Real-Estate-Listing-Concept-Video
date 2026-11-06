import { beforeEach, describe, expect, it } from "vitest";
import { AppError } from "@app/shared";
import { managedDeliverableOutputKey } from "../deliverable-composition-execution/durable";
import { AuthService } from "../identity/auth-service";
import { OrganizationService } from "../identity/organization-service";
import { PermissionGrantService } from "../identity/permission-grant-service";
import type { Property } from "../property/types";
import type { VideoProject } from "../storyboard/types";
import { createTestDeps, type TestDeps } from "../testing/in-memory";
import {
  VIDEO_AUDIT_RESOURCE_TYPE,
  VIDEO_PREVIEW_LINK_TTL_SECONDS,
  VideoAuditAction,
  VideoPreviewService,
} from "./preview";
import type { VideoProgressRecord } from "./progress";

/**
 * A link to watch a project's delivered video (GS-12b, ADR-0116): given only
 * for the video its progress shows as completed, to the progress's readers,
 * for the job's current version, and audited each time.
 */

const NOW = new Date("2026-04-20T09:00:00.000Z");
const PROJECT = "vpr_preview";
const PROPERTY = "prp_preview";
const VERSION = "gdv_current";

function delivered(overrides: Partial<VideoProgressRecord> = {}): VideoProgressRecord {
  return {
    jobId: "gjob_1",
    jobState: "DELIVERABLE_READY",
    deliveredVersionId: VERSION,
    qualityTier: "HIGH_QUALITY",
    durationSeconds: 45,
    requiredUnits: 2,
    reservationState: "CONSUMED",
    sceneCount: 3,
    scenesReady: 3,
    ...overrides,
  };
}

describe("a link to watch a project's delivered video", () => {
  let deps: TestDeps;
  let orgId: string;
  let owner: string;
  let viewer: string;
  let billing: string;
  let creator: string;
  let property: Property;
  let latest: VideoProgressRecord | null;
  let signed: [string, number][];
  let signing: () => Promise<{ url: string; expiresAt: Date }>;

  function service(): VideoPreviewService {
    const project: VideoProject = {
      id: PROJECT,
      organizationId: orgId,
      propertyId: PROPERTY,
      name: "Walkthrough",
      status: "STORYBOARD_READY",
      durationSeconds: 45,
      aspectRatio: "16:9",
      targetOutputResolution: "1080p",
      stylePreset: null,
      cameraMotion: null,
      prompt: null,
      negativePrompt: null,
      includeMusic: false,
      includeCaptions: false,
      brandTemplateId: null,
      compositionFingerprint: "sha256:composed",
      createdBy: owner,
      createdAt: NOW,
      updatedAt: NOW,
    };
    return new VideoPreviewService({
      identity: deps,
      properties: {
        findById: (organizationId, id) =>
          Promise.resolve(organizationId === property.organizationId && id === property.id ? property : null),
      },
      projects: {
        findById: (organizationId, id) =>
          Promise.resolve(organizationId === orgId && id === PROJECT ? project : null),
      },
      progress: { findLatest: () => Promise.resolve(latest) },
      storage: {
        createSignedDownloadUrl: (key, ttlSeconds) => {
          signed.push([key, ttlSeconds]);
          return signing();
        },
      },
    });
  }

  const audits = () =>
    deps.repos.auditLogs.all().filter((entry) => entry.action === VideoAuditAction.PreviewLinkIssued);

  async function refusal(actor: string, projectId = PROJECT): Promise<AppError> {
    const error = await service()
      .link(actor, orgId, projectId)
      .then(() => null, (thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(AppError);
    return error as AppError;
  }

  beforeEach(async () => {
    deps = createTestDeps();
    const auth = new AuthService(deps, { sessionTtlSeconds: 3600 });
    const register = async (name: string) =>
      (await auth.register({ email: `${name}@example.com`, name, password: "password-123456" })).id;
    owner = await register("owner");
    ({ organization: { id: orgId } } = await new OrganizationService(deps).createOrganization(owner, { name: "Org" }));
    viewer = await register("viewer");
    billing = await register("billing");
    creator = await register("creator");
    await deps.repos.memberships.create({ organizationId: orgId, userId: viewer, role: "VIEWER" });
    await deps.repos.memberships.create({ organizationId: orgId, userId: billing, role: "BILLING" });
    await deps.repos.memberships.create({ organizationId: orgId, userId: creator, role: "CREATOR" });
    deps.clock.set(NOW);
    property = {
      id: PROPERTY,
      organizationId: orgId,
      name: "Harbour View",
      propertyType: "APARTMENT",
      addressMasked: null,
      description: null,
      status: "ACTIVE",
      createdBy: owner,
      responsibleUserId: null,
      groupId: null,
      createdAt: NOW,
      updatedAt: NOW,
    };
    latest = delivered();
    signed = [];
    signing = () => Promise.resolve({ url: "https://app.test/api/storage/download?token=t", expiresAt: NOW });
  });

  it("signs the current version of the delivered video for a reader, briefly, and audits the link", async () => {
    // A VIEWER reaches only the Properties it is responsible for.
    property = { ...property, responsibleUserId: viewer };
    for (const actor of [owner, viewer]) {
      expect(await service().link(actor, orgId, PROJECT)).toEqual({
        url: "https://app.test/api/storage/download?token=t",
        expiresAt: NOW,
      });
    }
    const key = managedDeliverableOutputKey({ organizationId: orgId, deliverableVersionId: VERSION });
    expect(signed).toEqual([
      [key, 300],
      [key, 300],
    ]);
    expect(VIDEO_PREVIEW_LINK_TTL_SECONDS).toBe(300);
    expect(audits().map(({ organizationId, actorUserId, resourceType, resourceId, metadata }) => ({
      organizationId,
      actorUserId,
      resourceType,
      resourceId,
      metadata,
    }))).toEqual([owner, viewer].map((actorUserId) => ({
      organizationId: orgId,
      actorUserId,
      resourceType: VIDEO_AUDIT_RESOURCE_TYPE,
      resourceId: VERSION,
      metadata: { jobId: "gjob_1" },
    })));
    expect(VideoAuditAction.PreviewLinkIssued).toBe("video.preview_link_issued");
    expect(VIDEO_AUDIT_RESOURCE_TYPE).toBe("generation_deliverable_version");
  });

  it("signs the delivered version while a new one is made, as its progress shows it completed", async () => {
    latest = delivered({ jobState: "GENERATING", scenesReady: 2 });
    expect(await service().link(owner, orgId, PROJECT)).not.toBeNull();
    const key = managedDeliverableOutputKey({ organizationId: orgId, deliverableVersionId: VERSION });
    expect(signed).toEqual([[key, 300]]);
    expect(audits().map(({ resourceId }) => resourceId)).toEqual([VERSION]);
  });

  it("gives no link, and signs and audits nothing, for a project with no video to watch", async () => {
    for (const none of [
      null,
      delivered({ jobState: "COMPOSING", deliveredVersionId: null, reservationState: "RESERVED" }),
      delivered({ jobState: "FAILED_TERMINAL", deliveredVersionId: null, reservationState: "RELEASED" }),
      // A job marked delivered with no version set names no video to sign.
      delivered({ deliveredVersionId: null }),
      // One that never reserved Units, delivered and then cancelled: its
      // progress does not show it completed.
      delivered({ jobState: "CANCELLED", reservationState: null }),
    ]) {
      latest = none;
      expect(await service().link(owner, orgId, PROJECT)).toBeNull();
    }
    expect(signed).toEqual([]);
    expect(audits()).toEqual([]);
  });

  it("refuses those who may not read its progress, before anything is signed", async () => {
    expect((await refusal(billing)).code).toBe("FORBIDDEN");
    // Seeing the Property is not enough: watching its video needs video.view.
    await new PermissionGrantService(deps).grant(owner, orgId, billing, "property.view");
    expect((await refusal(billing)).code).toBe("FORBIDDEN");
    // Nor is downloading it (ADR-0119).
    await new PermissionGrantService(deps).grant(owner, orgId, billing, "video.download");
    expect((await refusal(billing)).code).toBe("FORBIDDEN");
    // A CREATOR reaches only the Properties it is responsible for.
    expect((await refusal(creator)).code).toBe("NOT_FOUND");
    expect((await refusal(owner, "vpr_missing")).code).toBe("NOT_FOUND");
    expect(signed).toEqual([]);
    expect(audits()).toEqual([]);
  });

  it("refuses a video whose Units contradict its delivery, as its progress does", async () => {
    for (const contradiction of [
      delivered({ reservationState: "RELEASED" }),
      // Not delivered, its Units used.
      delivered({ jobState: "GENERATING", deliveredVersionId: null }),
      // Delivered, then ended with its Units used: no code ends such a job (a
      // failed new version rolls back to the delivered one).
      delivered({ jobState: "CANCELLED" }),
    ]) {
      latest = contradiction;
      const error = await refusal(owner);
      expect(error.code).toBe("INTERNAL_ERROR");
      expect(error.details).toEqual({ jobId: "gjob_1" });
    }
    expect(signed).toEqual([]);
    expect(audits()).toEqual([]);
  });

  it("still gives a link to a video whose Property was deleted, as its progress reads it", async () => {
    property = { ...property, status: "DELETED" };
    expect(await service().link(owner, orgId, PROJECT)).not.toBeNull();
    expect(audits()).toHaveLength(1);
  });

  it("gives no link that could not be audited, and audits none that could not be signed", async () => {
    signing = () => Promise.reject(new Error("store down"));
    await expect(service().link(owner, orgId, PROJECT)).rejects.toThrow("store down");
    expect(audits()).toEqual([]);
    signing = () => Promise.resolve({ url: "https://app.test/x", expiresAt: NOW });
    deps.repos.auditLogs.append = () => Promise.reject(new Error("audit down"));
    await expect(service().link(owner, orgId, PROJECT)).rejects.toThrow("audit down");
  });
});
