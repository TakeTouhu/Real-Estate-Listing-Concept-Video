// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ANALYSIS_ERRORS } from "@/lib/analysis-errors";
import type { AnalyzeTarget } from "@/lib/review-view";
import { AnalyzePhotosButton } from "./analyze-photos-button";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

const ORG = "org_1";
const PROPERTY = "prp_1";
const TARGETS: AnalyzeTarget[] = [
  { assetId: "ast_a", filename: "a.jpg" },
  { assetId: "ast_b", filename: "b.jpg" },
  { assetId: "ast_c", filename: "c.jpg" },
];

function button(targets: AnalyzeTarget[] = TARGETS) {
  return render(<AnalyzePhotosButton organizationId={ORG} propertyId={PROPERTY} targets={targets} />);
}

function respond(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

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

async function press(count = TARGETS.length): Promise<void> {
  const label = `Analyze ${count} ${count === 1 ? "photo" : "photos"} not analyzed yet`;
  await userEvent.click(screen.getByRole("button", { name: label }));
}

describe("the analyze button (GS-13b, ADR-0122)", () => {
  it("asks for nothing until it is pressed, and names how many photos it will analyze", () => {
    button();
    expect(screen.getByRole("button").textContent).toBe("Analyze 3 photos not analyzed yet");
    button([TARGETS[0]!]);
    expect(screen.getByRole("button", { name: "Analyze 1 photo not analyzed yet" })).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("asks the analysis route for each photo in turn, as the organization, then reads the page again", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(respond(200)));
    button();
    await press();

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      `/api/properties/${PROPERTY}/assets/ast_a/analysis`,
      `/api/properties/${PROPERTY}/assets/ast_b/analysis`,
      `/api/properties/${PROPERTY}/assets/ast_c/analysis`,
    ]);
    for (const [, init] of fetchMock.mock.calls as [string, RequestInit][]) {
      expect(init.method).toBe("POST");
      expect(init.headers).toEqual({ "Content-Type": "application/json" });
      expect(JSON.parse(String(init.body))).toEqual({ organizationId: ORG });
    }
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/Analyzing/)).toBeNull();
    expect(document.querySelectorAll(".status-bad")).toHaveLength(0);
  });

  it("shows which photo it is on, and cannot be pressed again meanwhile", async () => {
    let release: (response: Response) => void = () => undefined;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => (release = resolve)));
    fetchMock.mockImplementation(() => Promise.resolve(respond(200)));
    button();
    const pressing = press();
    expect(await screen.findByText("Analyzing 1 of 3…")).toBeTruthy();
    expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(true);
    release(respond(200));
    await pressing;
    expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("shows a refusal against its photo, keeps going, and still reads the page again", async () => {
    fetchMock
      .mockResolvedValueOnce(respond(422, { error: { code: "VALIDATION_FAILED", message: "Not ready yet" } }))
      .mockRejectedValueOnce(new TypeError("network"))
      .mockResolvedValueOnce(respond(404, { error: { message: "Asset not found" } }));
    button();
    await press();

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect([...document.querySelectorAll(".status-bad")].map((node) => node.textContent)).toEqual([
      "a.jpg: Not ready yet",
      `b.jpg: ${ANALYSIS_ERRORS.generic}`,
      `c.jpg: ${ANALYSIS_ERRORS.reload}`,
    ]);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("stops at a refusal that holds for every photo, and shows it once", async () => {
    for (const [status, message] of [
      [401, ANALYSIS_ERRORS.signIn],
      [403, ANALYSIS_ERRORS.permission],
    ] as const) {
      fetchMock.mockReset();
      refresh.mockReset();
      fetchMock.mockResolvedValueOnce(respond(200)).mockResolvedValue(respond(status));
      const { unmount } = button();
      await press();
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect([...document.querySelectorAll(".status-bad")].map((node) => node.textContent)).toEqual([message]);
      expect(refresh).toHaveBeenCalledTimes(1);
      unmount();
    }
  });

  it("clears the last run's refusals as soon as it is pressed again", async () => {
    let release: (response: Response) => void = () => undefined;
    fetchMock
      .mockResolvedValueOnce(respond(500))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => (release = resolve)));
    button([TARGETS[0]!]);
    await press(1);
    expect(screen.getByText(`a.jpg: ${ANALYSIS_ERRORS.generic}`)).toBeTruthy();
    const again = press(1);
    expect(await screen.findByText("Analyzing 1 of 1…")).toBeTruthy();
    expect(document.querySelectorAll(".status-bad")).toHaveLength(0);
    release(respond(200));
    await again;
    expect(document.querySelectorAll(".status-bad")).toHaveLength(0);
  });
});
