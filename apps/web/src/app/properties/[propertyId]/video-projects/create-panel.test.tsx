// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PROJECT_ERRORS } from "@/lib/project-errors";
import { CreateProjectPanel } from "./create-panel";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

const ORG = "org_1";
const PROPERTY = "prp_1";

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

function panel() {
  return render(<CreateProjectPanel organizationId={ORG} propertyId={PROPERTY} />);
}

function respond(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function createButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: "Create project" }) as HTMLButtonElement;
}

/** Fill the four fields the create API requires. */
async function fillRequired(duration = "30"): Promise<void> {
  await userEvent.type(screen.getByLabelText("Project name"), "Walkthrough");
  await userEvent.type(screen.getByLabelText("Target length in seconds"), duration);
  await userEvent.type(screen.getByLabelText("Aspect ratio"), "16:9");
  await userEvent.type(screen.getByLabelText("Resolution"), "1080p");
}

function lastRequest(): { url: string; body: Record<string, unknown> } {
  const [url, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
  return { url, body: JSON.parse(String(init.body)) as Record<string, unknown> };
}

describe("required input gates submission", () => {
  it("keeps the button disabled until every required field is filled", async () => {
    panel();
    expect(createButton().disabled).toBe(true);

    await userEvent.type(screen.getByLabelText("Project name"), "Walkthrough");
    expect(createButton().disabled).toBe(true);
    await userEvent.type(screen.getByLabelText("Target length in seconds"), "30");
    expect(createButton().disabled).toBe(true);
    await userEvent.type(screen.getByLabelText("Aspect ratio"), "16:9");
    expect(createButton().disabled).toBe(true);
    await userEvent.type(screen.getByLabelText("Resolution"), "1080p");
    expect(createButton().disabled).toBe(false);
  });

  it("refuses a duration that is not a whole number above zero", async () => {
    panel();
    await fillRequired("0");
    expect(createButton().disabled).toBe(true);

    await userEvent.clear(screen.getByLabelText("Target length in seconds"));
    await userEvent.type(screen.getByLabelText("Target length in seconds"), "12.5");
    expect(createButton().disabled).toBe(true);

    await userEvent.clear(screen.getByLabelText("Target length in seconds"));
    await userEvent.type(screen.getByLabelText("Target length in seconds"), "abc");
    expect(createButton().disabled).toBe(true);

    await userEvent.clear(screen.getByLabelText("Target length in seconds"));
    await userEvent.type(screen.getByLabelText("Target length in seconds"), "30");
    expect(createButton().disabled).toBe(false);
  });

  it("does not treat blank space as a filled field", async () => {
    panel();
    await userEvent.type(screen.getByLabelText("Project name"), "   ");
    await userEvent.type(screen.getByLabelText("Target length in seconds"), "30");
    await userEvent.type(screen.getByLabelText("Aspect ratio"), "16:9");
    await userEvent.type(screen.getByLabelText("Resolution"), "1080p");
    expect(createButton().disabled).toBe(true);
  });
});

describe("request", () => {
  it("posts to the create endpoint with exactly the required fields", async () => {
    fetchMock.mockResolvedValue(respond(201, { id: "vpr_1" }));
    panel();
    await fillRequired();
    await userEvent.click(createButton());

    const { url, body } = lastRequest();
    expect(url).toBe(`/api/properties/${PROPERTY}/video-projects`);
    expect(body).toEqual({
      organizationId: ORG,
      name: "Walkthrough",
      durationSeconds: 30,
      aspectRatio: "16:9",
      resolution: "1080p",
    });
    expect(typeof body.durationSeconds).toBe("number");
  });

  it("includes the optional fields only when they carry text", async () => {
    fetchMock.mockResolvedValue(respond(201));
    panel();
    await fillRequired();
    await userEvent.type(
      screen.getByLabelText("What should the walkthrough feel like? (optional)"),
      "bright and airy",
    );
    await userEvent.type(screen.getByLabelText("Camera motion (optional)"), "SLOW_PAN");
    await userEvent.click(createButton());

    const { body } = lastRequest();
    expect(body.prompt).toBe("bright and airy");
    expect(body.cameraMotion).toBe("SLOW_PAN");
    expect(body).not.toHaveProperty("negativePrompt");
  });

  it("sends no lifecycle or internal field", async () => {
    fetchMock.mockResolvedValue(respond(201));
    panel();
    await fillRequired();
    await userEvent.click(createButton());

    const { body } = lastRequest();
    // The create endpoint cannot express these, and the client must never
    // present a project as already composed.
    for (const forbidden of [
      "status",
      "compositionFingerprint",
      "scenes",
      "createdBy",
      "compiledPrompt",
      "propertyId",
      "id",
    ]) {
      expect(body).not.toHaveProperty(forbidden);
    }
  });
});

describe("outcome", () => {
  it("clears the form and refreshes the server component on 201", async () => {
    fetchMock.mockResolvedValue(respond(201, { id: "vpr_1" }));
    panel();
    await fillRequired();
    await userEvent.click(createButton());

    expect(refresh).toHaveBeenCalledTimes(1);
    expect((screen.getByLabelText("Project name") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("Resolution") as HTMLInputElement).value).toBe("");
  });

  it("does not refresh when the request fails", async () => {
    fetchMock.mockResolvedValue(respond(422, { error: { message: "A project name is required" } }));
    panel();
    await fillRequired();
    await userEvent.click(createButton());

    expect(refresh).not.toHaveBeenCalled();
  });

  it.each([
    [401, PROJECT_ERRORS.signIn],
    [403, PROJECT_ERRORS.permission],
    [404, PROJECT_ERRORS.reload],
    [500, PROJECT_ERRORS.generic],
  ])("renders the mapped message for %i", async (status, expected) => {
    fetchMock.mockResolvedValue(respond(status, { error: { message: "raw server text" } }));
    panel();
    await fillRequired();
    await userEvent.click(createButton());

    expect(screen.getByText(expected)).toBeTruthy();
    expect(screen.queryByText("raw server text")).toBeNull();
  });

  it("renders the API's own message for a 422", async () => {
    fetchMock.mockResolvedValue(
      respond(422, { error: { message: "Aspect ratio and resolution are required" } }),
    );
    panel();
    await fillRequired();
    await userEvent.click(createButton());

    expect(screen.getByText("Aspect ratio and resolution are required")).toBeTruthy();
  });

  it("renders the generic message when the request never completes", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));
    panel();
    await fillRequired();
    await userEvent.click(createButton());

    expect(screen.getByText(PROJECT_ERRORS.generic)).toBeTruthy();
    expect(screen.queryByText("network down")).toBeNull();
  });

  it("leaves the form filled and usable so a retryable failure can be retried", async () => {
    fetchMock.mockResolvedValueOnce(respond(500));
    panel();
    await fillRequired();
    await userEvent.click(createButton());

    expect(screen.getByText(PROJECT_ERRORS.generic)).toBeTruthy();
    expect((screen.getByLabelText("Project name") as HTMLInputElement).value).toBe("Walkthrough");
    expect(createButton().disabled).toBe(false);

    fetchMock.mockResolvedValueOnce(respond(201));
    await userEvent.click(createButton());

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(PROJECT_ERRORS.generic)).toBeNull();
    expect(lastRequest().body.name).toBe("Walkthrough");
  });
});
