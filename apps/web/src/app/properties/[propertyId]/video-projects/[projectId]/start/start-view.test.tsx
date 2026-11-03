// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { StartOffer } from "@app/domain";
import { readGenerationStartForm } from "@/lib/generation-start-form";
import { StartView, refusal } from "./start-view";

/**
 * The start page's body (GS-10d, ADR-0112): what it says for every offer, and
 * that its one form is the start the route reads (ADR-0111 Decision 3).
 */
const ORG = "org_Az09_-";
const PROPERTY = "prp_1";
const PROJECT = "vpr_1";
const KEY = "4f9c2a1e-7b3d-4c5e-9a8f-0123456789ab";

afterEach(cleanup);

const READY: Extract<StartOffer, { kind: "READY" }> = {
  kind: "READY",
  qualityTier: "HIGH_QUALITY",
  scenes: [
    { id: "scn_b", durationSeconds: 5 },
    { id: "scn_a", durationSeconds: 4 },
    { id: "scn_c", durationSeconds: 6 },
  ],
  durationSeconds: 15,
  requiredUnits: 2,
  funding: { baseUnits: 1, addOnUnits: 1 },
};

const LABELS = new Map([
  ["scn_a", "Kitchen"],
  ["scn_b", "Living room"],
  ["scn_c", "Bedroom"],
]);

function show(offer: StartOffer | null, error: string | null = null, roomLabels = LABELS) {
  return render(
    <StartView
      organizationId={ORG}
      propertyId={PROPERTY}
      projectId={PROJECT}
      offer={offer}
      roomLabels={roomLabels}
      idempotencyKey={KEY}
      error={error}
    />,
  );
}

const text = (element: Element) => (element.textContent ?? "").replace(/\s+/g, " ");

describe("an offer that can be started", () => {
  it("shows the quality, the scenes in the offer's order, the length and the Units it would reserve", () => {
    const { container } = show(READY);
    const body = text(container);

    expect(body).toContain("Quality: HQ. 3 scenes, 15 seconds in all");
    expect([...container.querySelectorAll("li")].map(text)).toEqual([
      "Living room · 5 seconds",
      "Kitchen · 4 seconds",
      "Bedroom · 6 seconds",
    ]);
    expect(body).toContain(
      "Starting now would reserve 2 HQ Units: 1 of your plan's Base Units and 1 additional HQ Unit. The start " +
        "reserves them when you confirm, so the split can differ, or the Units fall short, if Units are reserved, " +
        "released or bought meanwhile.",
    );
    expect(body).toContain(
      "The Units are used only if the video is delivered. If no video is delivered, they come back.",
    );
    expect(body).toContain("carries a notice that it was made with generative AI");
    expect(body).toContain("not captured footage and makes no claim about dimensions");
    expect(screen.getByRole("button").textContent).toBe("Start the video and reserve 2 HQ Units");
  });

  it("posts the one form the start route reads, carrying exactly the offer", () => {
    const { container } = show(READY);
    const forms = container.querySelectorAll("form");
    expect(forms).toHaveLength(1);
    const form = forms[0]!;
    expect(form.getAttribute("method")).toBe("post");
    expect(form.getAttribute("action")).toBe(`/api/video-projects/${PROJECT}/generations`);
    // Nothing the customer types: every field is the offer's.
    expect(form.querySelectorAll("input:not([type=hidden]), select, textarea")).toHaveLength(0);

    const sent = new FormData(form);
    expect(sent.get("propertyId")).toBe(PROPERTY);
    expect(readGenerationStartForm(PROJECT, sent)).toEqual({
      organizationId: ORG,
      videoProjectId: PROJECT,
      idempotencyKey: KEY,
      confirmed: { qualityTier: "HIGH_QUALITY", storyboardSceneIds: ["scn_b", "scn_a", "scn_c"] },
    });
  });

  it("names only the Units' sources that give some", () => {
    const { container } = show({ ...READY, requiredUnits: 3, funding: { baseUnits: 3, addOnUnits: 0 } });
    expect(text(container)).toContain("Starting now would reserve 3 HQ Units: 3 of your plan's Base Units. The start");
    cleanup();
    const both = show({ ...READY, requiredUnits: 5, funding: { baseUnits: 2, addOnUnits: 3 } }).container;
    expect(text(both)).toContain("reserve 5 HQ Units: 2 of your plan's Base Units and 3 additional HQ Units. The");
  });

  it("names a Normal video's Units by their quality, and a scene whose room it does not know plainly", () => {
    const { container } = show(
      { ...READY, qualityTier: "NORMAL", requiredUnits: 1, funding: { baseUnits: 0, addOnUnits: 1 } },
      null,
      new Map([["scn_b", "Living room"]]),
    );
    expect(text(container)).toContain("Starting now would reserve 1 Normal Unit: 1 additional Normal Unit. The start");
    expect(screen.getByRole("button").textContent).toBe("Start the video and reserve 1 Normal Unit");
    expect([...container.querySelectorAll("li")].map(text)).toEqual([
      "Living room · 5 seconds",
      "Scene · 4 seconds",
      "Scene · 6 seconds",
    ]);
    const sent = new FormData(container.querySelector("form")!);
    expect(readGenerationStartForm(PROJECT, sent)?.confirmed.qualityTier).toBe("NORMAL");
  });

  it("shows why the last start started nothing above a fresh offer", () => {
    const { container } = show(READY, "The storyboard changed after you reviewed it. Nothing was started.");
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toBe("The storyboard changed after you reviewed it. Nothing was started.");
    expect(container.firstElementChild).toBe(alert);
    expect(container.querySelectorAll("form")).toHaveLength(1);
  });

  it("names no provider, model, job or storage in its markup", () => {
    const { container } = show(READY);
    for (const internal of ["wavespeed", "fake", "model", "provider", "job", "storageKey", "prediction"]) {
      expect(container.innerHTML.toLowerCase()).not.toContain(internal.toLowerCase());
    }
  });
});

