// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import type { VideoProgress } from "@app/domain";
import { AppError } from "@app/shared";

/**
 * What the project page reads of its video (GS-11b, ADR-0114): the project's
 * newest video, as the signed-in member, in the organization whose storyboard
 * it shows, after that storyboard; shown wherever the page is.
 */
const state = vi.hoisted(() => ({
  reads: [] as string[],
  /** The organizations the member belongs to, and the Properties each reaches. */
  organizations: [] as { id: string; properties: string[] }[],
  /** What the progress read answers, or throws. */
  progress: null as unknown,
  /** What the link service answers, or throws. */
  link: null as unknown,
  /** What the page reported as an error. */
  errors: [] as [string, unknown][],
}));

vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Error(`redirect ${path}`);
  },
  useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock("@/lib/auth", () => ({ getCurrentUser: () => Promise.resolve({ user: { id: "usr_1" } }) }));
vi.mock("@/lib/generation-start", () => ({ getGenerationStartService: () => null }));
vi.mock("@/lib/identity", () => ({
  getIdentityServices: () => ({
    organizations: {
      listForUser: () =>
        Promise.resolve(
          state.organizations.map(({ id }) => ({
            organization: { id, name: `Studio ${id}` },
            role: "VIEWER",
            permissions: ["video.view"],
          })),
        ),
    },
  }),
}));
vi.mock("@/lib/property", () => ({
  getPropertyServices: () => ({
    properties: {
      get: (_actor: string, organizationId: string, propertyId: string) =>
        state.organizations.find((o) => o.id === organizationId)?.properties.includes(propertyId)
          ? Promise.resolve({ id: propertyId, name: "Kanda House" })
          : Promise.reject(new AppError("NOT_FOUND", "Property not found")),
    },
    assets: { list: () => Promise.resolve([]) },
  }),
}));
vi.mock("@/lib/analysis", () => ({ getAnalysisService: () => ({ listForProperty: () => Promise.resolve([]) }) }));
vi.mock("@/lib/thumbnails", () => ({ thumbnailUrls: () => Promise.resolve(new Map()) }));
vi.mock("@/lib/storyboard", async (actual) => ({
  ...(await actual<typeof import("@/lib/storyboard")>()),
  getStoryboardService: () => ({
    getStoryboard: (_actor: string, organizationId: string, projectId: string) => {
      state.reads.push(`storyboard ${organizationId} ${projectId}`);
      return organizationId === "org_2"
        ? Promise.resolve({ project: project(projectId), scenes: [], fresh: false })
        : Promise.reject(new AppError("NOT_FOUND", "Video project not found"));
    },
  }),
}));
vi.mock("@/lib/video-progress", async (actual) => ({
  ...(await actual<typeof import("@/lib/video-progress")>()),
  getVideoProgressService: () => ({
    progress: (actor: string, organizationId: string, projectId: string) => {
      state.reads.push(`progress ${actor} ${organizationId} ${projectId}`);
      return state.progress instanceof Error ? Promise.reject(state.progress) : Promise.resolve(state.progress);
    },
  }),
  getVideoProgressLogger: () => ({
    error: (message: string, fields?: unknown) => void state.errors.push([message, fields]),
  }),
}));
vi.mock("@/lib/video-preview", async (actual) => ({
  ...(await actual<typeof import("@/lib/video-preview")>()),
  getVideoPreviewService: () => ({
    link: (actor: string, organizationId: string, projectId: string) => {
      state.reads.push(`link ${actor} ${organizationId} ${projectId}`);
      return state.link instanceof Error ? Promise.reject(state.link) : Promise.resolve(state.link);
    },
  }),
}));

function project(id: string) {
  return {
    id,
    organizationId: "org_2",
    propertyId: "prp_1",
    name: "Spring tour",
    status: "DRAFT",
    durationSeconds: 30,
    aspectRatio: "16:9",
    targetOutputResolution: "1080p",
    stylePreset: null,
    cameraMotion: null,
    prompt: null,
    negativePrompt: null,
    includeMusic: false,
    includeCaptions: false,
    brandTemplateId: null,
    compositionFingerprint: null,
    createdBy: "usr_1",
    createdAt: new Date("2026-11-01T00:00:00.000Z"),
    updatedAt: new Date("2026-11-01T00:00:00.000Z"),
  };
}

