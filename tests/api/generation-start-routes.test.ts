import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  GenerationJob,
  GenerationReservation,
  StartGenerationInput,
  StartGenerationOutcome,
} from "@app/domain";
import { InMemoryRateLimitStore } from "@app/domain/testing";
import { AppError, RATE_LIMIT_DEFAULTS, type AppErrorCode, type RateLimitSetting } from "@app/shared";

/**
 * The start route (GS-10c, ADR-0111): what it reads from the start page's
 * form, what it hands the start service, and where each answer sends the
 * customer. The service is a recording double: what it decides is proved in
 * its own suites, and against PostgreSQL through the web composition in
 * `tests/integration/generation-start-route.db.test.ts`. The start limit runs
 * for real, on an in-memory store made afresh for each test (ADR-0173).
 */
const SITE = "https://app.vtavision.test";
const PROJECT = "vpr_route_1";
const PROPERTY = "prp_route_1";
const ORG = "org_route_1";
const USER = "usr_route_1";
const NOW = new Date("2026-04-20T09:00:00.000Z");

const currentUser = vi.hoisted(() => ({ value: null as { user: { id: string } } | null, reads: 0 }));
const starting = vi.hoisted(() => ({ value: null as unknown }));
const reported = vi.hoisted(() => ({ errors: [] as [string, unknown][] }));
const limits = vi.hoisted(() => ({ value: null as unknown, broken: null as Error | null }));

vi.mock("@/lib/auth", () => ({
  getCurrentUser: () => {
    currentUser.reads += 1;
    return Promise.resolve(currentUser.value);
  },
}));
vi.mock("@/lib/generation-start", async (actual) => ({
  ...(await actual<typeof import("@/lib/generation-start")>()),
  getGenerationStartService: () => starting.value,
  getGenerationStartLogger: () => ({
    error: (message: string, fields?: unknown) => void reported.errors.push([message, fields]),
  }),
}));
vi.mock("@/lib/identity", () => ({ getIdentityServices: () => ({ deps: { clock: { now: () => NOW } } }) }));
vi.mock("@/lib/rate-limit", async (original) => ({
  ...(await original<typeof import("@/lib/rate-limit")>()),
  getRateLimiter: () => {
    if (limits.broken) throw limits.broken;
    return limits.value;
  },
}));
const { WebRateLimits } = await import("@/lib/rate-limit");
let warned: [string, unknown][];
const limitsOf = (settings: Partial<Record<RateLimitSetting, string>>, store = new InMemoryRateLimitStore()) =>
  new WebRateLimits(store, { ...RATE_LIMIT_DEFAULTS, ...settings, SESSION_SECRET: "x".repeat(32) }, {
    warn: (message: string, fields?: unknown) => void warned.push([message, fields]),
  });

const { POST } = await import("@/app/api/video-projects/[projectId]/generations/route");

const JOB: GenerationJob = {
  id: "gjb_route_1",
  videoProjectId: PROJECT,
  organizationId: ORG,
  requestedByUserId: USER,
  qualityTier: "NORMAL",
  targetOutputResolution: "720p",
  targetAspectRatio: "16:9",
  requestedDurationSeconds: 15,
  disclosureMode: "THROUGHOUT",
  requiredVideoUnits: 1,
  requiredHighQualityUnits: 0,
  state: "RESERVED",
  stateVersion: 3,
  currentDeliverableVersionId: null,
  createdAt: NOW,
  updatedAt: NOW,
};

const RESERVATION: GenerationReservation = {
  id: "grs_route_1",
  generationJobId: JOB.id,
  billingCycleKey: "2026-04-15T00:00:00.000Z",
  billingCycleStartedAt: new Date("2026-04-15T00:00:00.000Z"),
  billingCycleEndsAt: new Date("2026-05-15T00:00:00.000Z"),
  funding: "ALLOCATED",
  entitlementPeriodId: "uep_route_1",
  reservedTotalVideoUnits: 1,
  reservedHighQualityUnits: 0,
  state: "RESERVED",
  stateVersion: 1,
  reservedAt: NOW,
  consumedAt: null,
  releasedAt: null,
  createdAt: NOW,
  updatedAt: NOW,
};

/** The start service, answering what a test sets and recording what it was asked. */
let starts: { actor: string; input: StartGenerationInput }[];
let answer: () => Promise<StartGenerationOutcome>;

beforeEach(() => {
  currentUser.value = { user: { id: USER } };
  currentUser.reads = 0;
  reported.errors = [];
  warned = [];
  limits.value = limitsOf({});
  limits.broken = null;
  starts = [];
  answer = () => Promise.resolve({ kind: "STARTED", job: JOB, reservation: RESERVATION, allocations: [] });
  starting.value = {
    start: (actor: string, input: StartGenerationInput) => {
      starts.push({ actor, input });
      return answer();
    },
  };
});

