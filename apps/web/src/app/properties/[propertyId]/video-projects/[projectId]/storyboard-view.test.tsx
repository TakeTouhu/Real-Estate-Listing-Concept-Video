// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { VideoProjectDto } from "@/lib/storyboard";
import { StoryboardView, type SceneRow } from "./storyboard-view";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

const ORG = "org_1";

afterEach(cleanup);

function project(overrides: Partial<VideoProjectDto> = {}): VideoProjectDto {
  return {
    id: "vpr_1",
    propertyId: "prp_1",
    name: "Walkthrough",
    status: "DRAFT",
    durationSeconds: 30,
    aspectRatio: "16:9",
    resolution: "1080p",
    cameraMotion: null,
    prompt: null,
    negativePrompt: null,
    createdAt: "2026-08-04T00:00:00.000Z",
    updatedAt: "2026-08-04T00:00:00.000Z",
    ...overrides,
  };
}

function scene(overrides: Partial<SceneRow> = {}): SceneRow {
  return {
    id: "scn_1",
    position: 1,
    roomLabel: "Living room",
    durationSeconds: 6,
    filename: "living.jpg",
    thumbnailUrl: null,
    ...overrides,
  };
}

const THREE_SCENES: SceneRow[] = [
  scene({ id: "scn_1", position: 1, roomLabel: "Entrance", filename: "a.jpg", durationSeconds: 4 }),
  scene({ id: "scn_2", position: 2, roomLabel: "Living room", filename: "b.jpg", durationSeconds: 6 }),
  scene({ id: "scn_3", position: 3, roomLabel: "Kitchen", filename: "c.jpg", durationSeconds: 8 }),
];

function view(
  overrides: {
    project?: VideoProjectDto;
    scenes?: SceneRow[];
    fresh?: boolean;
    approvedCount?: number;
    minimumScenes?: number;
    canCompose?: boolean;
  } = {},
) {
  return render(
    <StoryboardView
      organizationId={ORG}
      project={overrides.project ?? project()}
      scenes={overrides.scenes ?? []}
      fresh={overrides.fresh ?? false}
      approvedCount={overrides.approvedCount ?? 0}
      minimumScenes={overrides.minimumScenes ?? 3}
      canCompose={overrides.canCompose ?? true}
    />,
  );
}

const FRESH = /matches the photos currently approved/;
const STALE = /out of date and cannot be used until it is composed again/;
const NEVER = /No storyboard composed yet/;

