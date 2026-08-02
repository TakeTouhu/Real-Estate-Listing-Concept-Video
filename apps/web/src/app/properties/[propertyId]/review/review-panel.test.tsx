// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DECISION_ERRORS } from "@/lib/decision-errors";
import { ReviewDecisionPanel, type DecisionMember } from "./review-panel";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

const ORG = "org_1";
const PROPERTY = "prp_1";

function member(overrides: Partial<DecisionMember> = {}): DecisionMember {
  return { assetId: "ast_a", filename: "a.jpg", canApprove: true, canReject: true, ...overrides };
}

function panel(members: DecisionMember[] = [member()]) {
  return render(
    <ReviewDecisionPanel organizationId={ORG} propertyId={PROPERTY} members={members} />,
  );
}

/** Resolve like the API: JSON body, given status. */
function respond(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
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

function lastRequest(): { url: string; body: Record<string, unknown> } {
  const [url, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
  return { url, body: JSON.parse(String(init.body)) as Record<string, unknown> };
}

describe("approve", () => {
  it("posts to the approve route and refreshes the server component", async () => {
    fetchMock.mockResolvedValue(respond(200));
    panel();
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));

    const { url, body } = lastRequest();
    expect(url).toBe(`/api/properties/${PROPERTY}/assets/ast_a/analysis/approve`);
    expect(body).toEqual({ organizationId: ORG, primaryAssetId: "ast_a" });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("never sends analysisRevision — the API accepts no revision token", async () => {
    fetchMock.mockResolvedValue(respond(200));
    panel();
    await userEvent.type(screen.getByLabelText("Reason for a.jpg"), "Looks good");
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));

    const { body } = lastRequest();
    expect(body).not.toHaveProperty("analysisRevision");
    expect(Object.keys(body).sort()).toEqual(["organizationId", "primaryAssetId", "reason"]);
  });

  it("renders no approve control for a photo with a blocking finding", () => {
    panel([member({ canApprove: false })]);
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(screen.getByRole("button", { name: "Reject" })).toBeTruthy();
  });
});

describe("reject", () => {
  it("requires a reason before the control is usable, then posts it", async () => {
    fetchMock.mockResolvedValue(respond(200));
    panel();
    const reject = screen.getByRole("button", { name: "Reject" });
    expect(reject).toHaveProperty("disabled", true);

    await userEvent.type(screen.getByLabelText("Reason for a.jpg"), "Too blurry");
    expect(reject).toHaveProperty("disabled", false);
    await userEvent.click(reject);

    const { url, body } = lastRequest();
    expect(url).toBe(`/api/properties/${PROPERTY}/assets/ast_a/analysis/reject`);
    expect(body).toEqual({ organizationId: ORG, reason: "Too blurry" });
  });

  it("keeps the control unusable for whitespace, matching the domain rule", async () => {
    panel();
    await userEvent.type(screen.getByLabelText("Reason for a.jpg"), "   ");
    expect(screen.getByRole("button", { name: "Reject" })).toHaveProperty("disabled", true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("duplicate cluster", () => {
  const members = [member(), member({ assetId: "ast_b", filename: "b.jpg" })];

  it("offers a primary radio per member and approves only the selected one", async () => {
    fetchMock.mockResolvedValue(respond(200));
    panel(members);
    expect(screen.getAllByRole("radio")).toHaveLength(2);

    const approves = screen.getAllByRole("button", { name: "Approve" });
    expect(approves.every((b) => (b as HTMLButtonElement).disabled)).toBe(true);

    await userEvent.click(screen.getAllByRole("radio")[1]!);
    expect((approves[0] as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(approves[1]!);

    const { url, body } = lastRequest();
    expect(url).toContain("/assets/ast_b/analysis/approve");
    // The domain requires primaryAssetId to be the asset being approved, so the
    // radio drives both rather than allowing the two to disagree.
    expect(body.primaryAssetId).toBe("ast_b");
  });

  it("renders no radios for a single photo and can approve it immediately", async () => {
    fetchMock.mockResolvedValue(respond(200));
    panel();
    expect(screen.queryAllByRole("radio")).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Approve" })).toHaveProperty("disabled", false);
  });
});

describe("failures", () => {
  it("renders the API message for a 422 without parsing it", async () => {
    const message = "Another photo in this duplicate group is already approved";
    fetchMock.mockResolvedValue(respond(422, { error: { code: "VALIDATION_FAILED", message } }));
    panel();
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));

    expect(screen.getByText(message)).toBeTruthy();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("maps transport-level statuses without consulting the message", async () => {
    for (const [status, expected] of [
      [401, DECISION_ERRORS.signIn],
      [403, DECISION_ERRORS.permission],
      [404, DECISION_ERRORS.reload],
      [500, DECISION_ERRORS.generic],
    ] as const) {
      fetchMock.mockResolvedValue(
        respond(status, { error: { code: "X", message: "internal detail" } }),
      );
      panel();
      await userEvent.click(screen.getByRole("button", { name: "Approve" }));
      expect(screen.getByText(expected)).toBeTruthy();
      expect(screen.queryByText("internal detail")).toBeNull();
      cleanup();
    }
  });

  it("falls back generically when the response is not JSON", async () => {
    fetchMock.mockResolvedValue(new Response("<html>gateway</html>", { status: 422 }));
    panel();
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(screen.getByText(DECISION_ERRORS.generic)).toBeTruthy();
  });

  it("falls back generically on a network failure and leaves the row usable", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    panel();
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));

    expect(screen.getByText(DECISION_ERRORS.generic)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Approve" })).toHaveProperty("disabled", false);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("disables only the acting row while a decision is in flight", async () => {
    let release: (value: Response) => void = () => {};
    fetchMock.mockReturnValue(new Promise<Response>((resolve) => (release = resolve)));
    panel([member(), member({ assetId: "ast_b", filename: "b.jpg" })]);

    await userEvent.click(screen.getAllByRole("radio")[0]!);
    await userEvent.click(screen.getAllByRole("button", { name: "Approve" })[0]!);

    expect(screen.getByText("Recording…")).toBeTruthy();
    for (const button of screen.getAllByRole("button")) {
      expect(button).toHaveProperty("disabled", true);
    }
    await act(async () => {
      release(respond(200));
    });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("renders no controls at all when the member has neither action", () => {
    panel([member({ canApprove: false, canReject: false })]);
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });
});