describe("an offer that cannot be started", () => {
  it.each<[string, Exclude<StartOffer, { kind: "READY" }>, string]>([
    [
      "a video in progress",
      { kind: "VIDEO_EXISTS", jobId: "job_1", delivered: false },
      "This project's video is in progress, or its Units have not come back yet. A project has one video at a " +
        "time, and is started again only once its video has ended without being delivered and its Units have " +
        "come back.",
    ],
    [
      "a delivered video",
      { kind: "VIDEO_EXISTS", jobId: "job_1", delivered: true },
      "This project's video has been delivered. A project has one video at a time, and is started again only " +
        "once its video has ended without being delivered and its Units have come back.",
    ],
    [
      "no storyboard",
      { kind: "NOT_COMPOSED" },
      "This project has no storyboard yet. Compose one on the project page, then review the video here.",
    ],
    [
      "a stale storyboard",
      { kind: "STALE" },
      "The approved photos have changed since the storyboard was composed. Compose it again on the project page, " +
        "then review the video here.",
    ],
    [
      "a storyboard to compose again",
      { kind: "RECOMPOSE" },
      "This storyboard must be composed again before a video can be made from it. Compose it on the project page.",
    ],
    [
      "a quality not offered",
      { kind: "QUALITY_NOT_OFFERED", qualityTier: "HIGH_QUALITY" },
      "HQ videos cannot be made yet.",
    ],
    [
      "a storyboard too long",
      { kind: "LENGTH_NOT_SUPPORTED", durationSeconds: 95 },
      "The storyboard is 95 seconds long, longer than a video VTaVision makes.",
    ],
    [
      "no plan",
      { kind: "NO_PLAN" },
      "This organization has no plan yet, or its plan has not started yet. Videos can be started once it has.",
    ],
    [
      "too few Units",
      { kind: "INSUFFICIENT_UNITS", qualityTier: "NORMAL", requiredUnits: 3, eligibleUnits: 1 },
      "This video needs 3 Normal Units, and the Units it may use cover 1. Ask a member who manages billing " +
        "about additional Normal Units.",
    ],
  ])("says why for %s, and offers no form", (_case, offer, message) => {
    expect(refusal(offer)).toBe(message);
    const { container } = show(offer);
    expect(text(container)).toBe(message);
    expect(container.querySelectorAll("form, input, button")).toHaveLength(0);
    // The job is the start's own, and never shown.
    expect(container.innerHTML).not.toContain("job_1");
  });

  it("tells a member who may not start videos so, with no form", () => {
    const { container } = show(null, "You cannot start videos for this project. Nothing new was started.");
    expect(screen.getByRole("alert").textContent).toBe(
      "You cannot start videos for this project. Nothing new was started.",
    );
    expect(text(container)).toContain("You cannot start videos for this project.");
    expect(container.querySelectorAll("form, input, button")).toHaveLength(0);
  });
});