describe("freshness", () => {
  it("reads as never composed when there are no scenes", () => {
    view({ scenes: [], fresh: false });
    expect(screen.getByText(NEVER)).toBeTruthy();
    expect(screen.queryByText(FRESH)).toBeNull();
    expect(screen.queryByText(STALE)).toBeNull();
    expect(screen.getByText("Nothing composed yet.")).toBeTruthy();
  });

  it("reads as current when scenes exist and the inputs have not moved", () => {
    view({ scenes: THREE_SCENES, fresh: true });
    expect(screen.getByText(FRESH)).toBeTruthy();
    expect(screen.queryByText(STALE)).toBeNull();
  });

  it("reads as stale when scenes exist and the inputs have moved", () => {
    view({ scenes: THREE_SCENES, fresh: false });
    expect(screen.getByText(STALE)).toBeTruthy();
    expect(screen.queryByText(FRESH)).toBeNull();
  });

  it("lets the stale warning win over a STORYBOARD_READY status", () => {
    // The persisted status is written at compose time and nothing updates it
    // when an approval later changes. Trusting it would present a stale
    // storyboard as generation-ready.
    view({
      project: project({ status: "STORYBOARD_READY" }),
      scenes: THREE_SCENES,
      fresh: false,
    });

    expect(screen.getByText(STALE)).toBeTruthy();
    expect(screen.queryByText(FRESH)).toBeNull();
    // The status is still shown as the persisted lifecycle field…
    expect(screen.getByText("Storyboard ready")).toBeTruthy();
    // …but it never becomes the freshness claim.
    expect(screen.getByText(STALE).className).toContain("status-bad");
  });

  it("offers recomposition rather than a first composition once scenes exist", () => {
    view({ scenes: THREE_SCENES, fresh: false });
    expect(screen.getByRole("button", { name: "Compose again" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Compose storyboard" })).toBeNull();
  });
});

describe("project settings", () => {
  it("shows the settings read-only, with no control to change them", () => {
    const { container } = view({
      project: project({
        durationSeconds: 45,
        aspectRatio: "9:16",
        resolution: "720p",
        cameraMotion: "SLOW_PAN",
        prompt: "bright and airy",
        negativePrompt: "no harsh shadows",
      }),
      canCompose: false,
    });

    expect(screen.getByText("Walkthrough")).toBeTruthy();
    expect(screen.getByText("45 seconds")).toBeTruthy();
    expect(screen.getByText("9:16")).toBeTruthy();
    expect(screen.getByText("720p")).toBeTruthy();
    expect(screen.getByText("SLOW_PAN")).toBeTruthy();
    expect(screen.getByText("bright and airy")).toBeTruthy();
    expect(screen.getByText("no harsh shadows")).toBeTruthy();
    // Read-only: with composition unavailable there is no input at all.
    expect(container.querySelectorAll("input")).toHaveLength(0);
  });

  it("states the approved count and the minimum without gating composition", () => {
    view({ approvedCount: 1, minimumScenes: 3, scenes: [], canCompose: true });

    expect(screen.getByText(/at least 3 approved photos/)).toBeTruthy();
    expect(screen.getByText(/this property has 1 approved photos/)).toBeTruthy();
    // The count is informational; the domain decides. The button is enabled or
    // disabled by the bounds alone, never by this number.
    expect(screen.getByRole("button", { name: "Compose storyboard" })).toBeTruthy();
  });

  it("uses the minimum it is given rather than a hardcoded one", () => {
    view({ minimumScenes: 5 });
    expect(screen.getByText(/at least 5 approved photos/)).toBeTruthy();
  });
});

describe("scenes", () => {
  it("renders every scene in order with its room, photo, and length", () => {
    const { container } = view({ scenes: THREE_SCENES, fresh: true });

    expect(screen.getByText("(3 scenes)")).toBeTruthy();
    const names = [...container.querySelectorAll(".scene-name")].map((n) => n.textContent);
    expect(names[0]).toContain("1. Entrance");
    expect(names[1]).toContain("2. Living room");
    expect(names[2]).toContain("3. Kitchen");
    expect(names[0]).toContain("a.jpg");
    expect(screen.getByText("4 seconds")).toBeTruthy();
    expect(screen.getByText("8 seconds")).toBeTruthy();
  });

  it("renders a thumbnail when one exists and nothing when it does not", () => {
    const { container } = view({
      scenes: [
        scene({ id: "scn_1", position: 1, thumbnailUrl: "https://signed.example/thumb?sig=abc" }),
        scene({ id: "scn_2", position: 2, thumbnailUrl: null }),
      ],
      fresh: true,
    });

    const images = container.querySelectorAll("img");
    expect(images).toHaveLength(1);
    expect(images[0]!.getAttribute("src")).toBe("https://signed.example/thumb?sig=abc");
    // Decorative: the filename is already in the text beside it.
    expect(images[0]!.getAttribute("alt")).toBe("");
  });

  it("does not claim the storyboard is a measured plan", () => {
    view({ scenes: THREE_SCENES, fresh: true });
    expect(screen.getByText(/not a measured floor plan/)).toBeTruthy();
  });
});

describe("authorization presentation", () => {
  it("gives a member with property:write the compose controls", () => {
    view({ canCompose: true });
    expect(screen.getByLabelText("Shortest scene, in seconds")).toBeTruthy();
    expect(screen.getByLabelText("Longest scene, in seconds")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Compose storyboard" })).toBeTruthy();
  });

  it("puts no compose control in the markup for a member without it", () => {
    const { container } = view({ scenes: THREE_SCENES, fresh: true, canCompose: false });

    expect(container.querySelectorAll("input")).toHaveLength(0);
    expect(container.querySelectorAll("button")).toHaveLength(0);
    expect(screen.getByText(/cannot compose it/)).toBeTruthy();
    // The storyboard itself stays readable.
    expect(screen.getByText("(3 scenes)")).toBeTruthy();
    expect(screen.getByText(FRESH)).toBeTruthy();
  });
});

describe("privacy", () => {
  it("puts no internal field in the browser-facing markup", () => {
    const { container } = view({
      project: project({ prompt: "bright and airy", cameraMotion: "SLOW_PAN" }),
      scenes: THREE_SCENES,
      fresh: true,
    });
    const markup = container.innerHTML;

    for (const internal of [
      ORG,
      "organizationId",
      "compositionFingerprint",
      "sha256",
      "compiledPrompt",
      "preservation",
      "negativeConstraints",
      "sourceAnalysisRevision",
      "assetId",
      "wavespeed",
      "storageKey",
      "thumbnailKey",
      "createdBy",
    ]) {
      expect(markup).not.toContain(internal);
    }
  });
});
