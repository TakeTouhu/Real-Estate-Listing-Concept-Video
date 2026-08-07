// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CORRECTION_ERRORS } from "@/lib/correction-errors";
import { ReviewItemControls, type CorrectionTarget } from "./review-item-controls";
import type { DecisionMember } from "./review-panel";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

const ORG = "org_1";
const PROPERTY = "prp_1";
const ASSET = "ast_a";

const ROOM_OPTIONS = [
  { value: "LIVING_ROOM", label: "Living room" },
  { value: "KITCHEN", label: "Kitchen" },
  { value: "BALCONY", label: "Balcony" },
];

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

function target(overrides: Partial<CorrectionTarget> = {}): CorrectionTarget {
  return {
    assetId: ASSET,
    filename: "a.jpg",
    analyzerRoomType: "Kitchen",
    roomTypeOverride: null,
    orderOverride: null,
    ...overrides,
  };
}

function member(overrides: Partial<DecisionMember> = {}): DecisionMember {
  return { assetId: ASSET, filename: "a.jpg", canApprove: true, canReject: true, ...overrides };
}

function controls(
  options: {
    corrections?: CorrectionTarget[];
    members?: DecisionMember[];
  } = {},
) {
  return render(
    <ReviewItemControls
      organizationId={ORG}
      propertyId={PROPERTY}
      corrections={options.corrections ?? [target()]}
      members={options.members ?? [member()]}
      roomOptions={ROOM_OPTIONS}
    />,
  );
}