/** What the start page sends: the offer it showed, and a key made for it. */
function fields(): Record<string, string | readonly string[]> {
  return {
    organizationId: ORG,
    propertyId: PROPERTY,
    qualityTier: "NORMAL",
    idempotencyKey: "start-key-1",
    sceneId: ["sbs_3", "sbs_1", "sbs_2"],
  };
}

function post(
  sent: Record<string, string | readonly string[]> = fields(),
  headers: Record<string, string> = { origin: SITE },
  contentType = "application/x-www-form-urlencoded",
  projectId = PROJECT,
) {
  const body = new URLSearchParams();
  for (const [name, value] of Object.entries(sent)) for (const one of [value].flat()) body.append(name, one);
  const request = new Request(`${SITE}/api/video-projects/${PROJECT}/generations`, {
    method: "POST",
    headers: { host: "app.vtavision.test", "content-type": contentType, ...headers },
    // A string: the body is read by the Fetch API's own parser.
    body: contentType === "application/json" ? JSON.stringify(sent) : body.toString(),
  });
  return POST(request, { params: Promise.resolve({ projectId }) });
}

/** Where a 303 sends the customer, and what it carries. */
function landing(response: Response): { path: string; error: string | null; started: string | null } {
  expect(response.status).toBe(303);
  const url = new URL(response.headers.get("location") ?? "");
  expect(url.origin).toBe(SITE);
  return { path: url.pathname, error: url.searchParams.get("error"), started: url.searchParams.get("started") };
}

const PROJECT_PAGE = `/properties/${PROPERTY}/video-projects/${PROJECT}`;
const START_PAGE = `${PROJECT_PAGE}/start`;

async function errorCode(response: Response): Promise<string> {
  const body = (await response.json()) as { error?: { code?: string } };
  return body.error?.code ?? "";
}

describe("where the start is not built", () => {
  it("answers as a route that does not exist, before reading anything", async () => {
    starting.value = null;
    const response = await post(fields(), {});
    expect(response.status).toBe(404);
    expect(await errorCode(response)).toBe("NOT_FOUND");
    expect(currentUser.reads).toBe(0);
  });
});

describe("starting a video", () => {
  it("starts what the page showed, as the signed-in member, and sends the customer to the project", async () => {
    expect(landing(await post())).toEqual({ path: PROJECT_PAGE, error: null, started: "1" });
    expect(starts).toEqual([
      {
        actor: USER,
        input: {
          organizationId: ORG,
          videoProjectId: PROJECT,
          idempotencyKey: "start-key-1",
          confirmed: { qualityTier: "NORMAL", storyboardSceneIds: ["sbs_3", "sbs_1", "sbs_2"] },
        },
      },
    ]);
  });

  it("starts an HQ video at the longest key and ids the form takes", async () => {
    // The first and last visible ASCII characters, at the longest length.
    const key = "!~".repeat(100);
    const scene = "Az09_-".repeat(10).concat("sbs_");
    const sent = { ...fields(), qualityTier: "HIGH_QUALITY", idempotencyKey: key, sceneId: scene };
    expect(landing(await post(sent)).started).toBe("1");
    expect(starts[0]?.input.idempotencyKey).toBe(key);
    expect(starts[0]?.input.confirmed).toEqual({ qualityTier: "HIGH_QUALITY", storyboardSceneIds: [scene] });
  });

  it("lands a replay of the same confirmation where the start did", async () => {
    answer = () => Promise.resolve({ kind: "ALREADY_STARTED", job: JOB });
    expect(landing(await post())).toEqual({ path: PROJECT_PAGE, error: null, started: "1" });
  });

});

