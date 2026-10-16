// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MfaPanel } from "./mfa-panel";

const refresh = vi.fn();
const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh, push }) }));

const fetchMock = vi.fn();
const CODES = Array.from({ length: 10 }, (_, i) => `ABCD-EFGH-JKMN-PQ${String(i).padStart(2, "0")}`);

beforeEach(() => {
  fetchMock.mockReset();
  refresh.mockReset();
  push.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function respond(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const wrongCode = (attemptsLeft: number) =>
  respond(422, { error: { code: "VALIDATION_FAILED", message: "That code is not valid", details: { attemptsLeft } } });

function request(index: number): { url: string; body: unknown } {
  const [url, init] = fetchMock.mock.calls[index] as [string, RequestInit];
  return { url, body: init.body === undefined ? undefined : JSON.parse(String(init.body)) };
}

const button = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement;

describe("MFA off", () => {
  it("sets up an authenticator app and shows the recovery codes once", async () => {
    render(<MfaPanel enabled={false} required={false} recoveryCodesLeft={0} />);
    fetchMock.mockResolvedValueOnce(respond(200, { secret: "JBSWY3DPEHPK3PXP", qrCode: "data:image/svg+xml;base64,PHN2Zz4=" }));
    await userEvent.click(button("Set up MFA"));

    expect(request(0)).toEqual({ url: "/api/mfa/setup", body: undefined });
    expect(screen.getByAltText("QR code for your authenticator app").getAttribute("src")).toBe(
      "data:image/svg+xml;base64,PHN2Zz4=",
    );
    expect(screen.getByText("JBSWY3DPEHPK3PXP")).toBeTruthy();
    expect(button("Turn on MFA").disabled).toBe(true);

    fetchMock.mockResolvedValueOnce(wrongCode(4));
    await userEvent.type(screen.getByLabelText("Code from your authenticator app"), "000000");
    await userEvent.click(button("Turn on MFA"));
    expect(screen.getByRole("alert").textContent).toBe("That code is not valid. Attempts left: 4");

    fetchMock.mockResolvedValueOnce(respond(200, { recoveryCodes: CODES }));
    await userEvent.clear(screen.getByLabelText("Code from your authenticator app"));
    await userEvent.type(screen.getByLabelText("Code from your authenticator app"), " 123456 ");
    await userEvent.click(button("Turn on MFA"));
    expect(request(2)).toEqual({ url: "/api/mfa/setup/confirm", body: { code: "123456" } });
    expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toEqual(CODES);
    expect(screen.queryByText("JBSWY3DPEHPK3PXP")).toBeNull();

    await userEvent.click(button("I have saved them"));
    expect(screen.queryByText(CODES[0]!)).toBeNull();
    expect(screen.queryByAltText("QR code for your authenticator app")).toBeNull();
    expect(refresh).toHaveBeenCalledOnce();
    expect(push).not.toHaveBeenCalled();
  });

  it("goes on in once a sign-in that had to set MFA up has saved its recovery codes", async () => {
    render(<MfaPanel enabled={false} required recoveryCodesLeft={0} mustSetUp />);
    fetchMock.mockResolvedValueOnce(respond(200, { secret: "JBSWY3DPEHPK3PXP", qrCode: "data:image/svg+xml;base64,PHN2Zz4=" }));
    await userEvent.click(button("Set up MFA"));
    fetchMock.mockResolvedValueOnce(respond(200, { recoveryCodes: CODES }));
    await userEvent.type(screen.getByLabelText("Code from your authenticator app"), "123456");
    await userEvent.click(button("Turn on MFA"));
    await userEvent.click(button("I have saved them"));
    expect(push).toHaveBeenCalledExactlyOnceWith("/");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("says when the role requires MFA", () => {
    render(<MfaPanel enabled={false} required recoveryCodesLeft={0} />);
    expect(screen.getByText("MFA is off. Your role requires it.")).toBeTruthy();
  });

  it("sends an ended sign-in back to the password", async () => {
    render(<MfaPanel enabled={false} required={false} recoveryCodesLeft={0} />);
    fetchMock.mockResolvedValueOnce(respond(401, { error: { code: "UNAUTHENTICATED", message: "Sign in again" } }));
    await userEvent.click(button("Set up MFA"));
    expect(push).toHaveBeenCalledWith("/login");
    expect(screen.queryByAltText("QR code for your authenticator app")).toBeNull();
  });
});

describe("MFA on", () => {
  it("replaces the recovery codes and shows the new ones once", async () => {
    render(<MfaPanel enabled required={false} recoveryCodesLeft={3} />);
    expect(screen.getByText("Recovery codes left: 3")).toBeTruthy();
    fetchMock.mockResolvedValueOnce(respond(200, { recoveryCodes: CODES }));
    await userEvent.click(button("New recovery codes"));
    expect(request(0)).toEqual({ url: "/api/mfa/recovery-codes", body: undefined });
    expect(screen.getAllByRole("listitem")).toHaveLength(10);
  });

  it("moves MFA to a new device through the same set-up", async () => {
    render(<MfaPanel enabled required={false} recoveryCodesLeft={3} />);
    fetchMock.mockResolvedValueOnce(respond(200, { secret: "KRSXG5A", qrCode: "data:image/svg+xml;base64,AA==" }));
    await userEvent.click(button("Move to a new device"));
    expect(screen.getByText("Move to a new authenticator app")).toBeTruthy();
    await userEvent.click(button("Cancel"));
    expect(screen.getByText("MFA is on.")).toBeTruthy();
  });

  it("turns MFA off with a code", async () => {
    render(<MfaPanel enabled required={false} recoveryCodesLeft={3} />);
    expect(button("Turn off MFA").disabled).toBe(true);
    fetchMock.mockResolvedValueOnce(respond(204));
    await userEvent.type(screen.getByLabelText("Code from your authenticator app"), "654321");
    await userEvent.click(button("Turn off MFA"));
    expect(request(0)).toEqual({ url: "/api/mfa/disable", body: { code: "654321" } });
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("offers no way to turn off MFA the role requires", () => {
    render(<MfaPanel enabled required recoveryCodesLeft={10} />);
    expect(screen.queryByRole("button", { name: "Turn off MFA" })).toBeNull();
    expect(screen.getByText("Your role requires MFA, so it cannot be turned off.")).toBeTruthy();
  });

  it("shows a failure it cannot read as a generic error", async () => {
    render(<MfaPanel enabled required={false} recoveryCodesLeft={3} />);
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    await userEvent.click(button("New recovery codes"));
    expect(screen.getByRole("alert").textContent).toBe("Something went wrong. Try again.");
  });
});
