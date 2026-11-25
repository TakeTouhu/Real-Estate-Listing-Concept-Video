// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UploadPanel } from "./upload-panel";

const ORG = "org_1";
const PROPERTY = "prp_1";
const ASSET = "ast_1";

function respond(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** Every PUT the panel sends, and the HTTP status each next PUT answers. */
const puts: { url: string; body: unknown }[] = [];
let putStatuses: number[] = [];

class FakeXhr {
  status = 0;
  private url = "";
  private readonly listeners = new Map<string, () => void>();
  readonly upload = { addEventListener: () => undefined };
  open(_method: string, url: string): void {
    this.url = url;
  }
  addEventListener(type: string, listener: () => void): void {
    this.listeners.set(type, listener);
  }
  send(body: unknown): void {
    puts.push({ url: this.url, body });
    this.status = putStatuses.shift() ?? 200;
    queueMicrotask(() => this.listeners.get("load")?.());
  }
}

/** The routes the panel asks, by path, and what each answers in turn. */
const fetchMock = vi.fn();
function routes(answers: Record<string, Response[]>): void {
  fetchMock.mockImplementation((url: string) => {
    const path = Object.keys(answers).find((key) => url.endsWith(key));
    const next = path === undefined ? undefined : answers[path]?.shift();
    return Promise.resolve(next ?? respond(500, { error: { message: `unexpected ${url}` } }));
  });
}
const asked = (): string[] => fetchMock.mock.calls.map(([url]) => String(url));

const file = new File([new Uint8Array([0xff, 0xd8, 0xff])], "room.jpg", { type: "image/jpeg" });

async function choose(): Promise<void> {
  const { container } = render(<UploadPanel organizationId={ORG} propertyId={PROPERTY} remainingSlots={20} />);
  const input = container.querySelector<HTMLInputElement>('input[type="file"]');
  await userEvent.upload(input!, file);
}

const started = () => respond(200, { assetId: ASSET, uploadUrl: "/signed/first" });

beforeEach(() => {
  fetchMock.mockReset();
  puts.length = 0;
  putStatuses = [];
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("XMLHttpRequest", FakeXhr);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** Retry tries the same photo, never a new one, so it takes no new place among the Property's photos. */
describe("the upload panel's Retry", () => {
  it("checks a photo the server failed again from its stored bytes, sending nothing", async () => {
    routes({
      "/upload-url": [started()],
      [`/${ASSET}/complete`]: [
        respond(200, { status: "FAILED", failureReason: "Malware scan could not be completed" }),
        respond(200, { status: "READY" }),
      ],
    });
    await choose();
    await screen.findByText("Malware scan could not be completed");
    await userEvent.click(screen.getByRole("button", { name: "Retry upload" }));
    await screen.findByText("ready");
    expect(asked()).toEqual([
      `/api/properties/${PROPERTY}/assets/upload-url`,
      `/api/assets/${ASSET}/complete`,
      `/api/assets/${ASSET}/complete`,
    ]);
    expect(puts).toHaveLength(1);
  });

  it("sends the kept file to the same photo's new link when its bytes never arrived", async () => {
    putStatuses = [503];
    routes({
      "/upload-url": [started()],
      [`/${ASSET}/retry`]: [respond(200, { assetId: ASSET, status: "PENDING_UPLOAD", uploadUrl: "/signed/again" })],
      [`/${ASSET}/complete`]: [respond(200, { status: "READY" })],
    });
    await choose();
    await screen.findByText("Upload failed with status 503");
    await userEvent.click(screen.getByRole("button", { name: "Retry upload" }));
    await screen.findByText("ready");
    expect(asked()).toEqual([
      `/api/properties/${PROPERTY}/assets/upload-url`,
      `/api/assets/${ASSET}/retry`,
      `/api/assets/${ASSET}/complete`,
    ]);
    expect(puts.map(({ url }) => url)).toEqual(["/signed/first", "/signed/again"]);
    // The very file the owner chose, both times.
    expect(puts[0]?.body).toBe(file);
    expect(puts[1]?.body).toBe(file);
  });

  it("sends the file again when the stored bytes could not be checked", async () => {
    routes({
      "/upload-url": [started()],
      [`/${ASSET}/complete`]: [
        respond(400, { error: { message: "Uploaded object was not found in storage" } }),
        respond(200, { status: "READY" }),
      ],
      [`/${ASSET}/retry`]: [respond(200, { assetId: ASSET, status: "PENDING_UPLOAD", uploadUrl: "/signed/again" })],
    });
    await choose();
    await screen.findByText("Uploaded object was not found in storage");
    await userEvent.click(screen.getByRole("button", { name: "Retry upload" }));
    await screen.findByText("ready");
    expect(asked().filter((url) => url.endsWith("/upload-url"))).toHaveLength(1);
    expect(puts.map(({ url }) => url)).toEqual(["/signed/first", "/signed/again"]);
  });

  it("sends the file again on the next retry when a check of the stored bytes finds them gone", async () => {
    routes({
      "/upload-url": [started()],
      [`/${ASSET}/complete`]: [
        respond(200, { status: "FAILED", failureReason: "Malware scan could not be completed" }),
        respond(400, { error: { message: "Uploaded object was not found in storage" } }),
        respond(200, { status: "READY" }),
      ],
      [`/${ASSET}/retry`]: [respond(200, { assetId: ASSET, status: "PENDING_UPLOAD", uploadUrl: "/signed/again" })],
    });
    await choose();
    await screen.findByText("Malware scan could not be completed");
    await userEvent.click(screen.getByRole("button", { name: "Retry upload" }));
    await screen.findByText("Uploaded object was not found in storage");
    await userEvent.click(screen.getByRole("button", { name: "Retry upload" }));
    await screen.findByText("ready");
    const steps = ["upload-url", "complete", "complete", "retry", "complete"];
    expect(asked().map((url) => url.split("/").pop())).toEqual(steps);
    expect(puts.map(({ url }) => url)).toEqual(["/signed/first", "/signed/again"]);
  });

  it("checks the stored bytes again, sending nothing, when a rate limit refused their check (ADR-0173)", async () => {
    const limited = "Too many uploads. Try again in 3 hours.";
    routes({
      "/upload-url": [started()],
      [`/${ASSET}/complete`]: [respond(429, { error: { message: limited } }), respond(200, { status: "READY" })],
    });
    await choose();
    await screen.findByText(limited);
    await userEvent.click(screen.getByRole("button", { name: "Retry upload" }));
    await screen.findByText("ready");
    expect(asked().map((url) => url.split("/").pop())).toEqual(["upload-url", "complete", "complete"]);
    expect(puts).toHaveLength(1);
  });

  it.each([
    ["QUARANTINED", "Malware scan flagged this file"],
    ["REJECTED", "Unsupported or mismatched file type"],
  ])("is not offered for a %s photo, which the server will not try again", async (status, failureReason) => {
    routes({ "/upload-url": [started()], [`/${ASSET}/complete`]: [respond(200, { status, failureReason })] });
    await choose();
    await screen.findByText(failureReason);
    expect(screen.queryByRole("button", { name: "Retry upload" })).toBeNull();
  });

  it("is offered again when a retry fails", async () => {
    routes({
      "/upload-url": [started()],
      [`/${ASSET}/complete`]: [
        respond(200, { status: "FAILED", failureReason: "Malware scan could not be completed" }),
        respond(200, { status: "FAILED", failureReason: "Malware scan could not be completed" }),
      ],
    });
    await choose();
    await screen.findByText("Malware scan could not be completed");
    await userEvent.click(screen.getByRole("button", { name: "Retry upload" }));
    await waitFor(() => expect(asked()).toHaveLength(3));
    expect(await screen.findByRole("button", { name: "Retry upload" })).toBeTruthy();
  });
});