describe("a refused start", () => {
  it.each<[StartGenerationOutcome, string]>([
    [
      { kind: "VIDEO_EXISTS", job: JOB },
      "This project already has a video, in progress or delivered. Nothing new was started.",
    ],
    [
      { kind: "STORYBOARD_CHANGED" },
      "The storyboard changed after you reviewed it. Nothing was started. Review it again.",
    ],
    [
      { kind: "QUALITY_CHANGED" },
      "The project's quality changed after you reviewed it. Nothing was started. Review it again.",
    ],
    [{ kind: "QUALITY_NOT_OFFERED" }, "Videos of this project's quality cannot be made yet. Nothing was started."],
    [
      { kind: "SCENE_LENGTHS_NOT_SUPPORTED" },
      "Some scenes are a length this video cannot be made at. Nothing was started.",
    ],
    [
      { kind: "SETTINGS_NOT_SUPPORTED" },
      "This video cannot be made with this project's settings. Nothing was started.",
    ],
    [
      { kind: "LENGTH_NOT_SUPPORTED" },
      "The storyboard is longer than a video VTaVision makes. Nothing was started.",
    ],
    [{ kind: "NO_PLAN" }, "This organization has no plan yet, or its plan has not started. Nothing was started."],
    [
      { kind: "INSUFFICIENT_UNITS", eligibleUnits: 0 },
      "There are not enough Units for this video. Nothing was started.",
    ],
  ])("sends %o back to the start page, saying why", async (outcome, message) => {
    answer = () => Promise.resolve(outcome);
    expect(landing(await post())).toEqual({ path: START_PAGE, error: message, started: null });
  });

  it.each<[AppErrorCode, string]>([
    // Judged before the key is read, so a retry of a start that happened may get them.
    ["FORBIDDEN", "You cannot start videos for this project. Nothing new was started."],
    ["NOT_FOUND", "The video project was not found. Nothing new was started."],
    ["VALIDATION_FAILED", "This storyboard cannot be started as it is. Nothing was started. Review it again."],
    [
      "INTERNAL_ERROR",
      "The start could not be confirmed. Review it and try again: a video already started is not started twice.",
    ],
    [
      "CONFIGURATION_ERROR",
      "The start could not be confirmed. Review it and try again: a video already started is not started twice.",
    ],
  ])("sends a %s failure back to the start page, saying what happened", async (code, message) => {
    answer = () => Promise.reject(new AppError(code, "from the service"));
    expect(landing(await post())).toEqual({ path: START_PAGE, error: message, started: null });
  });

  it("does not turn an unexpected failure into a message", async () => {
    answer = () => Promise.reject(new TypeError("bug"));
    await expect(post()).rejects.toThrow("bug");
  });
});

describe("what the route refuses before the start", () => {
  it.each([
    ["no origin", {}],
    ["another site", { origin: "https://evil.example.net" }],
    ["another origin of the same site", { origin: "https://files.vtavision.test" }],
  ])("refuses a post from %s before reading anything", async (_what, headers) => {
    const response = await post(fields(), headers);
    expect(response.status).toBe(403);
    expect(currentUser.reads).toBe(0);
    expect(starts).toEqual([]);
  });

  it("sends a signed-out visitor to sign in, starting nothing", async () => {
    currentUser.value = null;
    expect(landing(await post()).path).toBe("/login");
    expect(starts).toEqual([]);
  });

  it("refuses a body that is not a form", async () => {
    const response = await post(fields(), { origin: SITE }, "application/json");
    expect(response.status).toBe(422);
    expect(await errorCode(response)).toBe("VALIDATION_FAILED");
    expect(starts).toEqual([]);
  });

  it.each([
    ["no Property", { propertyId: [] }],
    ["an empty Property id", { propertyId: "" }],
    ["a Property id too long to be one", { propertyId: "p".repeat(65) }],
    ["a Property id that is a path", { propertyId: "../a?b" }],
    ["a Property id of dots", { propertyId: ".." }],
    ["a Property id with a space", { propertyId: "prp 1" }],
  ])("refuses a form with %s, which says nowhere to land", async (_what, change) => {
    const response = await post({ ...fields(), ...change });
    expect(response.status).toBe(422);
    expect(await errorCode(response)).toBe("VALIDATION_FAILED");
    expect(starts).toEqual([]);
  });

  it.each([["a path", "../x?y"], ["dots", ".."], ["too long to be one", "v".repeat(65)]])(
    "refuses a project id that is %s, which says nowhere to land",
    async (_what, projectId) => {
      const response = await post(fields(), { origin: SITE }, "application/x-www-form-urlencoded", projectId);
      expect(response.status).toBe(422);
      expect(starts).toEqual([]);
    },
  );

  it.each([
    ["no organization", { organizationId: [] }],
    ["an organization id too long to be one", { organizationId: "o".repeat(65) }],
    ["no quality", { qualityTier: [] }],
    ["a quality the product does not sell", { qualityTier: "4K" }],
    ["no key", { idempotencyKey: [] }],
    ["an empty key", { idempotencyKey: "" }],
    ["a key longer than 200 characters", { idempotencyKey: "k".repeat(201) }],
    ["a key with a space", { idempotencyKey: "start key" }],
    ["a key with a control character", { idempotencyKey: "start\u0000key" }],
    ["a key outside ASCII", { idempotencyKey: "start-kéy" }],
    ["no scenes", { sceneId: [] }],
    ["an empty scene id", { sceneId: ["sbs_1", ""] }],
    ["a scene id too long to be one", { sceneId: ["sbs_1", "s".repeat(65)] }],
    ["a scene id that is a path", { sceneId: ["sbs_1", "../sbs_2"] }],
  ])("sends a form with %s back to the start page, starting nothing", async (_what, change) => {
    expect(landing(await post({ ...fields(), ...change }))).toEqual({
      path: START_PAGE,
      error: "The start request could not be read. Nothing was started. Review the video again.",
      started: null,
    });
    expect(starts).toEqual([]);
  });
});

