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

/** The server page resolves these from the domain vocabulary; here they are fixed. */
const CAMERA_MOTION_OPTIONS = [
  { value: "STATIC", label: "Static (no camera movement)" },
  { value: "SLOW_DOLLY_FORWARD", label: "Slow dolly forward" },
  { value: "SLOW_PAN_LEFT", label: "Slow pan left" },
  { value: "SLOW_PAN_RIGHT", label: "Slow pan right" },
];

function panel() {
  return render(
    <CreateProjectPanel
      organizationId={ORG}
      propertyId={PROPERTY}
      cameraMotionOptions={CAMERA_MOTION_OPTIONS}
      targetOutputResolutionOptions={["720p", "1080p"]}
    />,
  );
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
  await userEvent.selectOptions(screen.getByLabelText("Output resolution"), "1080p");
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
    await userEvent.selectOptions(screen.getByLabelText("Output resolution"), "1080p");
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
    await userEvent.selectOptions(screen.getByLabelText("Output resolution"), "1080p");
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
      targetOutputResolution: "1080p",
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
    await userEvent.selectOptions(
      screen.getByLabelText("Camera motion (optional)"),
      "SLOW_PAN_LEFT",
    );
    await userEvent.click(createButton());

    const { body } = lastRequest();
    expect(body.prompt).toBe("bright and airy");
    expect(body.cameraMotion).toBe("SLOW_PAN_LEFT");
    expect(body).not.toHaveProperty("negativePrompt");
  });

  it("offers only approved camera motions, and no free-text entry", async () => {
    // The control cannot express an arbitrary instruction at all. The server
    // refuses one regardless (ADR-0022) — this is the surface, not the boundary.
    panel();
    const control = screen.getByLabelText("Camera motion (optional)") as HTMLSelectElement;
    expect(control.tagName).toBe("SELECT");
    expect([...control.options].map((o) => o.value)).toEqual([
      "",
      "STATIC",
      "SLOW_DOLLY_FORWARD",
      "SLOW_PAN_LEFT",
      "SLOW_PAN_RIGHT",
    ]);
  });

  it("omits cameraMotion entirely when left unspecified", async () => {
    fetchMock.mockResolvedValue(respond(201));
    panel();
    await fillRequired();
    await userEvent.click(createButton());
    expect(lastRequest().body).not.toHaveProperty("cameraMotion");
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
    expect((screen.getByLabelText("Output resolution") as HTMLSelectElement).value).toBe("");
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
      respond(422, { error: { message: "An aspect ratio is required" } }),
    );
    panel();
    await fillRequired();
    await userEvent.click(createButton());

    expect(screen.getByText("An aspect ratio is required")).toBeTruthy();
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

/**
 * Phase 4B-2a: the unsupported negative-prompt control.
 *
 * The configured production model documents no `negative_prompt` parameter, so
 * a project carrying one is refused at generation admission. Offering the field
 * here would invite a customer to write a requirement the product cannot honour
 * and fail them later, at the point they ask for a video (ADR-0019).
 *
 * These assertions discriminate: the pre-existing "optional fields only when
 * they carry text" case passed before the removal too, because a blank field
 * was already omitted from the body.
 */
describe("unsupported provider features are not offered", () => {
  it("renders no negative-prompt control", () => {
    panel();
    expect(screen.queryByLabelText("Anything to avoid? (optional)")).toBeNull();
    expect(screen.queryByLabelText(/avoid/i)).toBeNull();
  });

  it("keeps the controls whose intent the model can honour", () => {
    // Aspect ratio survives because composition owns the guarantee; camera
    // motion survives because the model's prompt input carries the intent.
    panel();
    expect(screen.getByLabelText("Aspect ratio")).toBeTruthy();
    expect(screen.getByLabelText("Camera motion (optional)")).toBeTruthy();
    expect(screen.getByLabelText("Output resolution")).toBeTruthy();
  });

  it("cannot send negativePrompt even with every visible field filled", async () => {
    fetchMock.mockResolvedValue(respond(201));
    panel();
    await fillRequired();
    await userEvent.type(
      screen.getByLabelText("What should the walkthrough feel like? (optional)"),
      "bright and airy",
    );
    await userEvent.selectOptions(
      screen.getByLabelText("Camera motion (optional)"),
      "SLOW_PAN_LEFT",
    );
    await userEvent.click(createButton());

    const { body } = lastRequest();
    expect(body).not.toHaveProperty("negativePrompt");
    // And nothing else crept in: exactly the fields this form can express.
    expect(Object.keys(body).sort()).toEqual(
      [
        "organizationId",
        "name",
        "durationSeconds",
        "aspectRatio",
        "targetOutputResolution",
        "prompt",
        "cameraMotion",
      ].sort(),
    );
  });
});
