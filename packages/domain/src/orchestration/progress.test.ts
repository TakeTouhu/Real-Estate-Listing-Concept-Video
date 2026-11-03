import { beforeEach, describe, expect, it } from "vitest";
import { AppError } from "@app/shared";
import { AuthService } from "../identity/auth-service";
import { GroupService } from "../identity/group-service";
import { OrganizationService } from "../identity/organization-service";
import type { Role } from "../identity/roles";
import type { Property } from "../property/types";
import type { VideoProject } from "../storyboard/types";
import { createTestDeps, type TestDeps } from "../testing/in-memory";
import {
  VideoProgressService,
  videoProgressOf,
  videoProgressPhaseOf,
  videoProgressUnitsOf,
  type VideoProgressRecord,
} from "./progress";
import { GENERATION_JOB_STATES, GENERATION_RESERVATION_STATES } from "./types";

/**
 * A project's video as its customer sees it (GS-11a, ADR-0113): the phase each
 * job state is shown as, what each reservation state says of the Units, and
 * who may read it. The read itself is a recording stand-in here; its database
 * tests prove it.
 */

const NOW = new Date("2026-04-20T09:00:00.000Z");
const PROJECT = "vpr_progress";
const PROPERTY = "prp_progress";

function record(overrides: Partial<VideoProgressRecord> = {}): VideoProgressRecord {
  return {
    jobId: "gjob_1",
    jobState: "GENERATING",
    delivered: false,
    qualityTier: "HIGH_QUALITY",
    durationSeconds: 45,
    requiredUnits: 2,
    reservationState: "RESERVED",
    sceneCount: 3,
    scenesReady: 1,
    ...overrides,
  };
}

describe("the phase a job is shown in", () => {
  it("gives every job state a phase, in UXFlow's words", () => {
    const phases = GENERATION_JOB_STATES.map((state) => [state, videoProgressPhaseOf(state, false)]);
    expect(Object.fromEntries(phases)).toEqual({
      CREATED: "QUEUED",
      RESERVING: "QUEUED",
      RESERVED: "QUEUED",
      GENERATING: "GENERATING_SCENES",
      SCENES_READY: "COMPOSING",
      COMPOSITION_PENDING: "COMPOSING",
      COMPOSING: "COMPOSING",
      DELIVERABLE_VALIDATING: "VALIDATING",
      DELIVERABLE_READY: "COMPLETED",
      REVISING: "COMPLETED",
      FAILED_TERMINAL: "FAILED",
      CANCELLED: "CANCELLED",
    });
  });

  it("shows a delivered video as completed while a new version of it is made", () => {
    const phases = GENERATION_JOB_STATES.map((state) => [state, videoProgressPhaseOf(state, true)]);
    expect(Object.fromEntries(phases)).toEqual({
      CREATED: "COMPLETED",
      RESERVING: "COMPLETED",
      RESERVED: "COMPLETED",
      GENERATING: "COMPLETED",
      SCENES_READY: "COMPLETED",
      COMPOSITION_PENDING: "COMPLETED",
      COMPOSING: "COMPLETED",
      DELIVERABLE_VALIDATING: "COMPLETED",
      DELIVERABLE_READY: "COMPLETED",
      REVISING: "COMPLETED",
      FAILED_TERMINAL: "FAILED",
      CANCELLED: "CANCELLED",
    });
  });

  it("says what each reservation state means for the Units, and that none was reserved", () => {
    const states = [...GENERATION_RESERVATION_STATES, null];
    expect(states.map((state) => [state, videoProgressUnitsOf(state)])).toEqual([
      ["RESERVING", "RESERVED"],
      ["RESERVED", "RESERVED"],
      ["RECONCILIATION_HOLD", "RESERVED"],
      ["CONSUMED", "CONSUMED"],
      ["RELEASED", "RELEASED"],
      [null, "NONE"],
    ]);
  });
});