const { default: StoryboardPage } = await import("./page");

const FAILED: VideoProgress = {
  phase: "FAILED",
  qualityTier: "HIGH_QUALITY",
  durationSeconds: 45,
  units: { count: 2, state: "RELEASED" },
  scenes: { ready: 1, total: 3 },
  supportReference: "gjob_1",
};

beforeEach(() => {
  state.reads = [];
  // The project is the second organization's: the first reaches the Property
  // but has no such project.
  state.organizations = [
    { id: "org_1", properties: ["prp_1"] },
    { id: "org_2", properties: ["prp_1"] },
  ];
  state.progress = FAILED;
  state.link = null;
  state.errors = [];
});

afterEach(cleanup);

async function page(): Promise<string> {
  const element = (await StoryboardPage({
    params: Promise.resolve({ propertyId: "prp_1", projectId: "vpr_1" }),
    searchParams: Promise.resolve({}),
  })) as ReactElement;
  return (render(element).container.textContent ?? "").replace(/\s+/g, " ");
}

describe("the project page's video", () => {
  it("reads the project's video as the member, in the organization whose storyboard it shows", async () => {
    const text = await page();
    expect(state.reads).toEqual(["storyboard org_1 vpr_1", "storyboard org_2 vpr_1", "progress usr_1 org_2 vpr_1"]);
    expect(text).toContain("Video");
    expect(text).toContain("動画を正常に生成できませんでした。");
    expect(text).toContain("Support reference: gjob_1");
    expect(state.errors).toEqual([]);
  });

  it("shows nothing about a video for a project that has none", async () => {
    state.progress = null;
    expect(await page()).not.toContain("Support reference");
  });

  it("shows a video the read will not describe as unreadable, with its reference, and reports it", async () => {
    state.progress = new AppError("INTERNAL_ERROR", "This video's progress could not be read", {
      details: { jobId: "gjob_9" },
    });
    const text = await page();
    expect(text).toContain("This video's progress could not be read.");
    expect(text).toContain("Support reference: gjob_9");
    expect(state.errors).toEqual([
      [
        "A video's Units contradict whether it was delivered",
        { jobId: "gjob_9", organizationId: "org_2", videoProjectId: "vpr_1" },
      ],
    ]);
  });

  it("lets any other failure of the read through", async () => {
    state.progress = new TypeError("bug");
    await expect(page()).rejects.toThrow("bug");
  });
});

describe("the project page's player (ADR-0117)", () => {
  const COMPLETED: VideoProgress = { ...FAILED, phase: "COMPLETED", units: { count: 2, state: "CONSUMED" } };
  const LINK = {
    url: "https://app.test/api/storage/download?token=t",
    expiresAt: new Date("2026-11-04T09:05:00.000Z"),
  };

  async function player(): Promise<HTMLVideoElement | null> {
    await page();
    return document.querySelector("video");
  }

  it("plays a completed video from a link asked for as the member, after its progress", async () => {
    state.progress = COMPLETED;
    state.link = LINK;
    expect((await player())?.getAttribute("src")).toBe(LINK.url);
    expect(state.reads.slice(-2)).toEqual(["progress usr_1 org_2 vpr_1", "link usr_1 org_2 vpr_1"]);
  });

  it("asks for no link, and shows no player, for a video that is not completed", async () => {
    expect(await player()).toBeNull();
    state.progress = new AppError("INTERNAL_ERROR", "This video's progress could not be read", {
      details: { jobId: "gjob_9" },
    });
    expect(await player()).toBeNull();
    expect(state.reads.filter((read) => read.startsWith("link"))).toEqual([]);
  });

  it("shows no player when the link service gives none, and lets its failures through", async () => {
    state.progress = COMPLETED;
    expect(await player()).toBeNull();
    state.link = new Error("store down");
    await expect(page()).rejects.toThrow("store down");
  });
});
