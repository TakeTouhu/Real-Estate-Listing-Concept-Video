// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COMPOSE_ERRORS } from "@/lib/project-errors";
import { ComposePanel } from "./compose-panel";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

const ORG = "org_1";
const PROJECT = "vpr_1";

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  refresh.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function panel(hasScenes = false) {
  return render(
    <ComposePanel organizationId={ORG} projectId={PROJECT} hasScenes={hasScenes} />,
  );
}

function respond(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function composeButton(hasScenes = false): HTMLButtonElement {
  return screen.getByRole("button", {
    name: hasScenes ? "Compose again" : "Compose storyboard",
  }) as HTMLButtonElement;
}

function minInput(): HTMLInputElement {
  return screen.getByLabelText("Shortest scene, in seconds") as HTMLInputElement;
}

function maxInput(): HTMLInputElement {
  return screen.getByLabelText("Longest scene, in seconds") as HTMLInputElement;
}

async function fillBounds(min = "2", max = "10"): Promise<void> {
  await userEvent.type(minInput(), min);
  await userEvent.type(maxInput(), max);
}

function lastRequest(): { url: string; body: Record<string, unknown> } {
  const [url, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
  return { url, body: JSON.parse(String(init.body)) as Record<string, unknown> };
}

describe("bounds", () => {
  it("prefills nothing — there is no provider-derived default", () => {
    panel();
    expect(minInput().value).toBe("");
    expect(maxInput().value).toBe("");
    expect(composeButton().disabled).toBe(true);
  });

  it("stays unavailable until both bounds are whole numbers above zero", async () => {
    panel();
    await userEvent.type(minInput(), "2");
    expect(composeButton().disabled).toBe(true);
    await userEvent.type(maxInput(), "10");
    expect(composeButton().disabled).toBe(false);
  });

  it.each([
    ["0", "10"],
    ["2", "0"],
    ["2.5", "10"],
    ["2", "10.5"],
    ["abc", "10"],
    ["2", "abc"],
    ["-2", "10"],
  ])("refuses min=%s max=%s", async (min, max) => {
    panel();
    await fillBounds(min, max);
    expect(composeButton().disabled).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not describe the bounds as provider capabilities", () => {
    panel();
    expect(screen.getByText(/Scene pacing/)).toBeTruthy();
    expect(screen.queryByText(/provider/i)).toBeNull();
    expect(screen.queryByText(/supported/i)).toBeNull();
    expect(screen.queryByText(/maximum allowed/i)).toBeNull();
  });
});

describe("request", () => {
  it("posts to the compose endpoint with exactly the three fields", async () => {
    fetchMock.mockResolvedValue(respond(200, { project: {}, scenes: [], fresh: true }));
    panel();
    await fillBounds("2", "10");
    await userEvent.click(composeButton());

    const { url, body } = lastRequest();
    expect(url).toBe(`/api/video-projects/${PROJECT}/storyboard`);
    expect(body).toEqual({ organizationId: ORG, minSceneSeconds: 2, maxSceneSeconds: 10 });
    expect(typeof body.minSceneSeconds).toBe("number");
    expect(typeof body.maxSceneSeconds).toBe("number");
  });

  it("sends no composition or lifecycle field of its own", async () => {
    fetchMock.mockResolvedValue(respond(200));
    panel();
    await fillBounds();
    await userEvent.click(composeButton());

    const { body } = lastRequest();
    for (const forbidden of [
      "scenes",
      "status",
      "compositionFingerprint",
      "compiledPrompt",
      "assetIds",
      "order",
      "prompt",
      "model",
      "provider",
    ]) {
      expect(body).not.toHaveProperty(forbidden);
    }
  });

  it("uses the same endpoint to recompose an existing storyboard", async () => {
    fetchMock.mockResolvedValue(respond(200));
    panel(true);
    await fillBounds("3", "9");
    await userEvent.click(composeButton(true));

    expect(lastRequest().url).toBe(`/api/video-projects/${PROJECT}/storyboard`);
    expect(fetchMock.mock.calls).toHaveLength(1);
  });
});

describe("outcome", () => {
  it("refreshes the server component on success", async () => {
    fetchMock.mockResolvedValue(respond(200));
    panel();
    await fillBounds();
    await userEvent.click(composeButton());

    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("does not refresh when composition fails", async () => {
    fetchMock.mockResolvedValue(respond(422, { error: { message: "not enough photos" } }));
    panel();
    await fillBounds();
    await userEvent.click(composeButton());

    expect(refresh).not.toHaveBeenCalled();
  });

  it.each([
    [401, COMPOSE_ERRORS.signIn],
    [403, COMPOSE_ERRORS.permission],
    [404, COMPOSE_ERRORS.reload],
    [500, COMPOSE_ERRORS.generic],
  ])("renders the mapped message for %i", async (status, expected) => {
    fetchMock.mockResolvedValue(respond(status, { error: { message: "raw server text" } }));
    panel();
    await fillBounds();
    await userEvent.click(composeButton());

    expect(screen.getByText(expected)).toBeTruthy();
    expect(screen.queryByText("raw server text")).toBeNull();
  });

  it("renders the duration-range refusal with both achievable figures", async () => {
    fetchMock.mockResolvedValue(
      respond(422, {
        error: {
          message: "3 scenes can run between 6 and 30 seconds; 45 was requested",
          details: { minimumAchievableDuration: 6, maximumAchievableDuration: 30 },
        },
      }),
    );
    panel();
    await fillBounds();
    await userEvent.click(composeButton());

    expect(
      screen.getByText("3 scenes can run between 6 and 30 seconds; 45 was requested"),
    ).toBeTruthy();
  });

  it("renders the minimum-scene refusal as written", async () => {
    fetchMock.mockResolvedValue(
      respond(422, {
        error: { message: "A storyboard needs at least 3 approved photos; 2 are available" },
      }),
    );
    panel();
    await fillBounds();
    await userEvent.click(composeButton());

    expect(
      screen.getByText("A storyboard needs at least 3 approved photos; 2 are available"),
    ).toBeTruthy();
  });

  it("keeps a moderation refusal sanitized — no rejected prompt text reaches the DOM", async () => {
    const marker = "PLANTED-PROMPT-MARKER-add-a-window";
    fetchMock.mockResolvedValue(
      respond(422, {
        error: {
          message: "The prompt was rejected by content review",
          details: { findings: [{ field: "prompt", code: "ADDS_PEOPLE_OR_LOGOS" }] },
        },
      }),
    );
    const { container } = panel();
    await fillBounds();
    await userEvent.click(composeButton());

    expect(screen.getByText("The prompt was rejected by content review")).toBeTruthy();
    expect(container.innerHTML).not.toContain(marker);
    // The structured findings are diagnostic data, not something to render.
    expect(container.innerHTML).not.toContain("ADDS_PEOPLE_OR_LOGOS");
    expect(container.innerHTML).not.toContain("findings");
  });

  it("renders the generic message when the request never completes", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));
    panel();
    await fillBounds();
    await userEvent.click(composeButton());

    expect(screen.getByText(COMPOSE_ERRORS.generic)).toBeTruthy();
    expect(screen.queryByText("network down")).toBeNull();
  });

  it("keeps the entered bounds so a retryable failure can be retried", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network down"));
    panel();
    await fillBounds("3", "9");
    await userEvent.click(composeButton());

    expect(screen.getByText(COMPOSE_ERRORS.generic)).toBeTruthy();
    expect(minInput().value).toBe("3");
    expect(maxInput().value).toBe("9");
    expect(composeButton().disabled).toBe(false);

    fetchMock.mockResolvedValueOnce(respond(200));
    await userEvent.click(composeButton());

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(COMPOSE_ERRORS.generic)).toBeNull();
    expect(lastRequest().body).toEqual({
      organizationId: ORG,
      minSceneSeconds: 3,
      maxSceneSeconds: 9,
    });
  });
});
