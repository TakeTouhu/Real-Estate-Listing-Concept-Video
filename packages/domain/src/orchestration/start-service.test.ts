import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { AppError } from "@app/shared";
import { authorizedRoutes } from "../authorization/routing";
import type { GenerationReservationAllocation } from "../entitlement/ports";
import type { OrganizationSubscription } from "../entitlement/subscription";
import { AuthService } from "../identity/auth-service";
import { OrganizationService } from "../identity/organization-service";
import { PermissionGrantService } from "../identity/permission-grant-service";
import type { Role } from "../identity/roles";
import type { Property } from "../property/types";
import type { StoryboardView } from "../storyboard/storyboard-service";
import type { StoryboardScene, VideoProject } from "../storyboard/types";
import { createTestDeps, type TestDeps } from "../testing/in-memory";
import { InMemoryUnitPurchases } from "../testing/in-memory-unit-purchases";
import { InMemoryUnitsReader } from "../testing/in-memory-units";
import type { GenerationJob, GenerationReservation } from "./ports";
import type {
  GenerationStartOutcome,
  GenerationStartRecord,
  GenerationStartRepository,
  GenerationStartSummary,
} from "./start";
import {
  AUTHORIZED_ROUTE_QUALITY_OFFER,
  routeQualityOffer,
  GenerationStartService,
  type StartGenerationInput,
  type StartQualityOffer,
} from "./start-service";

/**
 * The start service (GS-4c, ADR-0088): who may start, what is judged before
 * anything is reserved, and the record the start commit (ADR-0087) receives.
 * The commit itself is a recording stand-in here; its database tests prove it.
 */

const iso = (value: string) => new Date(value);
/** Renewal period 1 of a subscription anchored on 15 March: 15 April to 15 May. */
const NOW = iso("2026-04-20T09:00:00.000Z");
const PROJECT = "vpr_start";
const PROPERTY = "prp_start";
const KEY = "start-key-1";
/** The start screen's confirmation of the default storyboard at HQ. */
const HQ_CONFIRMED = { qualityTier: "HIGH_QUALITY", storyboardSceneIds: ["scn_1", "scn_2"] } as const;

let deps: TestDeps;
let reader: InMemoryUnitsReader;
let ledger: InMemoryUnitPurchases;
let orgId: string;
let ids: Record<Role | "outsider", string>;
let property: Property;
let view: StoryboardView;
let storyboardReads: [string, string, string][];
let starts: RecordingStarts;
let qualities: StartQualityOffer;

