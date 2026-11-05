import { beforeEach, describe, expect, it } from "vitest";
import { AppError } from "@app/shared";
import { managedDeliverableOutputKey } from "../deliverable-composition-execution/durable";
import { AuthService } from "../identity/auth-service";
import { OrganizationService } from "../identity/organization-service";
import { PermissionGrantService } from "../identity/permission-grant-service";
import { isAttachmentFilename, utf8ByteLength } from "../property/attachment-filename";
import type { SignedDownloadOptions } from "../property/ports";
import type { Property } from "../property/types";
import type { VideoProject } from "../storyboard/types";
import { createTestDeps, type TestDeps } from "../testing/in-memory";
import { VIDEO_DOWNLOAD_LINK_TTL_SECONDS, VideoDownloadService, videoDownloadFilename } from "./download";
import { VIDEO_AUDIT_RESOURCE_TYPE, VideoAuditAction } from "./preview";
import type { VideoProgressRecord } from "./progress";

/**
 * A link to download a project's delivered video (GS-12c-2, ADR-0119): the video
 * a link to watch it names, for a member holding `video.download`, saved under
 * the project's name, and audited each time.
 */

const NOW = new Date("2026-04-20T09:00:00.000Z");
const PROJECT = "vpr_download";
const PROPERTY = "prp_download";
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

