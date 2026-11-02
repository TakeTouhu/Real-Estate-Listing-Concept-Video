import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { AppError } from "@app/shared";
import { authorizedRoutes } from "../authorization/routing";
import type { PeriodEntitlementBalance } from "../entitlement/allocation";
import type { GenerationReservationAllocation } from "../entitlement/ports";
import { renewEntitlementPeriod, type OrganizationSubscription } from "../entitlement/subscription";
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
  type StartOffer,
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

/** The offer, having asked nothing of the commit and opened no period. */
async function offered(actor = ids.OWNER): Promise<StartOffer> {
  const periods = reader.periods.length;
  const offer = await service().offer(actor, orgId, PROJECT);
  expect(starts.records).toEqual([]);
  expect(starts.replayReads).toEqual([]);
  expect(reader.periods).toHaveLength(periods);
  return offer;
}

async function offerRefusedWith(code: string, actor = ids.OWNER): Promise<AppError> {
  const periods = reader.periods.length;
  const error = await service()
    .offer(actor, orgId, PROJECT)
    .then(() => null, (thrown: unknown) => thrown);
  expect(error).toBeInstanceOf(AppError);
  expect((error as AppError).code).toBe(code);
  expect(starts.records).toEqual([]);
  expect(reader.periods).toHaveLength(periods);
  return error as AppError;
}

/** Open April's period as the start would, and set what remains of it. */
async function openApril(balance: PeriodEntitlementBalance): Promise<void> {
  const opened = await renewEntitlementPeriod({ subscriptions: reader, ledger }, orgId, NOW);
  if (opened.kind !== "OPENED") throw new Error(`expected OPENED, got ${opened.kind}`);
  reader.balances.set(opened.period.id, balance);
}

function block(id: string, quality: "NORMAL" | "HIGH_QUALITY", remainingUnits: number, purchasedAt: string) {
  return { id, quality, remainingUnits, purchasedAtEpochMs: iso(purchasedAt).getTime(), withdrawn: false };
}

/** A storyboard of `seconds` in two scenes, of a 1080p project where `hq`. */
function storyboardOf(seconds: number, hq = false): void {
  const first = Math.floor(seconds / 2);
  view = {
    project: project({ targetOutputResolution: hq ? "1080p" : "720p" }),
    scenes: [scene("scn_1", 1, { durationSeconds: first }), scene("scn_2", 2, { durationSeconds: seconds - first })],
    fresh: true,
  };
}