describe("a video's progress", () => {
  it("carries the video's quality, length, Units and scenes, and its id as the support reference", () => {
    expect(videoProgressOf(record())).toEqual({
      phase: "GENERATING_SCENES",
      qualityTier: "HIGH_QUALITY",
      durationSeconds: 45,
      units: { count: 2, state: "RESERVED" },
      scenes: { ready: 1, total: 3 },
      supportReference: "gjob_1",
    });
  });

  it("carries a Normal video's quality as Normal", () => {
    expect(videoProgressOf(record({ qualityTier: "NORMAL" })).qualityTier).toBe("NORMAL");
  });

  it("describes a video that ended without one whose Units are back, held, or were never reserved", () => {
    for (const jobState of ["FAILED_TERMINAL", "CANCELLED"] as const) {
      for (const [reservationState, units] of [
        ["RELEASED", "RELEASED"],
        ["RECONCILIATION_HOLD", "RESERVED"],
        [null, "NONE"],
      ] as const) {
        expect(videoProgressOf(record({ jobState, reservationState })).units).toEqual({ count: 2, state: units });
      }
    }
  });

  it("describes a delivered video that used its Units, or never reserved any", () => {
    for (const [reservationState, units] of [
      ["CONSUMED", "CONSUMED"],
      [null, "NONE"],
    ] as const) {
      const progress = videoProgressOf(record({ jobState: "DELIVERABLE_READY", delivered: true, reservationState }));
      expect(progress).toMatchObject({ phase: "COMPLETED", units: { count: 2, state: units } });
    }
  });

  it("describes a video in progress whose Units came back before it ended", () => {
    // A submission given up on releases its Units before the job is ended (ADR-0037 Decision 6).
    expect(videoProgressOf(record({ reservationState: "RELEASED" }))).toMatchObject({
      phase: "GENERATING_SCENES",
      units: { count: 2, state: "RELEASED" },
    });
  });

  it("refuses to describe a video whose Units contradict whether it was delivered", () => {
    for (const contradiction of [
      { jobState: "FAILED_TERMINAL", reservationState: "CONSUMED" },
      { jobState: "CANCELLED", reservationState: "CONSUMED" },
      { jobState: "DELIVERABLE_READY", delivered: true, reservationState: "RESERVED" },
      { jobState: "DELIVERABLE_READY", delivered: true, reservationState: "RELEASED" },
      { jobState: "GENERATING", delivered: true, reservationState: "RECONCILIATION_HOLD" },
    ] as const) {
      const error = (() => {
        try {
          videoProgressOf(record({ jobId: "gjob_9", ...contradiction }));
          return null;
        } catch (thrown) {
          return thrown;
        }
      })();
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe("INTERNAL_ERROR");
      // Words that claim nothing about the video's Units.
      expect((error as AppError).message).toBe("This video's progress could not be read");
      expect((error as AppError).details).toEqual({ jobId: "gjob_9" });
    }
  });
});