describe("the name a project's video is saved under", () => {
  it("is the project's name, with .mp4", () => {
    expect(videoDownloadFilename("Harbour View")).toBe("Harbour View.mp4");
    expect(videoDownloadFilename("渋谷区 3LDK マンション")).toBe("渋谷区 3LDK マンション.mp4");
    expect(videoDownloadFilename("Café ☕ 😀 (v2)")).toBe("Café ☕ 😀 (v2).mp4");
  });

  it("has each character no file name holds as _, and each run of spaces as one", () => {
    expect(videoDownloadFilename('1F/2F: "Lobby" <A|B>?*\\')).toBe("1F_2F_ _Lobby_ _A_B____.mp4");
    expect(videoDownloadFilename("Harbour\t\r\n  View\u3000East\u2028West")).toBe("Harbour View East West.mp4");
    // Invisible ones too: a zero-width space is not white space, though a byte-order mark is to JavaScript.
    expect(videoDownloadFilename("Harbour\u0000\u202eView\u200b")).toBe("Harbour__View_.mp4");
    expect(videoDownloadFilename("Harbour\ufeffView")).toBe("Harbour View.mp4");
    // The joiners an emoji sequence and Persian are written with stay.
    expect(videoDownloadFilename("\u{1f468}\u200d\u{1f469}\u200d\u{1f467} home")).toBe(
      "\u{1f468}\u200d\u{1f469}\u200d\u{1f467} home.mp4",
    );
    expect(videoDownloadFilename("\u0645\u06cc\u200c\u062e\u0648\u0627\u0647\u0645")).toBe(
      "\u0645\u06cc\u200c\u062e\u0648\u0627\u0647\u0645.mp4",
    );
  });

  it("loses the spaces and dots at either end, however many", () => {
    expect(videoDownloadFilename("  ..Harbour View. . ")).toBe("Harbour View.mp4");
    expect(videoDownloadFilename("v1.2 final")).toBe("v1.2 final.mp4");
    expect(videoDownloadFilename(`${". ".repeat(10_000)}Harbour${" .".repeat(10_000)}`)).toBe("Harbour.mp4");
    // In one pass: a run of dots and spaces inside a long name, which a pattern trimming the ends would scan from
    // each of its characters (minutes for this one), takes a moment.
    const started = performance.now();
    expect(videoDownloadFilename(`a${" .".repeat(100_000)}b`)).toBe("a.mp4");
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it("is video.mp4 when the project's name leaves nothing", () => {
    for (const name of ["", "   ", "...", " . \t. "]) expect(videoDownloadFilename(name)).toBe("video.mp4");
    // A character no file name holds still leaves something.
    expect(videoDownloadFilename("/")).toBe("_.mp4");
  });

  it("is composed, so a name typed on any device reads the same", () => {
    expect(videoDownloadFilename("\u30ab\u3099\u30fc\u30c7\u30f3")).toBe("\u30ac\u30fc\u30c7\u30f3.mp4");
  });

  it("is cut to fit, never inside a character, and never leaving loose ends", () => {
    expect(videoDownloadFilename("a".repeat(300))).toBe(`${"a".repeat(236)}.mp4`);
    expect(videoDownloadFilename("日".repeat(100))).toBe(`${"日".repeat(78)}.mp4`);
    expect(videoDownloadFilename("😀".repeat(100))).toBe(`${"😀".repeat(59)}.mp4`);
    expect(videoDownloadFilename(`${"a".repeat(235)} b`)).toBe(`${"a".repeat(235)}.mp4`);
    expect(videoDownloadFilename(`${"a".repeat(234)}..b`)).toBe(`${"a".repeat(234)}.mp4`);
    // Nothing after the cut is kept, even what would still fit.
    expect(videoDownloadFilename(`${"a".repeat(235)}日b`)).toBe(`${"a".repeat(235)}.mp4`);
    // A flag is two code points, and one character: never half of it.
    expect(videoDownloadFilename(`${"a".repeat(232)}\u{1f1ef}\u{1f1f5}`)).toBe(`${"a".repeat(232)}.mp4`);
    expect(videoDownloadFilename(`${"a".repeat(228)}\u{1f1ef}\u{1f1f5}`)).toBe(
      `${"a".repeat(228)}\u{1f1ef}\u{1f1f5}.mp4`,
    );
    // A letter and its accent are one character too.
    expect(videoDownloadFilename(`${"a".repeat(234)}q\u0301`)).toBe(`${"a".repeat(234)}.mp4`);
    // One character bigger than the room is never cut inside: the name ends before it (ADR-0119 Decision 1).
    expect(videoDownloadFilename(`b a${"\u0301".repeat(200)}`)).toBe("b.mp4");
    expect(videoDownloadFilename(`a${"\u0301".repeat(200)}`)).toBe("video.mp4");
    expect(utf8ByteLength(videoDownloadFilename("日".repeat(100)))).toBe(238);
  });

  it("is always one a signed link may carry", () => {
    for (const name of [
      "Harbour View",
      "\u0000\t\u202e\ufeff\ud800\udc00\ud800",
      '\\/:*?"<>|',
      "😀".repeat(200),
      `${"日".repeat(78)}\u0001`,
      "",
    ]) {
      expect(isAttachmentFilename(videoDownloadFilename(name))).toBe(true);
    }
    // And names drawn, the same way every run, from the characters most likely to break one: controls, separators,
    // invisible and direction marks, lone surrogates, accents, joiners, flags, tags, jamo and conjuncts.
    const risky = [
      0x0, 0x9, 0x20, 0x2e, 0x2f, 0x22, 0x5c, 0x61, 0x301, 0x316, 0x915, 0x94d, 0x1100, 0x2028, 0x200b, 0x200d,
      0x202e, 0x3000, 0x65e5, 0xd800, 0xdc00, 0xfeff, 0x1f1ef, 0x1f1f5, 0x1f468, 0xe0067,
    ];
    let seed = 20_261_105;
    const next = (below: number): number => {
      seed = (Math.imul(seed, 1_103_515_245) + 12_345) >>> 0;
      return seed % below;
    };
    const names = Array.from({ length: 1_000 }, () =>
      String.fromCodePoint(...Array.from({ length: next(320) }, () => risky[next(risky.length)] ?? 0x61)),
    );
    expect(names.filter((name) => !isAttachmentFilename(videoDownloadFilename(name)))).toEqual([]);
  });
});

describe("a link to download a project's delivered video", () => {
  let deps: TestDeps;
  let orgId: string;
  let owner: string;
  let viewer: string;
  let billing: string;
  let creator: string;
  let property: Property;
  let projectName: string;
  let latest: VideoProgressRecord | null;
  let signed: [string, number, SignedDownloadOptions | undefined][];
  /** How many times the project's video was read. */
  let reads: number;
  let signing: () => Promise<{ url: string; expiresAt: Date }>;

  function service(): VideoDownloadService {
    const project: VideoProject = {
      id: PROJECT,
      organizationId: orgId,
      propertyId: PROPERTY,
      name: projectName,
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
    return new VideoDownloadService({
      identity: deps,
      properties: {
        findById: (organizationId, id) =>
          Promise.resolve(organizationId === property.organizationId && id === property.id ? property : null),
      },
      projects: {
        findById: (organizationId, id) =>
          Promise.resolve(organizationId === orgId && id === PROJECT ? project : null),
      },
      progress: {
        findLatest: () => {
          reads += 1;
          return Promise.resolve(latest);
        },
      },
      storage: {
        createSignedDownloadUrl: (key, ttlSeconds, options) => {
          signed.push([key, ttlSeconds, options]);
          return signing();
        },
      },
    });
  }

  const audits = () => deps.repos.auditLogs.all().filter((entry) => entry.action.startsWith("video."));

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
    projectName = "Walkthrough";
    latest = delivered();
    signed = [];
    reads = 0;
    signing = () => Promise.resolve({ url: "https://app.test/api/storage/download?token=t", expiresAt: NOW });
  });

  it("signs the current version for a member who may download it, briefly, as a file, and audits it", async () => {
    // A VIEWER reaches only the Properties it is responsible for.
    property = { ...property, responsibleUserId: viewer };
    for (const actor of [owner, viewer]) {
      expect(await service().link(actor, orgId, PROJECT)).toEqual({
        url: "https://app.test/api/storage/download?token=t",
        expiresAt: NOW,
      });
    }
    const key = managedDeliverableOutputKey({ organizationId: orgId, deliverableVersionId: VERSION });
    const asFile = { attachmentFilename: "Walkthrough.mp4" };
    expect(signed).toEqual([
      [key, 300, asFile],
      [key, 300, asFile],
    ]);
    expect(VIDEO_DOWNLOAD_LINK_TTL_SECONDS).toBe(300);
    expect(
      audits().map(({ organizationId, actorUserId, action, resourceType, resourceId, metadata }) => ({
        organizationId,
        actorUserId,
        action,
        resourceType,
        resourceId,
        metadata,
      })),
    ).toEqual(
      [owner, viewer].map((actorUserId) => ({
        organizationId: orgId,
        actorUserId,
        action: "video.download_link_issued",
        resourceType: VIDEO_AUDIT_RESOURCE_TYPE,
        resourceId: VERSION,
        metadata: { jobId: "gjob_1" },
      })),
    );
    expect(VideoAuditAction.DownloadLinkIssued).toBe("video.download_link_issued");
  });

  it("saves it under the project's name, made safe for a file", async () => {
    projectName = '  渋谷/Harbour View "East" ';
    await service().link(owner, orgId, PROJECT);
    expect(signed.map(([, , options]) => options)).toEqual([{ attachmentFilename: "渋谷_Harbour View _East_.mp4" }]);
  });

  it("signs the delivered version while a new one is made, as its progress shows it completed", async () => {
    latest = delivered({ jobState: "GENERATING", scenesReady: 2 });
    expect(await service().link(owner, orgId, PROJECT)).not.toBeNull();
    const key = managedDeliverableOutputKey({ organizationId: orgId, deliverableVersionId: VERSION });
    expect(signed.map(([signedKey]) => signedKey)).toEqual([key]);
    expect(audits().map(({ resourceId }) => resourceId)).toEqual([VERSION]);
  });

  it("gives no link, and signs and audits nothing, for a project with no video to download", async () => {
    for (const none of [
      null,
      delivered({ jobState: "COMPOSING", deliveredVersionId: null, reservationState: "RESERVED" }),
      delivered({ jobState: "FAILED_TERMINAL", deliveredVersionId: null, reservationState: "RELEASED" }),
      // A job marked delivered with no version set names no video to sign.
      delivered({ deliveredVersionId: null }),
      // One that never reserved Units, delivered and then cancelled.
      delivered({ jobState: "CANCELLED", reservationState: null }),
    ]) {
      latest = none;
      expect(await service().link(owner, orgId, PROJECT)).toBeNull();
    }
    expect(signed).toEqual([]);
    expect(audits()).toEqual([]);
  });

  it("refuses a member without video.download, even one who may watch it, before its video is read", async () => {
    expect((await refusal(billing)).code).toBe("FORBIDDEN");
    // Watching the video is not downloading it.
    await new PermissionGrantService(deps).grant(owner, orgId, billing, "video.view");
    expect((await refusal(billing)).code).toBe("FORBIDDEN");
    expect(reads).toBe(0);
    expect(signed).toEqual([]);
    expect(audits()).toEqual([]);
  });

  it("gives a link to a member holding video.download alone", async () => {
    // A BILLING member reaches every Property, and holds neither video permission until granted one.
    await new PermissionGrantService(deps).grant(owner, orgId, billing, "video.download");
    expect(await service().link(billing, orgId, PROJECT)).not.toBeNull();
    expect(audits().map(({ actorUserId }) => actorUserId)).toEqual([billing]);
  });

  it("answers a project out of reach as one that does not exist, before its video is read", async () => {
    // A CREATOR reaches only the Properties it is responsible for.
    expect((await refusal(creator)).code).toBe("NOT_FOUND");
    expect((await refusal(owner, "vpr_missing")).code).toBe("NOT_FOUND");
    expect(reads).toBe(0);
    expect(signed).toEqual([]);
    expect(audits()).toEqual([]);
  });

  it("refuses another organization's member, and finds no project of another organization", async () => {
    const outsider = (
      await new AuthService(deps, { sessionTtlSeconds: 3600 }).register({
        email: "outsider@example.com",
        name: "outsider",
        password: "password-123456",
      })
    ).id;
    const {
      organization: { id: otherOrg },
    } = await new OrganizationService(deps).createOrganization(outsider, { name: "Other" });
    expect((await refusal(outsider)).code).toBe("FORBIDDEN");
    const elsewhere = await service()
      .link(outsider, otherOrg, PROJECT)
      .then(() => null, (thrown: unknown) => thrown);
    expect(elsewhere).toBeInstanceOf(AppError);
    expect((elsewhere as AppError).code).toBe("NOT_FOUND");
    expect(reads).toBe(0);
    expect(signed).toEqual([]);
    expect(audits()).toEqual([]);
  });

  it("refuses a video whose Units contradict its delivery, as its progress does", async () => {
    for (const contradiction of [
      delivered({ reservationState: "RELEASED" }),
      delivered({ jobState: "GENERATING", deliveredVersionId: null }),
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

  it("still gives a link to a video whose Property was deleted", async () => {
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
