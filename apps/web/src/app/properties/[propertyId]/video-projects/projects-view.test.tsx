// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { VideoProjectDto } from "@/lib/storyboard";
import { ProjectsView } from "./projects-view";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

const ORG = "org_1";
const PROPERTY = "prp_1";

afterEach(cleanup);

function project(overrides: Partial<VideoProjectDto> = {}): VideoProjectDto {
  return {
    id: "vpr_1",
    propertyId: PROPERTY,
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

function view(projects: VideoProjectDto[], canCreate = true) {
  return render(
    <ProjectsView
      organizationId={ORG}
      propertyId={PROPERTY}
      projects={projects}
      canCreate={canCreate}
      cameraMotionOptions={[{ value: "STATIC", label: "Static (no camera movement)" }]}
    />,
  );
}

describe("project list", () => {
  it("renders every project a property has, with no active or default one", () => {
    view([
      project({ id: "vpr_1", name: "Hero cut", durationSeconds: 30 }),
      project({ id: "vpr_2", name: "Social cut", durationSeconds: 15, aspectRatio: "9:16" }),
      project({ id: "vpr_3", name: "Long tour", durationSeconds: 90 }),
    ]);

    expect(screen.getByText("Video projects")).toBeTruthy();
    expect(screen.getByText("(3)")).toBeTruthy();
    for (const name of ["Hero cut", "Social cut", "Long tour"]) {
      expect(screen.getByText(name)).toBeTruthy();
    }
    // No project is singled out as the one in use.
    for (const singular of [/active/i, /default/i, /primary project/i, /current project/i]) {
      expect(screen.queryByText(singular)).toBeNull();
    }
  });

  it("renders a single project the same way it renders three", () => {
    view([project({ name: "Only one" })]);
    expect(screen.getByText("Only one")).toBeTruthy();
    expect(screen.getByText("(1)")).toBeTruthy();
    expect(screen.getByText("30 seconds")).toBeTruthy();
  });

  it("shows an empty state rather than implying a project exists", () => {
    view([]);
    expect(screen.getByText("No video projects yet.")).toBeTruthy();
    expect(screen.getByText("(0)")).toBeTruthy();
  });

  it("shows the settings a customer needs before composing", () => {
    view([
      project({
        durationSeconds: 45,
        aspectRatio: "9:16",
        resolution: "720p",
        cameraMotion: "SLOW_PAN",
        prompt: "bright and airy",
        negativePrompt: "no harsh shadows",
      }),
    ]);

    expect(screen.getByText("45 seconds")).toBeTruthy();
    expect(screen.getByText("9:16")).toBeTruthy();
    expect(screen.getByText("720p")).toBeTruthy();
    expect(screen.getByText("SLOW_PAN")).toBeTruthy();
    expect(screen.getByText("bright and airy")).toBeTruthy();
    expect(screen.getByText("no harsh shadows")).toBeTruthy();
  });

  it("labels each persisted status without inventing one", () => {
    view([
      project({ id: "vpr_1", name: "A", status: "DRAFT" }),
      project({ id: "vpr_2", name: "B", status: "STORYBOARD_READY" }),
      project({ id: "vpr_3", name: "C", status: "STORYBOARD_STALE" }),
    ]);

    expect(screen.getByText("· Draft")).toBeTruthy();
    expect(screen.getByText("· Storyboard ready")).toBeTruthy();
    expect(screen.getByText("· Storyboard stale")).toBeTruthy();
  });

  it("links each project to its own storyboard", () => {
    view([project({ id: "vpr_1", name: "Hero cut" }), project({ id: "vpr_2", name: "Social cut" })]);

    const hero = screen.getByRole("link", { name: "Hero cut" });
    const social = screen.getByRole("link", { name: "Social cut" });
    expect(hero.getAttribute("href")).toBe(`/properties/${PROPERTY}/video-projects/vpr_1`);
    expect(social.getAttribute("href")).toBe(`/properties/${PROPERTY}/video-projects/vpr_2`);
  });

  it("puts no internal field in the browser-facing markup", () => {
    const { container } = view([
      project({ prompt: "bright and airy", cameraMotion: "SLOW_PAN" }),
    ]);
    const markup = container.innerHTML;

    for (const internal of [
      ORG,
      "organizationId",
      "compositionFingerprint",
      "sha256",
      "compiledPrompt",
      "preservation",
      "negativeConstraints",
      "wavespeed",
      "storageKey",
      "createdBy",
    ]) {
      expect(markup).not.toContain(internal);
    }
  });
});

describe("authorization presentation", () => {
  it("gives a member with property:write the create controls", () => {
    view([], true);
    expect(screen.getByRole("button", { name: "Create project" })).toBeTruthy();
    expect(screen.getByLabelText("Project name")).toBeTruthy();
  });

  it("puts no create control in the markup for a member without property:write", () => {
    const { container } = view([project()], false);

    expect(screen.queryByRole("button", { name: "Create project" })).toBeNull();
    expect(screen.queryByLabelText("Project name")).toBeNull();
    // Not merely hidden or disabled — absent.
    expect(container.querySelectorAll("input")).toHaveLength(0);
    expect(container.querySelectorAll("button")).toHaveLength(0);
    expect(screen.getByText(/cannot create one/)).toBeTruthy();
    // The list itself is still readable.
    expect(screen.getByText("Walkthrough")).toBeTruthy();
  });
});