describe("who may read it", () => {
  let deps: TestDeps;
  let orgId: string;
  let ids: Record<Role | "outsider", string>;
  let property: Property;
  let projects: Map<string, VideoProject>;
  let reads: [string, string][];
  let latest: VideoProgressRecord | null;

  function service(): VideoProgressService {
    return new VideoProgressService({
      identity: deps,
      properties: {
        findById: (organizationId, id) =>
          Promise.resolve(organizationId === property.organizationId && id === property.id ? property : null),
      },
      projects: {
        findById: (organizationId, id) => {
          const found = projects.get(id);
          return Promise.resolve(found !== undefined && found.organizationId === organizationId ? found : null);
        },
      },
      progress: {
        findLatest: (organizationId, videoProjectId) => {
          reads.push([organizationId, videoProjectId]);
          return Promise.resolve(latest);
        },
      },
    });
  }

  async function refusedWith(code: string, actor: string, projectId = PROJECT, organizationId = orgId) {
    const error = await service()
      .progress(actor, organizationId, projectId)
      .then(() => null, (thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe(code);
    // Nothing about the video is read for a member refused.
    expect(reads).toEqual([]);
    return error as AppError;
  }

  beforeEach(async () => {
    deps = createTestDeps();
    const auth = new AuthService(deps, { sessionTtlSeconds: 3600 });
    const register = async (name: string) =>
      (await auth.register({ email: `${name}@example.com`, name, password: "password-123456" })).id;
    const owner = await register("owner");
    ({ organization: { id: orgId } } = await new OrganizationService(deps).createOrganization(owner, { name: "Org" }));
    ids = {
      OWNER: owner,
      ADMIN: await register("admin"),
      MANAGER: await register("manager"),
      CREATOR: await register("creator"),
      VIEWER: await register("viewer"),
      BILLING: await register("billing"),
      outsider: await register("outsider"),
    };
    for (const role of ["ADMIN", "MANAGER", "CREATOR", "VIEWER", "BILLING"] as const) {
      await deps.repos.memberships.create({ organizationId: orgId, userId: ids[role], role });
    }
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
    projects = new Map([
      [
        PROJECT,
        {
          id: PROJECT,
          organizationId: orgId,
          propertyId: PROPERTY,
          name: "Walkthrough",
          status: "STORYBOARD_READY",
          durationSeconds: 15,
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
        },
      ],
    ]);
    reads = [];
    latest = record();
  });

  it("answers a member holding video.view with the project's newest video, read for this project only", async () => {
    for (const actor of [ids.OWNER, ids.ADMIN, ids.VIEWER]) {
      property = { ...property, responsibleUserId: ids.VIEWER };
      expect(await service().progress(actor, orgId, PROJECT)).toEqual(videoProgressOf(record()));
    }
    expect(reads).toEqual([
      [orgId, PROJECT],
      [orgId, PROJECT],
      [orgId, PROJECT],
    ]);
  });

  it("answers null for a project whose video was never started", async () => {
    latest = null;
    expect(await service().progress(ids.OWNER, orgId, PROJECT)).toBeNull();
    expect(reads).toEqual([[orgId, PROJECT]]);
  });

  it("refuses a member without video.view, and anyone outside the organization", async () => {
    await refusedWith("FORBIDDEN", ids.BILLING);
    await refusedWith("FORBIDDEN", ids.outsider);
  });

  it("answers a project out of reach, or another organization's, as one that does not exist", async () => {
    // A CREATOR reaches only the Properties it is responsible for.
    expect((await refusedWith("NOT_FOUND", ids.CREATOR)).message).toBe("Video project not found");
    expect((await refusedWith("NOT_FOUND", ids.OWNER, "vpr_missing")).message).toBe("Video project not found");
    projects.set("vpr_other", { ...projects.get(PROJECT)!, id: "vpr_other", organizationId: "org_other" });
    await refusedWith("NOT_FOUND", ids.OWNER, "vpr_other");
  });

  it("reads a project in a CREATOR's reach", async () => {
    property = { ...property, responsibleUserId: ids.CREATOR };
    expect((await service().progress(ids.CREATOR, orgId, PROJECT))?.phase).toBe("GENERATING_SCENES");
  });

  it("reads a project in a MANAGER's group, and refuses one whose Property is in no group of its", async () => {
    const groups = new GroupService(deps);
    const mine = await groups.create(ids.OWNER, orgId, "North");
    const other = await groups.create(ids.OWNER, orgId, "South");
    await groups.addMember(ids.OWNER, orgId, mine.id, ids.MANAGER);
    property = { ...property, groupId: other.id };
    await refusedWith("NOT_FOUND", ids.MANAGER);
    property = { ...property, groupId: mine.id };
    expect((await service().progress(ids.MANAGER, orgId, PROJECT))?.phase).toBe("GENERATING_SCENES");
  });

  it("still reads a project whose Property was deleted, as its other reads do", async () => {
    property = { ...property, status: "DELETED" };
    expect(await service().progress(ids.OWNER, orgId, PROJECT)).toEqual(videoProgressOf(record()));
  });

  it("surfaces a video that ended without one but used its Units", async () => {
    latest = record({ jobState: "FAILED_TERMINAL", reservationState: "CONSUMED" });
    const error = await service()
      .progress(ids.OWNER, orgId, PROJECT)
      .then(() => null, (thrown: unknown) => thrown);
    expect((error as AppError).code).toBe("INTERNAL_ERROR");
  });
});