describe("the start limit per account (ADR-0173)", () => {
  const limitedTo = (count: number) => (limits.value = limitsOf({ RATE_LIMIT_GENERATION_START: `${count}/3600` }));
  const REFUSED = "Too many video starts. Nothing new was started. Try again in 60 minutes.";

  it("refuses past the limit back to the start page with its wait, asking the start service nothing", async () => {
    limitedTo(2);
    expect(landing(await post()).started).toBe("1");
    // A start the service refuses is counted too.
    answer = () => Promise.resolve({ kind: "INSUFFICIENT_UNITS", eligibleUnits: 0 });
    expect(landing(await post()).path).toBe(START_PAGE);
    const refused = await post();
    expect(landing(refused)).toEqual({ path: START_PAGE, error: REFUSED, started: null });
    // A redirect back to a page: no Retry-After rides on it.
    expect(refused.headers.get("retry-after")).toBeNull();
    // No third start reached the service, so it reserved no Unit and wrote no job.
    expect(starts).toHaveLength(2);
    expect(reported.errors).toEqual([]);
    // Logged by its codes alone.
    expect(warned).toEqual([
      [
        "An attempt was refused by a rate limit",
        { code: "RATE_LIMITED", action: "GENERATION_START", dimension: "user" },
      ],
    ]);
  });

  it("rounds a wait that is not whole minutes up, never down", async () => {
    limits.value = limitsOf({ RATE_LIMIT_GENERATION_START: "1/90" });
    expect(landing(await post()).started).toBe("1");
    expect(landing(await post()).error).toBe("Too many video starts. Nothing new was started. Try again in 2 minutes.");
  });

  it("refuses as not confirmed when the limiter cannot be built, starting nothing", async () => {
    limits.broken = new AppError("INTERNAL_ERROR", "The limiter's settings are missing");
    expect(landing(await post())).toEqual({
      path: START_PAGE,
      error: "The start could not be confirmed. Review it and try again: a video already started is not started twice.",
      started: null,
    });
    expect(starts).toEqual([]);
    expect(reported.errors).toEqual([["A start could not be counted", { code: "INTERNAL_ERROR" }]]);
  });

  it("keeps a count per account: another member of the organization is not held", async () => {
    limitedTo(1);
    expect(landing(await post()).started).toBe("1");
    expect(landing(await post()).error).toBe(REFUSED);
    currentUser.value = { user: { id: "usr_route_2" } };
    expect(landing(await post()).started).toBe("1");
    expect(starts.map((start) => start.actor)).toEqual([USER, "usr_route_2"]);
  });

  it("counts only where the start is built, after the origin, the session and the form are checked", async () => {
    limitedTo(1);
    const service = starting.value;
    starting.value = null;
    expect((await post()).status).toBe(404);
    starting.value = service;
    expect((await post(fields(), { origin: "https://evil.example.net" })).status).toBe(403);
    expect((await post(fields(), { origin: SITE }, "application/json")).status).toBe(422);
    expect((await post({ ...fields(), propertyId: "../a" })).status).toBe(422);
    expect(landing(await post({ ...fields(), qualityTier: "4K" })).path).toBe(START_PAGE);
    currentUser.value = null;
    expect(landing(await post()).path).toBe("/login");
    currentUser.value = { user: { id: USER } };
    expect(landing(await post()).started).toBe("1");
    expect(starts).toHaveLength(1);
  });

  it.each([
    ["an application error", new AppError("INTERNAL_ERROR", "The rate-limit hit returned no row"), "INTERNAL_ERROR"],
    ["any other error", new TypeError("The rate-limit store is gone"), "UNEXPECTED"],
  ])("fails closed on %s with the page's own text, never the limiter's, starting nothing", async (_, failure, code) => {
    const broken = new InMemoryRateLimitStore();
    broken.hit = () => Promise.reject(failure);
    limits.value = limitsOf({}, broken);
    expect(landing(await post())).toEqual({
      path: START_PAGE,
      error: "The start could not be confirmed. Review it and try again: a video already started is not started twice.",
      started: null,
    });
    expect(starts).toEqual([]);
    expect(reported.errors).toEqual([["A start could not be counted", { code }]]);
  });
});