describe("the start offer", () => {
  it("offers the storyboard at its project's quality, with its scenes, length and Units, writing nothing", async () => {
    expect(await offered()).toEqual({
      kind: "READY",
      qualityTier: "NORMAL",
      scenes: [
        { id: "scn_1", durationSeconds: 3 },
        { id: "scn_2", durationSeconds: 3 },
      ],
      durationSeconds: 6,
      requiredUnits: 1,
      funding: { baseUnits: 1, addOnUnits: 0 },
    });
    expect(storyboardReads).toEqual([[ids.OWNER, orgId, PROJECT]]);
  });

  it("offers what the start then accepts: the scenes and quality the customer confirms", async () => {
    const offer = await offered();
    if (offer.kind !== "READY") throw new Error(`expected READY, got ${offer.kind}`);
    const confirmed = { qualityTier: offer.qualityTier, storyboardSceneIds: offer.scenes.map((s) => s.id) };
    expect((await service().start(ids.OWNER, input({ confirmed }))).kind).toBe("STARTED");
  });

  // Which add-on blocks fund a video, by quality and age, is planUnitAllocation's and pinned by its own tests;
  // the short-Units test below shows a block of the other quality is not counted.
  it("forecasts Base Units first, within the HQ ceiling, then add-on Units", async () => {
    qualities = { offers: () => true };
    await openApril({
      baseRemainingUnits: 10,
      includedHighQualityRemainingUnits: 1,
      blocks: [
        block("uab_normal", "NORMAL", 5, "2026-04-15T01:00:00.000Z"),
        block("uab_hq_newer", "HIGH_QUALITY", 4, "2026-04-18T00:00:00.000Z"),
        block("uab_hq_older", "HIGH_QUALITY", 1, "2026-04-16T00:00:00.000Z"),
      ],
    });
    storyboardOf(90, true);
    expect(await offered()).toMatchObject({
      kind: "READY",
      qualityTier: "HIGH_QUALITY",
      requiredUnits: 3,
      funding: { baseUnits: 1, addOnUnits: 2 },
    });
    reader.balances.set(reader.periods[0]!.id, {
      baseRemainingUnits: 2,
      includedHighQualityRemainingUnits: 1,
      blocks: [block("uab_normal", "NORMAL", 5, "2026-04-15T01:00:00.000Z")],
    });
    storyboardOf(90);
    expect(await offered()).toMatchObject({ kind: "READY", funding: { baseUnits: 2, addOnUnits: 1 } });
  });

  it("answers short Units with how many the video's own quality could cover", async () => {
    qualities = { offers: () => true };
    await openApril({
      baseRemainingUnits: 10,
      includedHighQualityRemainingUnits: 1,
      blocks: [block("uab_normal", "NORMAL", 5, "2026-04-15T01:00:00.000Z")],
    });
    storyboardOf(90, true);
    expect(await offered()).toEqual({
      kind: "INSUFFICIENT_UNITS",
      qualityTier: "HIGH_QUALITY",
      requiredUnits: 3,
      eligibleUnits: 1,
    });
  });

  it("reads a period nobody has opened as opening it would hold it, and does not open it", async () => {
    qualities = { offers: () => true };
    // Standard: 15 Base Units, of which 1 may fund HQ.
    storyboardOf(90, true);
    expect(await offered()).toMatchObject({ kind: "INSUFFICIENT_UNITS", requiredUnits: 3, eligibleUnits: 1 });
    storyboardOf(90);
    expect(await offered()).toMatchObject({ kind: "READY", funding: { baseUnits: 3, addOnUnits: 0 } });
    // Premium: 40 Base Units, of which 5 may fund HQ.
    subscribe({ planKey: "premium" });
    storyboardOf(90, true);
    expect(await offered()).toMatchObject({ kind: "READY", funding: { baseUnits: 3, addOnUnits: 0 } });
    expect(reader.periods).toEqual([]);
  });

  it("answers an organization with no plan, or one whose plan has not started", async () => {
    reader.subscriptions.clear();
    expect(await offered()).toEqual({ kind: "NO_PLAN" });
    subscribe({ anchorAt: iso("2026-05-01T00:00:00.000Z") });
    expect(await offered()).toEqual({ kind: "NO_PLAN" });
  });

  it("surfaces a period the plan did not open, or one the ledger cannot read, as the start does", async () => {
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
    await offerRefusedWith("INTERNAL_ERROR");
    reader.periods.length = 0;
    await openApril({ baseRemainingUnits: 15, includedHighQualityRemainingUnits: 1, blocks: [] });
    reader.balance = () => Promise.resolve(null);
    await offerRefusedWith("INTERNAL_ERROR");
  });

  it("answers a storyboard not composed, stale, or holding a scene generation could not use", async () => {
    view = { project: project({ compositionFingerprint: null }), scenes: [scene("scn_1", 1)], fresh: true };
    expect(await offered()).toEqual({ kind: "NOT_COMPOSED" });
    view = { project: project(), scenes: [], fresh: true };
    expect(await offered()).toEqual({ kind: "NOT_COMPOSED" });
    view = { project: project(), scenes: [scene("scn_1", 1), scene("scn_2", 2)], fresh: false };
    expect(await offered()).toEqual({ kind: "STALE" });
    view = { ...view, fresh: true, scenes: [scene("scn_1", 1), scene("scn_2", 2, { compiledPrompt: null })] };
    expect(await offered()).toEqual({ kind: "RECOMPOSE" });
    view = { ...view, scenes: [scene("scn_1", 1, { cameraMotion: "spin wildly" }), scene("scn_2", 2)] };
    expect(await offered()).toEqual({ kind: "RECOMPOSE" });
    view = { ...view, scenes: [scene("scn_1", 1, { cameraMotion: null }), scene("scn_2", 2)] };
    expect((await offered()).kind).toBe("READY");
  });

  it("answers HQ as not offered while no verified route serves it", async () => {
    storyboardOf(6, true);
    expect(await offered()).toEqual({ kind: "QUALITY_NOT_OFFERED", qualityTier: "HIGH_QUALITY" });
  });

  it("answers a storyboard longer than a video may be with its length, and offers ninety seconds", async () => {
    storyboardOf(91);
    expect(await offered()).toEqual({ kind: "LENGTH_NOT_SUPPORTED", durationSeconds: 91 });
    storyboardOf(90);
    expect(await offered()).toMatchObject({ kind: "READY", durationSeconds: 90, requiredUnits: 3 });
  });

  it("answers in the start's order, and as the start then answers", async () => {
    const hq = () => project({ targetOutputResolution: "1080p" });
    const unusable = (overrides: Partial<StoryboardScene> = {}) =>
      scene("scn_1", 1, { compiledPrompt: null, ...overrides });
    const cases: [string, () => void, StartOffer["kind"], string][] = [
      // A project never composed is read as not fresh too.
      [
        "never composed",
        () => (view = { project: project({ compositionFingerprint: null }), scenes: [], fresh: false }),
        "NOT_COMPOSED",
        "VALIDATION_FAILED",
      ],
      ["stale and HQ", () => (view = { ...view, project: hq(), fresh: false }), "STALE", "VALIDATION_FAILED"],
      [
        "HQ and unusable",
        () => (view = { ...view, project: hq(), scenes: [unusable(), scene("scn_2", 2)] }),
        "QUALITY_NOT_OFFERED",
        "QUALITY_NOT_OFFERED",
      ],
      [
        "unusable and long",
        () => (view = { ...view, scenes: [unusable({ durationSeconds: 91 }), scene("scn_2", 2)] }),
        "RECOMPOSE",
        "VALIDATION_FAILED",
      ],
      [
        "long and no plan",
        () => {
          storyboardOf(91);
          reader.subscriptions.clear();
        },
        "LENGTH_NOT_SUPPORTED",
        "LENGTH_NOT_SUPPORTED",
      ],
    ];
    for (const [name, arrange, offerKind, startAnswer] of cases) {
      view = { project: project(), scenes: [scene("scn_1", 1), scene("scn_2", 2)], fresh: true };
      starts = new RecordingStarts();
      subscribe();
      arrange();
      expect([name, (await offered()).kind]).toEqual([name, offerKind]);
      const confirmed = { qualityTier: qualityTierOf(view), storyboardSceneIds: view.scenes.map((s) => s.id) };
      const started = await service()
        .start(ids.OWNER, input({ confirmed }))
        .then((outcome) => outcome.kind, (thrown: unknown) => (thrown as AppError).code);
      expect([name, started]).toEqual([name, startAnswer]);
    }
  });

  it("is offered to the members the start lets start, and to no one else, before reading anything", async () => {
    for (const role of ["ADMIN", "CREATOR"] as const) {
      property = { ...property, responsibleUserId: ids[role] };
      expect((await offered(ids[role])).kind).toBe("READY");
    }
    storyboardReads = [];
    for (const actor of [ids.VIEWER, ids.BILLING, ids.outsider]) await offerRefusedWith("FORBIDDEN", actor);
    const grants = new PermissionGrantService(deps);
    await grants.grant(ids.OWNER, orgId, ids.VIEWER, "unit.consume");
    await grants.grant(ids.OWNER, orgId, ids.BILLING, "video.generate");
    for (const actor of [ids.VIEWER, ids.BILLING]) await offerRefusedWith("FORBIDDEN", actor);
    expect(storyboardReads).toEqual([]);
  });

  it("answers a Property out of reach, or deleted, as a missing project; offers an archived one", async () => {
    property = { ...property, responsibleUserId: ids.OWNER };
    expect((await offerRefusedWith("NOT_FOUND", ids.CREATOR)).message).toBe("Video project not found");
    property = { ...property, responsibleUserId: null, status: "DELETED" };
    expect((await offerRefusedWith("NOT_FOUND")).message).toBe("Video project not found");
    property = { ...property, status: "ARCHIVED" };
    expect((await offered()).kind).toBe("READY");
  });
});

function qualityTierOf(current: StoryboardView): "NORMAL" | "HIGH_QUALITY" {
  return current.project.targetOutputResolution === "1080p" ? "HIGH_QUALITY" : "NORMAL";
}

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
