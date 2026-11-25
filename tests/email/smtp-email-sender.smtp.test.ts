import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { EMAIL_TEXT_MAX_LENGTH, outgoingEmail, type OutgoingEmail } from "@app/domain";
import { createSmtpEmailSender, type SmtpEmailSenderOptions } from "@app/storage/smtp";
import {
  MAILPIT_CERTIFICATE_NAME,
  MAILPIT_HOST,
  mailpitApiPort,
  mailpitCertificate,
  mailpitSmtpPort,
  messagesTo,
  rawMessage,
} from "./smtp";

/** Read as the file loads, so a run without Mailpit's ports fails before any test runs. */
const SMTP_PORT = mailpitSmtpPort();
const API_PORT = mailpitApiPort();
const FROM = "noreply@rd6.test";

/** The certificate Mailpit made for itself: the only authority any send here trusts. */
let mailpitCa = "";
beforeAll(async () => {
  mailpitCa = await mailpitCertificate(SMTP_PORT);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/** A recipient no other test, or run, writes to, so what Mailpit holds for it is this test's alone. */
const recipient = (): string => `rd6b-${randomUUID()}@rd6.test`;

/** Everything a send needs but the authority to trust. */
const settings = (): SmtpEmailSenderOptions => ({
  host: MAILPIT_HOST,
  port: SMTP_PORT,
  tls: "starttls",
  servername: MAILPIT_CERTIFICATE_NAME,
  // Mailpit accepts any user and password; these are throwaway values, not a credential.
  user: "rd6b-user",
  password: "rd6b-throwaway",
  from: FROM,
  ehloName: "app.rd6.test",
});

/** A sender trusting Mailpit's certificate alone. */
const sender = (overrides: Partial<SmtpEmailSenderOptions> = {}) =>
  createSmtpEmailSender({ ...settings(), ca: mailpitCa, ...overrides });

const email = (to: string, subject: string, text: string): OutgoingEmail =>
  outgoingEmail({ kind: "EMAIL_VERIFICATION", to, subject, text });

/** `null` when the send resolved, else the rejection as `CODE: message`. */
async function outcome(sending: Promise<void>): Promise<string | null> {
  try {
    await sending;
    return null;
  } catch (error) {
    const { code, message } = error as { code: string; message: string };
    return `${code}: ${message}`;
  }
}

/** What a body reads as once stored: lines broken by CRLF on the wire, and the final break Mailpit keeps. */
const asStored = (text: string): string => text.replace(/\r\n/g, "\n").replace(/\n$/, "");

/** The one message Mailpit holds for `to`, and the raw form it arrived in. */
async function theOneMessageTo(to: string) {
  const messages = await messagesTo(API_PORT, to);
  expect(messages).toHaveLength(1);
  const [message] = messages;
  if (message === undefined) throw new Error("unreachable");
  return { message, raw: await rawMessage(API_PORT, message.ID) };
}

/** No line of the raw message over SMTP's limit, and none outside seven-bit text. */
function expectSevenBitShortLines(raw: string): void {
  const lines = raw.split("\r\n");
  expect(lines.every((line) => line.length <= 998)).toBe(true);
  expect([...raw].every((character) => character.charCodeAt(0) < 0x80)).toBe(true);
}

/** A port on this machine nothing listens on. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  await new Promise((done) => server.close(done));
  return port;
}

/** The SMTP email sender against Mailpit (ADR-0166), STARTTLS required and its certificate pinned. */
describe("the SMTP email sender against Mailpit", () => {
  it("delivers one email over STARTTLS to its one recipient, Japanese, an emoji and dot lines intact", async () => {
    const to = recipient();
    const subject = "【VTaVision】メールアドレスの確認をお願いします 🏠";
    const text = [
      "こんにちは。",
      "下のリンクから、メールアドレスを確認してください。",
      `https://app.rd6.test/verify?token=${"x".repeat(1_100)}`,
      ".",
      ".で始まる行",
      "From the team",
      "末尾に空白   ",
      "🏡 ありがとうございます。",
    ].join("\n");

    expect(await outcome(sender().send(email(to, subject, text)))).toBeNull();

    const { message, raw } = await theOneMessageTo(to);
    expect(message.From).toEqual({ Name: "", Address: FROM });
    expect(message.To).toEqual([{ Name: "", Address: to }]);
    expect([message.Cc ?? [], message.Bcc ?? [], message.ReplyTo ?? []]).toEqual([[], [], []]);
    expect(message.Subject).toBe(subject);
    expect(asStored(message.Text)).toBe(text);
    expect(message.HTML).toBe("");
    expect(message.Attachments).toEqual([]);
    expectSevenBitShortLines(raw);
    expect(raw).toMatch(/^Subject: =\?UTF-8\?/m);
    expect(raw).not.toMatch(/^(?:Cc|Bcc|X-Mailer):/im);
  });

  it("carries a body of the longest length the product sends, on one line, whole", async () => {
    const to = recipient();
    const text = `${"a".repeat(EMAIL_TEXT_MAX_LENGTH / 2)}${"日本".repeat(EMAIL_TEXT_MAX_LENGTH / 4)}`;
    expect(Array.from(text)).toHaveLength(EMAIL_TEXT_MAX_LENGTH);

    expect(await outcome(sender().send(email(to, "長い本文", text)))).toBeNull();

    const { message, raw } = await theOneMessageTo(to);
    expect(asStored(message.Text)).toBe(text);
    expectSevenBitShortLines(raw);
    expect(raw).toMatch(/^Content-Transfer-Encoding: (?:quoted-printable|base64)$/im);
  });

  it("refuses Mailpit when its certificate is not trusted, and nothing arrives", async () => {
    const to = recipient();
    // The machine's own authorities, as in production: none of them signed Mailpit's certificate.
    const untrusting = createSmtpEmailSender(settings());
    expect(await outcome(untrusting.send(email(to, "Not trusted", "Not sent.")))).toBe(
      "PROVIDER_ERROR: The email was not accepted for delivery (ESOCKET)",
    );
    expect(await messagesTo(API_PORT, to)).toEqual([]);
  });

  it("refuses the pinned certificate under another name, and nothing arrives", async () => {
    const to = recipient();
    expect(await outcome(sender({ servername: "other.rd6.test" }).send(email(to, "Wrong name", "Not sent.")))).toBe(
      "PROVIDER_ERROR: The email was not accepted for delivery (ESOCKET)",
    );
    expect(await messagesTo(API_PORT, to)).toEqual([]);
  });

  it("does not fall back to plain text when told the server speaks TLS from its first byte", async () => {
    const to = recipient();
    const result = await outcome(
      sender({ tls: "implicit", limitsMs: { greeting: 2_000 } }).send(email(to, "Wrong mode", "Not sent.")),
    );
    expect(result).toMatch(/^PROVIDER_ERROR: The email was not accepted for delivery \((ESOCKET|ETIMEDOUT)\)$/);
    expect(await messagesTo(API_PORT, to)).toEqual([]);
  });

  it("rejects a send no server answers, naming only a code", async () => {
    const port = await closedPort();
    expect(await outcome(sender({ port }).send(email(recipient(), "Nobody there", "Not sent.")))).toBe(
      // Refused at once, so the socket's own error, not the connection limit.
      "PROVIDER_ERROR: The email was not accepted for delivery (ESOCKET)",
    );
  });
});

/** The suite's own settings: it runs against this machine's Mailpit, or not at all. */
describe("the suite's settings", () => {
  it("fails, rather than guessing, when a port is unset or not a port", () => {
    for (const name of ["MAILPIT_TEST_SMTP_PORT", "MAILPIT_TEST_API_PORT"] as const) {
      const read = name === "MAILPIT_TEST_SMTP_PORT" ? mailpitSmtpPort : mailpitApiPort;
      for (const value of [undefined, "", "smtp", "0", "65536", "25.5"]) {
        vi.stubEnv(name, value);
        expect(read).toThrow(`Set ${name} to Mailpit's`);
      }
      vi.unstubAllEnvs();
    }
  });

  it("reads Mailpit on 127.0.0.1 alone: no host comes from the environment", () => {
    const helper = readFileSync(new URL("./smtp.ts", import.meta.url), "utf8");
    const suite = readFileSync(new URL(import.meta.url), "utf8");
    expect(MAILPIT_HOST).toBe("127.0.0.1");
    expect(helper.match(/process\.env\[?[^;\n]*/g)).toEqual(["process.env[name]"]);
    // No other way to the environment, in the helper or here, and every connection is to MAILPIT_HOST.
    for (const source of [helper, suite]) expect(source).not.toMatch(/node:proc[e]ss|process\[|\benv\./);
    expect(helper.match(/\bhost: [^,}]+/g)).toEqual(["host: MAILPIT_HOST", "host: MAILPIT_HOST", "host: MAILPIT_HOST"]);
    expect([...helper.matchAll(/portFrom\("([A-Z_]+)"/g)].map(([, name]) => name)).toEqual([
      "MAILPIT_TEST_SMTP_PORT",
      "MAILPIT_TEST_API_PORT",
    ]);
  });
});