function respond(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const saveButton = () => screen.getByRole("button", { name: "Save correction" });
const approveButton = () => screen.getByRole("button", { name: "Approve" }) as HTMLButtonElement;
const rejectButton = () => screen.getByRole("button", { name: "Reject" }) as HTMLButtonElement;
const roomSelect = () => screen.getByLabelText("Room for a.jpg");
const orderInput = () => screen.getByLabelText("Order priority for a.jpg");

function lastRequest(): { url: string; body: Record<string, unknown> } {
  const [url, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
  return { url, body: JSON.parse(String(init.body)) as Record<string, unknown> };
}

const CORRECTION_URL = `/api/properties/${PROPERTY}/assets/${ASSET}/analysis/correction`;

/**
 * Stand-ins for the key `review/page.tsx` builds from authoritative correction
 * and review state. Changing it is what remounts the controls after a refresh.
 */
const AUTHORITATIVE_KEY_BEFORE = `${ASSET}:1:AWAITING::`;
const AUTHORITATIVE_KEY_AFTER = `${ASSET}:1:AWAITING:BALCONY:`;

describe("room field — the three HTTP states", () => {
  it("omits roomType when the reviewer never touched it", async () => {
    fetchMock.mockResolvedValue(respond(200));
    controls({ corrections: [target({ roomTypeOverride: "KITCHEN" })] });
    await userEvent.type(orderInput(), "2");
    await userEvent.click(saveButton());

    // Untouched must not be re-sent, even though a stored value exists.
    expect(lastRequest().body).not.toHaveProperty("roomType");
  });

  it("sends the chosen value when the reviewer picks a room", async () => {
    fetchMock.mockResolvedValue(respond(200));
    controls();
    await userEvent.selectOptions(roomSelect(), "LIVING_ROOM");
    await userEvent.click(saveButton());

    expect(lastRequest().body.roomType).toBe("LIVING_ROOM");
  });

  it("sends null when the reviewer clears an existing override", async () => {
    fetchMock.mockResolvedValue(respond(200));
    controls({ corrections: [target({ roomTypeOverride: "KITCHEN" })] });
    await userEvent.selectOptions(roomSelect(), "");
    await userEvent.click(saveButton());

    // "Use analyzer result" is a real choice, not an empty form field.
    const { body } = lastRequest();
    expect(body.roomType).toBeNull();
    expect("roomType" in body).toBe(true);
  });

  it("sends only roomType when the order was left alone", async () => {
    fetchMock.mockResolvedValue(respond(200));
    controls({ corrections: [target({ roomTypeOverride: "KITCHEN", orderOverride: 3 })] });
    await userEvent.selectOptions(roomSelect(), "");
    await userEvent.click(saveButton());

    expect(Object.keys(lastRequest().body).sort()).toEqual(["organizationId", "roomType"]);
  });
});

describe("order field — the three HTTP states", () => {
  it("omits order when the reviewer never touched it", async () => {
    fetchMock.mockResolvedValue(respond(200));
    controls({ corrections: [target({ orderOverride: 3 })] });
    await userEvent.selectOptions(roomSelect(), "BALCONY");
    await userEvent.click(saveButton());

    expect(lastRequest().body).not.toHaveProperty("order");
  });

  it("sends an integer when the reviewer sets a priority", async () => {
    fetchMock.mockResolvedValue(respond(200));
    controls();
    await userEvent.type(orderInput(), "4");
    await userEvent.click(saveButton());

    const { body } = lastRequest();
    expect(body.order).toBe(4);
    expect(typeof body.order).toBe("number");
  });

  it("sends the new value when the reviewer changes an existing priority", async () => {
    fetchMock.mockResolvedValue(respond(200));
    controls({ corrections: [target({ orderOverride: 3 })] });
    await userEvent.clear(orderInput());
    await userEvent.type(orderInput(), "7");
    await userEvent.click(saveButton());

    expect(lastRequest().body.order).toBe(7);
  });

  it("sends null when the reviewer empties an existing priority", async () => {
    fetchMock.mockResolvedValue(respond(200));
    controls({ corrections: [target({ orderOverride: 3 })] });
    await userEvent.clear(orderInput());
    await userEvent.click(saveButton());

    // The case a naive "empty means omitted" panel would break: clearing must
    // reach the API as an explicit null.
    const { body } = lastRequest();
    expect(body.order).toBeNull();
    expect("order" in body).toBe(true);
  });

  it("sends only order when the room was left alone", async () => {
    fetchMock.mockResolvedValue(respond(200));
    controls({ corrections: [target({ roomTypeOverride: "KITCHEN", orderOverride: 3 })] });
    await userEvent.clear(orderInput());
    await userEvent.click(saveButton());

    expect(Object.keys(lastRequest().body).sort()).toEqual(["order", "organizationId"]);
  });
});

describe("request shape", () => {
  it("posts to the correction endpoint with organizationId and both dirty fields", async () => {
    fetchMock.mockResolvedValue(respond(200));
    controls();
    await userEvent.selectOptions(roomSelect(), "KITCHEN");
    await userEvent.type(orderInput(), "5");
    await userEvent.click(saveButton());

    const { url, body } = lastRequest();
    expect(url).toBe(CORRECTION_URL);
    expect(body).toEqual({ organizationId: ORG, roomType: "KITCHEN", order: 5 });
  });

  it("offers no save and sends nothing when neither field is dirty", async () => {
    controls();
    expect((saveButton() as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(saveButton());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps save unavailable while a non-empty priority is not a whole number above zero", async () => {
    controls();
    await userEvent.type(orderInput(), "0");
    expect((saveButton() as HTMLButtonElement).disabled).toBe(true);
    await userEvent.clear(orderInput());
    await userEvent.type(orderInput(), "2.5");
    expect((saveButton() as HTMLButtonElement).disabled).toBe(true);
    await userEvent.clear(orderInput());
    await userEvent.type(orderInput(), "3");
    expect((saveButton() as HTMLButtonElement).disabled).toBe(false);
  });

  it("sends no lifecycle, identity or internal field", async () => {
    fetchMock.mockResolvedValue(respond(200));
    controls();
    await userEvent.selectOptions(roomSelect(), "KITCHEN");
    await userEvent.click(saveButton());

    const { body } = lastRequest();
    for (const forbidden of [
      "reviewStatus",
      "analysisRevision",
      "corrected",
      "effectiveRoomType",
      "propertyId",
      "assetId",
      "correctedBy",
      "correctedAt",
      "roomTypeOverride",
      "orderOverride",
    ]) {
      expect(body).not.toHaveProperty(forbidden);
    }
  });
});

describe("unsaved corrections block the review decision", () => {
  it("leaves decisions available while nothing is dirty", () => {
    controls();
    expect(approveButton().disabled).toBe(false);
    expect(screen.queryByText(/Save or discard/)).toBeNull();
  });

  it("blocks approve and reject once the room is edited", async () => {
    controls();
    await userEvent.type(screen.getByLabelText("Reason for a.jpg"), "looks fine");
    expect(rejectButton().disabled).toBe(false);

    await userEvent.selectOptions(roomSelect(), "BALCONY");

    expect(approveButton().disabled).toBe(true);
    expect(rejectButton().disabled).toBe(true);
    expect(screen.getByText(/Save or discard your correction changes/)).toBeTruthy();
  });

  it("blocks approve and reject once the order is edited", async () => {
    controls();
    await userEvent.type(orderInput(), "2");

    expect(approveButton().disabled).toBe(true);
    expect(rejectButton().disabled).toBe(true);
  });

  it("stays blocked when an existing override is cleared — clearing is a change", async () => {
    controls({ corrections: [target({ roomTypeOverride: "KITCHEN", orderOverride: 3 })] });
    await userEvent.selectOptions(roomSelect(), "");

    expect(approveButton().disabled).toBe(true);
  });

  it("stays blocked after a failed save, because the edits are still unsaved", async () => {
    fetchMock.mockResolvedValue(respond(500));
    controls();
    await userEvent.selectOptions(roomSelect(), "BALCONY");
    await userEvent.click(saveButton());

    // A failure must never unlock the decision: the visible correction is still
    // not persisted.
    expect(screen.getByText(CORRECTION_ERRORS.generic)).toBeTruthy();
    expect(approveButton().disabled).toBe(true);
    expect(rejectButton().disabled).toBe(true);
  });

  it("stays blocked immediately after a successful save, having only asked for a refresh", async () => {
    fetchMock.mockResolvedValue(respond(200));
    controls();
    await userEvent.selectOptions(roomSelect(), "BALCONY");
    await userEvent.click(saveButton());

    // A 200 says the write landed, not that the screen is fresh. Unlocking here
    // would let an approval through against a stale render — the defect this
    // test exists to catch. Asserting only `refresh` was called is what let it
    // through the first time.
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(approveButton().disabled).toBe(true);
    expect(rejectButton().disabled).toBe(true);
    expect(screen.getByText(/Save or discard your correction changes/)).toBeTruthy();
  });

  it("unlocks only when the refreshed authoritative render remounts the controls", async () => {
    fetchMock.mockResolvedValue(respond(200));
    const { rerender } = render(
      <ReviewItemControls
        key={AUTHORITATIVE_KEY_BEFORE}
        organizationId={ORG}
        propertyId={PROPERTY}
        corrections={[target()]}
        members={[member()]}
        roomOptions={ROOM_OPTIONS}
      />,
    );
    await userEvent.selectOptions(roomSelect(), "BALCONY");
    await userEvent.click(saveButton());
    expect(approveButton().disabled).toBe(true);

    // The real page keys these controls on authoritative correction and review
    // state, so the refreshed payload — and only it — remounts them. Simulate
    // exactly that: the server now reports the saved override.
    rerender(
      <ReviewItemControls
        key={AUTHORITATIVE_KEY_AFTER}
        organizationId={ORG}
        propertyId={PROPERTY}
        corrections={[target({ roomTypeOverride: "BALCONY" })]}
        members={[member()]}
        roomOptions={ROOM_OPTIONS}
      />,
    );

    expect(approveButton().disabled).toBe(false);
    expect(screen.queryByText(/Save or discard your correction changes/)).toBeNull();
    // Reject is governed by its own blank-reason rule, not by the interlock;
    // supplying a reason makes it available again too.
    await userEvent.type(screen.getByLabelText("Reason for a.jpg"), "too blurry");
    expect(rejectButton().disabled).toBe(false);
    // The remounted panel starts from the new authoritative value.
    expect((roomSelect() as HTMLSelectElement).value).toBe("BALCONY");
  });

  it("does not unlock on a re-render that carries no authoritative change", async () => {
    fetchMock.mockResolvedValue(respond(200));
    const { rerender } = render(
      <ReviewItemControls
        key={AUTHORITATIVE_KEY_BEFORE}
        organizationId={ORG}
        propertyId={PROPERTY}
        corrections={[target()]}
        members={[member()]}
        roomOptions={ROOM_OPTIONS}
      />,
    );
    await userEvent.selectOptions(roomSelect(), "BALCONY");
    await userEvent.click(saveButton());

    // Same key: the server state did not change, so nothing remounts and the
    // interlock correctly holds. The reviewer's escape is Discard, not a
    // silent unlock.
    rerender(
      <ReviewItemControls
        key={AUTHORITATIVE_KEY_BEFORE}
        organizationId={ORG}
        propertyId={PROPERTY}
        corrections={[target()]}
        members={[member()]}
        roomOptions={ROOM_OPTIONS}
      />,
    );

    expect(approveButton().disabled).toBe(true);
  });

  it("never submits an unsaved correction through Approve", async () => {
    fetchMock.mockResolvedValue(respond(200));
    controls();
    await userEvent.selectOptions(roomSelect(), "BALCONY");

    // Approve is disabled, so a click does nothing at all — the correction is
    // neither approved-around nor silently sent.
    await userEvent.click(approveButton());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks a cluster's decision when any member's correction is dirty", async () => {
    controls({
      corrections: [
        target({ assetId: "ast_a", filename: "a.jpg" }),
        target({ assetId: "ast_b", filename: "b.jpg" }),
      ],
      members: [member({ assetId: "ast_a" }), member({ assetId: "ast_b", filename: "b.jpg" })],
    });
    await userEvent.type(screen.getByLabelText("Order priority for b.jpg"), "3");

    expect(screen.getByText(/Save or discard your correction changes/)).toBeTruthy();
  });

  it("restores the decision when the reviewer discards the changes", async () => {
    controls({ corrections: [target({ orderOverride: 3 })] });
    await userEvent.clear(orderInput());
    expect(approveButton().disabled).toBe(true);

    await userEvent.click(screen.getByRole("button", { name: "Discard changes" }));

    expect(approveButton().disabled).toBe(false);
    expect((orderInput() as HTMLInputElement).value).toBe("3");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("the two operations stay separate", () => {
  it("saving a correction never calls approve or reject", async () => {
    fetchMock.mockResolvedValue(respond(200));
    controls();
    await userEvent.selectOptions(roomSelect(), "KITCHEN");
    await userEvent.click(saveButton());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(lastRequest().url).toBe(CORRECTION_URL);
  });

  it("approving sends only the approval payload, with no correction field", async () => {
    fetchMock.mockResolvedValue(respond(200));
    controls();
    await userEvent.click(approveButton());

    const { url, body } = lastRequest();
    expect(url).toBe(`/api/properties/${PROPERTY}/assets/${ASSET}/analysis/approve`);
    expect(body).toEqual({ organizationId: ORG, primaryAssetId: ASSET });
    for (const field of ["roomType", "order", "roomTypeOverride", "orderOverride"]) {
      expect(body).not.toHaveProperty(field);
    }
  });
});

describe("failure presentation", () => {
  it.each([
    [401, CORRECTION_ERRORS.signIn],
    [403, CORRECTION_ERRORS.permission],
    [404, CORRECTION_ERRORS.reload],
    [500, CORRECTION_ERRORS.generic],
  ])("renders the mapped message for %i", async (status, expected) => {
    fetchMock.mockResolvedValue(respond(status, { error: { message: "raw server text" } }));
    controls();
    await userEvent.selectOptions(roomSelect(), "KITCHEN");
    await userEvent.click(saveButton());

    expect(screen.getByText(expected)).toBeTruthy();
    expect(screen.queryByText("raw server text")).toBeNull();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("renders the API's own message for a 422", async () => {
    fetchMock.mockResolvedValue(
      respond(422, { error: { message: "Order priority must be a whole number above zero" } }),
    );
    controls();
    await userEvent.type(orderInput(), "9");
    await userEvent.click(saveButton());

    expect(
      screen.getByText("Order priority must be a whole number above zero"),
    ).toBeTruthy();
  });

  it("renders the generic message when the request never completes", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));
    controls();
    await userEvent.selectOptions(roomSelect(), "KITCHEN");
    await userEvent.click(saveButton());

    expect(screen.getByText(CORRECTION_ERRORS.generic)).toBeTruthy();
    expect(screen.queryByText("network down")).toBeNull();
  });

  it("keeps the entered values so the save can be retried", async () => {
    fetchMock.mockResolvedValueOnce(respond(500));
    controls();
    await userEvent.selectOptions(roomSelect(), "BALCONY");
    await userEvent.type(orderInput(), "6");
    await userEvent.click(saveButton());

    expect((roomSelect() as HTMLSelectElement).value).toBe("BALCONY");
    expect((orderInput() as HTMLInputElement).value).toBe("6");

    fetchMock.mockResolvedValueOnce(respond(200));
    await userEvent.click(saveButton());

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(lastRequest().body).toEqual({ organizationId: ORG, roomType: "BALCONY", order: 6 });
  });
});

describe("authorization presentation", () => {
  it("renders no correction control when the member may only decide", () => {
    const { container } = controls({ corrections: [] });

    expect(screen.queryByLabelText("Room for a.jpg")).toBeNull();
    expect(screen.queryByRole("button", { name: "Save correction" })).toBeNull();
    expect(container.querySelectorAll("select")).toHaveLength(0);
    // The decision controls are still there and usable.
    expect(approveButton().disabled).toBe(false);
  });

  it("renders no decision control when the member may only correct", () => {
    controls({ members: [] });

    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reject" })).toBeNull();
    expect(screen.getByLabelText("Room for a.jpg")).toBeTruthy();
  });

  it("shows the analyzer's reading beside the control", () => {
    controls({ corrections: [target({ analyzerRoomType: "Bathroom" })] });
    expect(screen.getByText(/Analyzer read this as/)).toBeTruthy();
    expect(screen.getByText("Bathroom")).toBeTruthy();
  });

  it("offers exactly the room options it was given, plus the clear choice", () => {
    controls();
    const options = [...(roomSelect() as HTMLSelectElement).options].map((o) => o.textContent);
    expect(options).toEqual(["Use analyzer result", "Living room", "Kitchen", "Balcony"]);
  });
});
