// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import type { StartOffer } from "@app/domain";
import { AppError } from "@app/shared";

/**
 * Where the start page reads from (GS-10d, ADR-0112): nothing where the start
 * is not built; the start's own offer, as the signed-in member, for the
 * Property and project in the URL; a fresh key every time it is shown.
 */
const state = vi.hoisted(() => ({
  built: true,
  signedIn: true as boolean,
  reads: [] as string[],
  /** The organizations the member belongs to, and the Properties each reaches. */
  organizations: [] as { id: string; name: string; properties: string[] }[],
  /** The offer each organization answers, or what it throws. */
  offers: new Map<string, StartOffer | Error>(),
  /** The Property the storyboard's project belongs to. */
  projectProperty: "prp_1",
}));

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("not found");
  },
  redirect: (path: string) => {
    throw new Error(`redirect ${path}`);
  },
}));
vi.mock("@/lib/auth", () => ({
  getCurrentUser: () => {
    state.reads.push("session");
    return Promise.resolve(state.signedIn ? { user: { id: "usr_1" } } : null);
  },
}));
vi.mock("@/lib/generation-start", () => ({
  getGenerationStartService: () =>
    state.built
      ? {
          offer: (actor: string, organizationId: string, projectId: string) => {
            state.reads.push(`offer ${actor} ${organizationId} ${projectId}`);
            const answer = state.offers.get(organizationId);
            return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
          },
        }
      : null,
}));
vi.mock("@/lib/identity", () => ({
  getIdentityServices: () => ({
    organizations: {
      listForUser: () =>
        Promise.resolve(state.organizations.map(({ id, name }) => ({ organization: { id, name }, role: "OWNER" }))),
    },
  }),
}));
vi.mock("@/lib/property", () => ({
  getPropertyServices: () => ({
    properties: {
      get: (_actor: string, organizationId: string, propertyId: string) => {
        const organization = state.organizations.find((candidate) => candidate.id === organizationId);
        return organization?.properties.includes(propertyId)
          ? Promise.resolve({ id: propertyId, name: "Kanda House" })
          : Promise.reject(new AppError("NOT_FOUND", "Property not found"));
      },
    },
  }),
}));
vi.mock("@/lib/storyboard", () => ({
  getStoryboardService: () => ({
    getStoryboard: (_actor: string, organizationId: string, projectId: string) => {
      state.reads.push(`storyboard ${organizationId} ${projectId}`);
      return Promise.resolve({
        project: { id: projectId, propertyId: state.projectProperty, name: "Spring tour" },
        scenes: [
          { id: "scn_1", roomType: "LIVING_ROOM" },
          { id: "scn_2", roomType: "KITCHEN" },
        ],
        fresh: true,
      });
    },
  }),
}));

const { default: StartVideoPage } = await import("./page");

const READY: StartOffer = {
  kind: "READY",
  qualityTier: "NORMAL",
  scenes: [
    { id: "scn_2", durationSeconds: 5 },
    { id: "scn_1", durationSeconds: 5 },
  ],
  durationSeconds: 10,
  requiredUnits: 1,
  funding: { baseUnits: 1, addOnUnits: 0 },
};

beforeEach(() => {
  state.built = true;
  state.signedIn = true;
  state.reads = [];
  state.organizations = [{ id: "org_1", name: "Studio Kanda", properties: ["prp_1"] }];
  state.offers = new Map([["org_1", READY]]);
  state.projectProperty = "prp_1";
});

afterEach(cleanup);

async function page(query: { error?: string } = {}, propertyId = "prp_1"): Promise<HTMLElement> {
  const element = (await StartVideoPage({
    params: Promise.resolve({ propertyId, projectId: "vpr_1" }),
    searchParams: Promise.resolve(query),
  })) as ReactElement;
  return render(element).container;
}

const text = (element: Element) => (element.textContent ?? "").replace(/\s+/g, " ");
const keyOf = (container: HTMLElement) =>
  container.querySelector<HTMLInputElement>("input[name=idempotencyKey]")?.value;

describe("the start page", () => {
  it("is not found where the start is not built, before the session is read", async () => {
    state.built = false;
    await expect(page()).rejects.toThrow("not found");
    expect(state.reads).toEqual([]);
  });

  it("sends a signed-out visitor to sign in", async () => {
    state.signedIn = false;
    await expect(page()).rejects.toThrow("redirect /login");
  });

  it("shows the offer for the Property and project in the URL, with the storyboard's rooms", async () => {
    const container = await page({ error: "The storyboard changed after you reviewed it." });
    expect(state.reads).toEqual(["session", "offer usr_1 org_1 vpr_1", "storyboard org_1 vpr_1"]);
    expect(container.querySelector("h1")?.textContent).toBe("Start the video");
    expect(text(container)).toContain("Studio Kanda · Kanda House");
    expect(container.querySelector("a")?.getAttribute("href")).toBe("/properties/prp_1/video-projects/vpr_1");
    expect(container.querySelector("a")?.textContent).toBe("← Spring tour");
    const alert = container.querySelector("[role=alert]");
    expect(alert?.textContent).toBe("The storyboard changed after you reviewed it.");
    const scenes = [...container.querySelectorAll("li")].map(text);
    expect(scenes).toEqual(["Kitchen · 5 seconds", "Living room · 5 seconds"]);
    expect(container.querySelector("input[name=organizationId]")?.getAttribute("value")).toBe("org_1");
  });

  it("makes a new key each time it is shown", async () => {
    const first = keyOf(await page());
    cleanup();
    const second = keyOf(await page());
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(second).toMatch(/^[0-9a-f-]{36}$/);
    expect(second).not.toBe(first);
  });

  it("tells a member who may not start videos so, without reading the storyboard", async () => {
    state.offers.set("org_1", new AppError("FORBIDDEN", "Missing permission"));
    const container = await page();
    expect(text(container)).toContain("You cannot start videos for this project.");
    expect(container.querySelectorAll("form")).toHaveLength(0);
    expect(container.querySelector("a")?.textContent).toBe("← Back to the project");
    expect(state.reads).toEqual(["session", "offer usr_1 org_1 vpr_1"]);
  });

  it("looks in the member's next organization when the project is not found in one", async () => {
    state.organizations = [
      { id: "org_1", name: "Studio Kanda", properties: ["prp_1"] },
      { id: "org_2", name: "Kanda Holdings", properties: ["prp_1"] },
    ];
    state.offers = new Map<string, StartOffer | Error>([
      ["org_1", new AppError("NOT_FOUND", "Video project not found")],
      ["org_2", READY],
    ]);
    const container = await page();
    expect(text(container)).toContain("Kanda Holdings · Kanda House");
    expect(container.querySelector("input[name=organizationId]")?.getAttribute("value")).toBe("org_2");
  });

  it("is not found for a Property out of reach, or a project of another Property", async () => {
    await expect(page({}, "prp_other")).rejects.toThrow("redirect /?error=Property%20not%20found");
    expect(state.reads).toEqual(["session"]);

    state.projectProperty = "prp_other";
    await expect(page()).rejects.toThrow("redirect /?error=Property%20not%20found");
  });

  it("lets any other failure through", async () => {
    for (const failure of [new AppError("INTERNAL_ERROR", "ledger disagrees"), new TypeError("bug")]) {
      state.offers.set("org_1", failure);
      await expect(page()).rejects.toThrow(failure);
    }
  });
});
