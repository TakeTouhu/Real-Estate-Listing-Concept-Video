import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@app/shared";

/**
 * The download route (GS-12c-3, ADR-0120): what it reads from the project
 * page's form, what it asks the download service, and where each answer sends
 * the member. The service is a recording double: who may download, and that
 * each link is recorded, are proved in its own suites (ADR-0119).
 */
const SITE = "https://app.vtavision.test";
const PROJECT = "vpr_route_1";
const PROPERTY = "prp_route_1";
const ORG = "org_route_1";
const USER = "usr_route_1";

const currentUser = vi.hoisted(() => ({ value: null as { user: { id: string } } | null, reads: 0 }));
const downloading = vi.hoisted(() => ({ value: null as unknown }));

vi.mock("@/lib/auth", () => ({
  getCurrentUser: () => {
    currentUser.reads += 1;
    return Promise.resolve(currentUser.value);
  },
}));
vi.mock("@/lib/video-download", async (actual) => ({
  ...(await actual<typeof import("@/lib/video-download")>()),
  getVideoDownloadService: () => downloading.value,
}));

const { POST } = await import("@/app/api/video-projects/[projectId]/download/route");

const LINK = "/api/storage/download?token=signed.token";

/** The download service, answering what a test sets and recording what it was asked. */
let asked: [string, string, string][];
let answer: () => Promise<{ url: string; expiresAt: Date } | null>;

beforeEach(() => {
  currentUser.value = { user: { id: USER } };
  currentUser.reads = 0;
  asked = [];
  answer = () => Promise.resolve({ url: LINK, expiresAt: new Date("2026-11-06T09:05:00.000Z") });
  downloading.value = {
    link: (actor: string, organizationId: string, videoProjectId: string) => {
      asked.push([actor, organizationId, videoProjectId]);
      return answer();
    },
  };
});

/** What the project page's form sends. */
function fields(): Record<string, string | readonly string[]> {
  return { organizationId: ORG, propertyId: PROPERTY };
}

function post(
  sent: Record<string, string | readonly string[]> = fields(),
  headers: Record<string, string> = { origin: SITE },
  contentType = "application/x-www-form-urlencoded",
  projectId = PROJECT,
) {
  const body = new URLSearchParams();
  for (const [name, value] of Object.entries(sent)) for (const one of [value].flat()) body.append(name, one);
  const request = new Request(`${SITE}/api/video-projects/${PROJECT}/download`, {
    method: "POST",
    headers: { host: "app.vtavision.test", "content-type": contentType, ...headers },
    body: contentType === "application/json" ? JSON.stringify(sent) : body.toString(),
  });
  return POST(request, { params: Promise.resolve({ projectId }) });
}

/** Where a 303 sends the member. */
function location(response: Response): URL {
  expect(response.status).toBe(303);
  const url = new URL(response.headers.get("location") ?? "");
  expect(url.origin).toBe(SITE);
  return url;
}

const PROJECT_PAGE = `/properties/${PROPERTY}/video-projects/${PROJECT}`;

async function errorCode(response: Response): Promise<string> {
  const body = (await response.json()) as { error?: { code?: string } };
  return body.error?.code ?? "";
}

describe("downloading a delivered video", () => {
  it("asks for a link as the signed-in member and sends the browser to it, kept by nothing", async () => {
    const response = await post();
    const url = location(response);
    expect(url.pathname + url.search).toBe(LINK);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(asked).toEqual([[USER, ORG, PROJECT]]);
  });

  it("goes to a link the store gives whole, wherever it points", async () => {
    answer = () => Promise.resolve({ url: `${SITE}/files/video.mp4?sig=1`, expiresAt: new Date() });
    expect(location(await post()).href).toBe(`${SITE}/files/video.mp4?sig=1`);
  });

  it.each([
    ["there is no delivered video", () => Promise.resolve(null), "none"],
    ["the member may not download it", () => Promise.reject(new AppError("FORBIDDEN", "No")), "forbidden"],
    ["the project is out of reach", () => Promise.reject(new AppError("NOT_FOUND", "No")), "forbidden"],
    ["the link could not be made", () => Promise.reject(new AppError("INTERNAL_ERROR", "No")), "failed"],
  ] as const)("sends the member back to the project page with a notice when %s", async (_what, refusal, notice) => {
    answer = refusal;
    const url = location(await post());
    expect(url.pathname).toBe(PROJECT_PAGE);
    expect([...url.searchParams]).toEqual([["download", notice]]);
  });

  it("does not turn an unexpected failure into a notice", async () => {
    answer = () => Promise.reject(new TypeError("bug"));
    await expect(post()).rejects.toThrow("bug");
  });
});

describe("what the route refuses before asking for a link", () => {
  it.each([
    ["no origin", {}],
    ["another site", { origin: "https://evil.example.net" }],
    ["another origin of the same site", { origin: "https://files.vtavision.test" }],
  ])("refuses a post from %s before reading anything", async (_what, headers) => {
    const response = await post(fields(), headers);
    expect(response.status).toBe(403);
    expect(currentUser.reads).toBe(0);
    expect(asked).toEqual([]);
  });

  it("sends a signed-out visitor to sign in, asking for nothing", async () => {
    currentUser.value = null;
    expect(location(await post()).pathname).toBe("/login");
    expect(asked).toEqual([]);
  });

  it("refuses a body that is not a form", async () => {
    const response = await post(fields(), { origin: SITE }, "application/json");
    expect(response.status).toBe(422);
    expect(await errorCode(response)).toBe("VALIDATION_FAILED");
    expect(asked).toEqual([]);
  });

  it.each([
    ["no organization", { organizationId: [] }],
    ["an organization id too long to be one", { organizationId: "o".repeat(65) }],
    ["an organization id with a space", { organizationId: "org 1" }],
    ["no Property", { propertyId: [] }],
    ["an empty Property id", { propertyId: "" }],
    ["a Property id that is a path", { propertyId: "../a?b" }],
    ["a Property id of dots", { propertyId: ".." }],
  ])("refuses a form with %s", async (_what, change) => {
    const response = await post({ ...fields(), ...change });
    expect(response.status).toBe(422);
    expect(await errorCode(response)).toBe("VALIDATION_FAILED");
    expect(asked).toEqual([]);
  });

  it.each([["a path", "../x?y"], ["dots", ".."], ["too long to be one", "v".repeat(65)]])(
    "refuses a project id that is %s, which says nowhere to land",
    async (_what, projectId) => {
      const response = await post(fields(), { origin: SITE }, "application/x-www-form-urlencoded", projectId);
      expect(response.status).toBe(422);
      expect(asked).toEqual([]);
    },
  );
});