function project(overrides: Partial<VideoProject> = {}): VideoProject {
  return {
    id: PROJECT,
    organizationId: orgId,
    propertyId: PROPERTY,
    name: "Walkthrough",
    status: "STORYBOARD_READY",
    durationSeconds: 6,
    aspectRatio: "16:9",
    targetOutputResolution: "720p",
    stylePreset: null,
    cameraMotion: "SLOW_PAN_LEFT",
    prompt: null,
    negativePrompt: null,
    includeMusic: false,
    includeCaptions: false,
    brandTemplateId: null,
    compositionFingerprint: "sha256:composed",
    createdBy: ids.CREATOR,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function scene(id: string, position: number, overrides: Partial<StoryboardScene> = {}): StoryboardScene {
  return {
    id,
    videoProjectId: PROJECT,
    propertyId: PROPERTY,
    assetId: `ast_${position}`,
    position,
    roomType: "KITCHEN",
    durationSeconds: 3,
    cameraMotion: "SLOW_PAN_LEFT",
    compiledPrompt: `{"scene":${position}}`,
    sourceAnalysisRevision: 1,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function job(id: string, overrides: Partial<GenerationJob> = {}): GenerationJob {
  return {
    id,
    videoProjectId: PROJECT,
    organizationId: orgId,
    requestedByUserId: ids.OWNER,
    qualityTier: "NORMAL",
    targetOutputResolution: "720p",
    targetAspectRatio: "16:9",
    requestedDurationSeconds: 6,
    disclosureMode: "THROUGHOUT",
    requiredVideoUnits: 1,
    requiredHighQualityUnits: 0,
    state: "RESERVED",
    stateVersion: 3,
    currentDeliverableVersionId: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function reservation(record: GenerationStartRecord): GenerationReservation {
  return {
    id: record.reservationId,
    generationJobId: record.jobId,
    billingCycleKey: "2026-04-15T00:00:00.000Z",
    billingCycleStartedAt: iso("2026-04-15T00:00:00.000Z"),
    billingCycleEndsAt: iso("2026-05-15T00:00:00.000Z"),
    funding: "ALLOCATED",
    entitlementPeriodId: "uep_1",
    reservedTotalVideoUnits: 1,
    reservedHighQualityUnits: 0,
    state: "RESERVED",
    stateVersion: 1,
    reservedAt: record.startedAt,
    consumedAt: null,
    releasedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function allocation(record: GenerationStartRecord): GenerationReservationAllocation {
  return {
    id: "gra_1",
    reservationId: record.reservationId,
    organizationId: record.organizationId,
    entitlementPeriodId: "uep_1",
    ordinal: 1,
    sourceType: "ADD_ON_BLOCK",
    addOnBlockId: "uab_1",
    quality: "NORMAL",
    quantity: 1,
    createdAt: NOW,
  };
}

/** The start commit, recorded. It answers `STARTED` unless told otherwise. */
class RecordingStarts implements GenerationStartRepository {
  readonly records: GenerationStartRecord[] = [];
  readonly replayReads: [string, string, string][] = [];
  /** How many periods were open when each start reached the commit. */
  readonly periodsAtStart: number[] = [];
  replay: GenerationJob | null = null;
  answer: GenerationStartOutcome | null = null;

  findStarted(organizationId: string, videoProjectId: string, idempotencyKey: string) {
    this.replayReads.push([organizationId, videoProjectId, idempotencyKey]);
    return Promise.resolve(this.replay);
  }

  start(record: GenerationStartRecord): Promise<GenerationStartOutcome> {
    this.records.push(record);
    this.periodsAtStart.push(reader.periods.length);
    return Promise.resolve(
      this.answer ?? {
        kind: "STARTED",
        job: job(record.jobId),
        reservation: reservation(record),
        allocations: [allocation(record)],
        scenes: [],
        requests: [],
      },
    );
  }
}

function service(): GenerationStartService {
  return new GenerationStartService({
    identity: deps,
    properties: {
      findById: (organizationId, id) =>
        Promise.resolve(organizationId === property.organizationId && id === property.id ? property : null),
    },
    storyboard: {
      getStoryboard: (actorUserId, organizationId, videoProjectId) => {
        storyboardReads.push([actorUserId, organizationId, videoProjectId]);
        return Promise.resolve(view);
      },
    },
    qualities: { offers: (tier) => qualities.offers(tier) },
    subscriptions: reader,
    ledger,
    starts,
  });
}

function input(overrides: Partial<StartGenerationInput> = {}): StartGenerationInput {
  return {
    organizationId: orgId,
    videoProjectId: PROJECT,
    idempotencyKey: KEY,
    confirmed: { qualityTier: "NORMAL", storyboardSceneIds: ["scn_1", "scn_2"] },
    ...overrides,
  };
}

function subscribe(overrides: Partial<OrganizationSubscription> = {}): void {
  reader.subscriptions.set(orgId, {
    id: `sub_${orgId}`,
    organizationId: orgId,
    planKey: "standard",
    channel: "SALES_ASSISTED",
    anchorAt: iso("2026-03-15T00:00:00.000Z"),
    commercialReference: "VT-2026-001",
    createdAt: iso("2026-03-01T00:00:00.000Z"),
    ...overrides,
  });
}

/** The service's refusal, and that it wrote nothing: no commit, no period. */
async function refusedWith(code: string, start: StartGenerationInput = input(), actor = ids.OWNER) {
  const error = await service()
    .start(actor, start)
    .then(() => null, (thrown: unknown) => thrown);
  expect(error).toBeInstanceOf(AppError);
  expect((error as AppError).code).toBe(code);
  expect(starts.records).toEqual([]);
  expect(reader.periods).toEqual([]);
  return error as AppError;
}

/** The service's answer, having asked nothing of the commit and opened no period. */
async function answered(kind: string, start: StartGenerationInput = input()) {
  expect(await service().start(ids.OWNER, start)).toEqual({ kind });
  expect(starts.records).toEqual([]);
  expect(reader.periods).toEqual([]);
}

beforeEach(async () => {
  deps = createTestDeps();
  reader = new InMemoryUnitsReader();
  ledger = new InMemoryUnitPurchases(reader, deps);
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
  view = { project: project(), scenes: [scene("scn_1", 1), scene("scn_2", 2)], fresh: true };
  storyboardReads = [];
  starts = new RecordingStarts();
  qualities = AUTHORIZED_ROUTE_QUALITY_OFFER;
  subscribe();
});

describe("a start", () => {
  it("starts the confirmed storyboard at its project's quality, in Mode A, at the server clock", async () => {
    const outcome = await service().start(ids.OWNER, input());

    const [record] = starts.records;
    const GSCN = expect.stringMatching(/^gscn_/);
    const GREQ = expect.stringMatching(/^greq_/);
    expect(record).toMatchObject({
      organizationId: orgId,
      videoProjectId: PROJECT,
      idempotencyKey: KEY,
      requestedByUserId: ids.OWNER,
      qualityTier: "NORMAL",
      disclosureMode: "THROUGHOUT",
      startedAt: NOW,
      storyboard: {
        compositionFingerprint: "sha256:composed",
        scenes: [
          { storyboardSceneId: "scn_1", generationSceneId: GSCN, initialRequestId: GREQ },
          { storyboardSceneId: "scn_2", generationSceneId: GSCN, initialRequestId: GREQ },
        ],
      },
      context: {
        actorType: "USER",
        actorUserId: ids.OWNER,
        correlationId: expect.stringMatching(/^corr_/),
        causationId: null,
        reasonCode: null,
        metadata: {},
        eventType: "GENERATION_STARTED",
      },
    });
    expect(record!.jobId).toMatch(/^gjob_/);
    expect(record!.reservationId).toMatch(/^gres_/);
    const sceneIds = record!.storyboard.scenes.flatMap((s) => [s.generationSceneId, s.initialRequestId]);
    const written = [record!.jobId, record!.reservationId, ...sceneIds];
    expect(new Set(written).size).toBe(6);

    expect(outcome).toEqual({
      kind: "STARTED",
      job: job(record!.jobId),
      reservation: reservation(record!),
      allocations: [allocation(record!)],
    });
    // The storyboard was read for this member, organization and project, and
    // the period the commit reserves from was open before the commit ran.
    expect(storyboardReads).toEqual([[ids.OWNER, orgId, PROJECT]]);
    expect(starts.replayReads).toEqual([[orgId, PROJECT, KEY]]);
    expect(starts.periodsAtStart).toEqual([1]);
    expect(reader.periods.map((p) => [p.startsAt.toISOString(), p.endsAt.toISOString()])).toEqual([
      ["2026-04-15T00:00:00.000Z", "2026-05-15T00:00:00.000Z"],
    ]);
  });

  it("files an audit entry built from what the commit wrote, naming no prompt, provider or model", async () => {
    await service().start(ids.OWNER, input());
    const record = starts.records[0]!;
    const summary: GenerationStartSummary = {
      job: job("gjob_written", { requestedDurationSeconds: 6, requiredVideoUnits: 1 }),
      reservation: { ...reservation(record), id: "gres_written" },
      allocations: [allocation(record)],
      sceneCount: 2,
    };
    expect(record.audit(summary)).toEqual({
      organizationId: orgId,
      actorUserId: ids.OWNER,
      action: "generation.started",
      resourceType: "generation_job",
      resourceId: "gjob_written",
      metadata: {
        videoProjectId: PROJECT,
        reservationId: "gres_written",
        qualityTier: "NORMAL",
        durationSeconds: 6,
        requiredVideoUnits: 1,
        disclosureMode: "THROUGHOUT",
        sceneCount: 2,
        allocations: [{ sourceType: "ADD_ON_BLOCK", addOnBlockId: "uab_1", quality: "NORMAL", quantity: 1 }],
      },
    });
  });

  it("starts a 1080p project at HQ where a verified route offers it", async () => {
    view = { ...view, project: project({ targetOutputResolution: "1080p" }) };
    qualities = { offers: () => true };
    await service().start(ids.OWNER, input({ confirmed: HQ_CONFIRMED }));
    expect(starts.records.map((r) => r.qualityTier)).toEqual(["HIGH_QUALITY"]);
  });

  it("starts a ninety-second storyboard, the longest a video may be", async () => {
    view = { ...view, scenes: [scene("scn_1", 1, { durationSeconds: 45 }), scene("scn_2", 2, { durationSeconds: 45 })] };
    expect((await service().start(ids.OWNER, input())).kind).toBe("STARTED");
  });

  it("accepts a start key of 200 characters", async () => {
    const key = "k".repeat(200);
    await service().start(ids.OWNER, input({ idempotencyKey: key }));
    expect(starts.records.map((r) => r.idempotencyKey)).toEqual([key]);
  });
});

describe("who may start", () => {
  it("lets members with video.generate and unit.consume start a Property they reach", async () => {
    for (const role of ["ADMIN", "CREATOR"] as const) {
      property = { ...property, responsibleUserId: ids[role] };
      expect((await service().start(ids[role], input({ idempotencyKey: `key-${role}` }))).kind).toBe("STARTED");
    }
  });

  it("refuses a member without video.generate or unit.consume, and a non-member, before reading anything", async () => {
    for (const actor of [ids.VIEWER, ids.BILLING, ids.outsider]) {
      await refusedWith("FORBIDDEN", input(), actor);
    }
    expect(storyboardReads).toEqual([]);
    expect(starts.replayReads).toEqual([]);
  });

  it("refuses a member holding only one of video.generate and unit.consume", async () => {
    const grants = new PermissionGrantService(deps);
    await grants.grant(ids.OWNER, orgId, ids.VIEWER, "unit.consume");
    await grants.grant(ids.OWNER, orgId, ids.BILLING, "video.generate");
    await refusedWith("FORBIDDEN", input(), ids.VIEWER);
    await refusedWith("FORBIDDEN", input(), ids.BILLING);
    expect(storyboardReads).toEqual([]);
  });

  it("answers a Property out of the member's reach as a project that does not exist", async () => {
    property = { ...property, responsibleUserId: ids.OWNER };
    const error = await refusedWith("NOT_FOUND", input(), ids.CREATOR);
    expect(error.message).toBe("Video project not found");
    expect(starts.replayReads).toEqual([]);
  });

  it("answers a deleted Property's project as one that does not exist, even to a replay", async () => {
    property = { ...property, status: "DELETED" };
    starts.replay = job("gjob_earlier");
    const error = await refusedWith("NOT_FOUND");
    expect(error.message).toBe("Video project not found");
    expect(starts.replayReads).toEqual([]);
  });

  it("starts an archived Property's project, as every other path does", async () => {
    property = { ...property, status: "ARCHIVED" };
    expect((await service().start(ids.OWNER, input())).kind).toBe("STARTED");
  });

  it("refuses a start key the commit cannot hold, before anything else", async () => {
    for (const idempotencyKey of ["", "k".repeat(201)]) {
      await refusedWith("VALIDATION_FAILED", input({ idempotencyKey }), ids.outsider);
    }
    expect(storyboardReads).toEqual([]);
  });
});

describe("a replay", () => {
  it("answers with the job its key started, whatever the storyboard or quality are now", async () => {
    const earlier = job("gjob_earlier");
    starts.replay = earlier;
    const project1080p = project({ compositionFingerprint: null, targetOutputResolution: "1080p" });
    view = { project: project1080p, scenes: [], fresh: false };
    expect(await service().start(ids.OWNER, input())).toEqual({ kind: "ALREADY_STARTED", job: earlier });
    expect(starts.replayReads).toEqual([[orgId, PROJECT, KEY]]);
    expect(starts.records).toEqual([]);
    expect(reader.periods).toEqual([]);
  });

  it("answers with the job when the commit finds it, a replay that arrived meanwhile", async () => {
    const earlier = job("gjob_earlier");
    starts.answer = { kind: "EXISTING", job: earlier };
    expect(await service().start(ids.OWNER, input())).toEqual({ kind: "ALREADY_STARTED", job: earlier });
  });
});

describe("the storyboard", () => {
  it("refuses a project with no composed storyboard", async () => {
    view = { project: project({ compositionFingerprint: null }), scenes: [], fresh: false };
    expect((await refusedWith("VALIDATION_FAILED")).message).toBe("This project has no composed storyboard");
    view = { ...view, scenes: [scene("scn_1", 1), scene("scn_2", 2)] };
    expect((await refusedWith("VALIDATION_FAILED")).message).toBe("This project has no composed storyboard");
    view = { project: project(), scenes: [], fresh: true };
    expect((await refusedWith("VALIDATION_FAILED")).message).toBe("This project has no composed storyboard");
  });

  it("refuses a storyboard whose approved photos have changed since it was composed", async () => {
    view = { ...view, fresh: false };
    expect((await refusedWith("VALIDATION_FAILED")).message).toBe(
      "The approved photos have changed since this storyboard was composed; compose it again",
    );
  });

  it("answers a storyboard that is not the one the customer confirmed", async () => {
    for (const storyboardSceneIds of [["scn_2", "scn_1"], ["scn_1"], ["scn_1", "scn_2", "scn_3"], ["scn_1", "scn_9"]]) {
      await answered("STORYBOARD_CHANGED", input({ confirmed: { qualityTier: "NORMAL", storyboardSceneIds } }));
    }
  });

  it("refuses a scene composed before generation could use it", async () => {
    view = { ...view, scenes: [scene("scn_1", 1), scene("scn_2", 2, { compiledPrompt: null })] };
    expect((await refusedWith("VALIDATION_FAILED")).message).toBe(
      "A scene has no compiled prompt; compose the storyboard again before starting",
    );
    view = { ...view, scenes: [scene("scn_1", 1), scene("scn_2", 2, { cameraMotion: "spin wildly" })] };
    await refusedWith("VALIDATION_FAILED");
  });

  it("answers a storyboard longer than a video may be", async () => {
    view = { ...view, scenes: [scene("scn_1", 1, { durationSeconds: 45 }), scene("scn_2", 2, { durationSeconds: 46 })] };
    await answered("LENGTH_NOT_SUPPORTED");
  });
});

describe("the quality", () => {
  it("answers a quality the project's resolution no longer gives", async () => {
    await answered("QUALITY_CHANGED", input({ confirmed: HQ_CONFIRMED }));
  });

  it("answers HQ as not offered while no verified route serves it", async () => {
    view = { ...view, project: project({ targetOutputResolution: "1080p" }) };
    await answered("QUALITY_NOT_OFFERED", input({ confirmed: HQ_CONFIRMED }));
  });

  it("offers today the qualities the route table authorizes: Normal only", () => {
    expect(AUTHORIZED_ROUTE_QUALITY_OFFER.offers("NORMAL")).toBe(true);
    expect(AUTHORIZED_ROUTE_QUALITY_OFFER.offers("HIGH_QUALITY")).toBe(false);
  });

  it("offers the qualities a route policy serves, as the gate authorizes them (ADR-0089)", () => {
    const hq = authorizedRoutes().map((route) => ({ ...route, qualityTier: "HIGH_QUALITY" as const }));
    const offer = routeQualityOffer({ version: "itest-policy.1", qualityTiers: ["HIGH_QUALITY"], routes: hq });
    expect(offer.offers("HIGH_QUALITY")).toBe(true);
    expect(offer.offers("NORMAL")).toBe(false);
    // Listed with no route: the gate would refuse every attempt, so not offered.
    const listedOnly = routeQualityOffer({ version: "itest-policy.1", qualityTiers: ["HIGH_QUALITY"], routes: [] });
    expect(listedOnly.offers("HIGH_QUALITY")).toBe(false);
  });
});

describe("the Unit period", () => {
  it("answers an organization with no plan, or one whose plan has not started", async () => {
    reader.subscriptions.clear();
    await answered("NO_PLAN");
    subscribe({ anchorAt: iso("2026-05-01T00:00:00.000Z") });
    await answered("NO_PLAN");
  });

  it("surfaces a period the plan did not open, rather than starting around it", async () => {
    reader.periods.push({
      id: "uep_by_hand",
      organizationId: orgId,
      planKey: "standard",
      billingCycleKey: "by-hand",
      baseUnits: 15,
      includedHighQualityUnits: 1,
      highQualityAddOnAvailable: false,
      startsAt: iso("2026-04-01T00:00:00.000Z"),
      endsAt: iso("2026-05-01T00:00:00.000Z"),
      commercialReference: null,
      createdAt: iso("2026-04-01T00:00:00.000Z"),
    });
    const error = await service()
      .start(ids.OWNER, input())
      .then(() => null, (thrown: unknown) => thrown);
    expect((error as AppError).code).toBe("INTERNAL_ERROR");
    expect(starts.records).toEqual([]);
  });
});

describe("the commit's answer", () => {
  it("passes on each refusal the start screen shows", async () => {
    const cases: [GenerationStartOutcome, unknown][] = [
      [{ kind: "STORYBOARD_CHANGED" }, { kind: "STORYBOARD_CHANGED" }],
      [{ kind: "QUALITY_CHANGED" }, { kind: "QUALITY_CHANGED" }],
      [{ kind: "DURATION_NOT_SUPPORTED" }, { kind: "LENGTH_NOT_SUPPORTED" }],
      [{ kind: "INSUFFICIENT_ENTITLEMENT", eligibleUnits: 2 }, { kind: "INSUFFICIENT_UNITS", eligibleUnits: 2 }],
    ];
    for (const [answer, expected] of cases) {
      starts.answer = answer;
      expect(await service().start(ids.OWNER, input())).toEqual(expected);
    }
  });

  it("answers a project the commit no longer finds, or whose Property it finds deleted, as not found", async () => {
    for (const kind of ["PROJECT_NOT_FOUND", "PROPERTY_DELETED"] as const) {
      starts.answer = { kind };
      const error = await service()
        .start(ids.OWNER, input())
        .then(() => null, (thrown: unknown) => thrown);
      expect((error as AppError).code).toBe("NOT_FOUND");
      expect((error as AppError).message).toBe("Video project not found");
    }
  });

  it("treats a refusal of what this service settled, Mode A or the period, as a defect", async () => {
    for (const kind of ["DISCLOSURE_MODE_NOT_SUPPORTED", "NO_ENTITLEMENT_PERIOD"] as const) {
      starts.answer = { kind };
      const error = await service()
        .start(ids.OWNER, input())
        .then(() => null, (thrown: unknown) => thrown);
      expect((error as AppError).code).toBe("INTERNAL_ERROR");
    }
  });
});

describe("dormancy", () => {
  const REPO_ROOT = join(__dirname, "..", "..", "..", "..");

  function productionSources(dir: string): { name: string; text: string }[] {
    const found: { name: string; text: string }[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".next") continue;
        found.push(...productionSources(full));
      } else if (/\.tsx?$/.test(entry.name) && !entry.name.includes(".test.")) {
        // Comments stripped, so prose naming the constructor is not mistaken for a call.
        const text = readFileSync(full, "utf8").replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
        found.push({ name: full.slice(REPO_ROOT.length + 1), text });
      }
    }
    return found;
  }

  it("is constructed by nothing outside tests until the start route (GS-10)", () => {
    const sources = [...productionSources(join(REPO_ROOT, "apps")), ...productionSources(join(REPO_ROOT, "packages"))];
    const constructors = sources
      .filter(({ text }) => text.includes("new GenerationStartService("))
      .map(({ name }) => name);
    expect(constructors).toEqual([]);
  });
});
