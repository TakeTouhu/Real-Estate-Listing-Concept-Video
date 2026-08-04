import type { StoryboardView, VideoProject } from "@app/domain";
import { AppError } from "@app/shared";
import { describe, expect, it, vi } from "vitest";
import { resolveStoryboardForProperty } from "./storyboard-route";

const PROPERTY = "prp_1";

function view(propertyId: string): StoryboardView {
  return {
    project: { id: "vpr_1", propertyId, name: "Walkthrough" } as VideoProject,
    scenes: [],
    fresh: false,
  };
}

describe("resolveStoryboardForProperty", () => {
  it("returns the storyboard when the project belongs to the URL property", async () => {
    const resolved = await resolveStoryboardForProperty(
      () => Promise.resolve(view(PROPERTY)),
      PROPERTY,
    );
    expect(resolved?.project.id).toBe("vpr_1");
  });

  it("rejects a project from another property in the same organization", async () => {
    // The service is organization-scoped, so this is a *valid* result — it just
    // does not belong on this URL, and rendering it would mix one property's
    // header and assets with another's storyboard.
    const resolved = await resolveStoryboardForProperty(
      () => Promise.resolve(view("prp_other")),
      PROPERTY,
    );
    expect(resolved).toBeNull();
  });

  it("turns a genuine NOT_FOUND into the not-found result rather than an error", async () => {
    const resolved = await resolveStoryboardForProperty(
      () => Promise.reject(new AppError("NOT_FOUND", "Video project not found")),
      PROPERTY,
    );
    expect(resolved).toBeNull();
  });

  it("makes a mismatch indistinguishable from a missing project", async () => {
    const missing = await resolveStoryboardForProperty(
      () => Promise.reject(new AppError("NOT_FOUND", "Video project not found")),
      PROPERTY,
    );
    const foreign = await resolveStoryboardForProperty(
      () => Promise.resolve(view("prp_other")),
      PROPERTY,
    );
    // Same outcome, so the page can never reveal that the project exists under
    // some other property.
    expect(foreign).toBe(missing);
  });

  it.each([
    ["an authorization refusal", new AppError("FORBIDDEN", "Not permitted")],
    ["a validation failure", new AppError("VALIDATION_FAILED", "Two approved in one group")],
    ["an unauthenticated caller", new AppError("UNAUTHENTICATED", "Sign in required")],
    ["a repository failure", new Error("connection terminated unexpectedly")],
  ])("propagates %s instead of reporting not found", async (_label, error) => {
    await expect(
      resolveStoryboardForProperty(() => Promise.reject(error), PROPERTY),
    ).rejects.toBe(error);
  });

  it("does not call the loader more than once", async () => {
    const load = vi.fn(() => Promise.resolve(view(PROPERTY)));
    await resolveStoryboardForProperty(load, PROPERTY);
    expect(load).toHaveBeenCalledTimes(1);
  });
});
