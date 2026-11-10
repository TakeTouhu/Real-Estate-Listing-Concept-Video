import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { outgoingEmail } from "@app/domain";
import { readDevelopmentEmailOutbox } from "@app/storage";

/**
 * The web app's one mailer (AT-4c, ADR-0133): the development outbox and links
 * on `APP_BASE_URL`, both refused with `CONFIGURATION_ERROR`, writing nothing,
 * when either setting is unset.
 */
const env = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock("@/lib/env", () => ({ getServerEnv: () => env.value }));

const { getMailer, tokenLink } = await import("./mailer");

const BASE = "http://localhost:3210";
let outbox: string;

beforeEach(() => {
  outbox = mkdtempSync(join(tmpdir(), "vtavision-outbox-mailer-"));
});

afterEach(() => {
  rmSync(outbox, { recursive: true, force: true });
});

const message = () =>
  outgoingEmail({ kind: "PASSWORD_RESET", to: "user@example.com", subject: "Subject", text: "Text" });

describe("the mailer", () => {
  it("writes to the outbox and builds links on the base address", async () => {
    env.value = { NODE_ENV: "test", EMAIL_OUTBOX_DIR: outbox, APP_BASE_URL: BASE };
    await getMailer().send(message());
    expect((await readDevelopmentEmailOutbox(outbox)).map((mail) => mail.to)).toEqual(["user@example.com"]);
    expect(getMailer().link("/reset-password", "a+b")).toBe(`${BASE}/reset-password?token=a%2Bb`);
    expect(tokenLink("https://app.example/x/", "/verify-email", "t")).toBe("https://app.example/verify-email?token=t");
  });

  it("refuses to send or build a link, writing nothing, when either setting is unset", async () => {
    for (const unset of ["EMAIL_OUTBOX_DIR", "APP_BASE_URL"]) {
      env.value = { NODE_ENV: "test", EMAIL_OUTBOX_DIR: outbox, APP_BASE_URL: BASE, [unset]: undefined };
      await expect(getMailer().send(message())).rejects.toMatchObject({ code: "CONFIGURATION_ERROR" });
      expect(() => getMailer().link("/reset-password", "t")).toThrow("Email cannot be sent right now");
    }
    expect(await readDevelopmentEmailOutbox(outbox)).toEqual([]);
  });
});
