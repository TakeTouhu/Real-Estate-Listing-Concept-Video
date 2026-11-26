import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { outgoingEmail } from "@app/domain";
import { AppError, serverEnvSchema, type ServerEnv } from "@app/shared";
import type { SmtpEmailSenderOptions } from "@app/storage/smtp";
import { chooseWebAdapters } from "./adapter-choice";
import { createWebAdapters, emailFailureCode } from "./adapters";

/**
 * The web app's email sender when `SMTP_HOST` names a server (ADR-0168). A file of its own, so this mock stays out
 * of the other adapter tests. No connection is made, so no name is looked up.
 */
const built = vi.hoisted(() => ({ options: [] as unknown[], send: vi.fn<(email: unknown) => Promise<void>>() }));
vi.mock("@app/storage/smtp", async (importOriginal) => {
  const real = await importOriginal<typeof import("@app/storage/smtp")>();
  return {
    ...real,
    // The real builder runs too, so a setting the schema takes and the adapter refuses fails here.
    createSmtpEmailSender: (options: SmtpEmailSenderOptions) => {
      real.createSmtpEmailSender(options);
      built.options.push(options);
      return { send: built.send };
    },
  };
});

const base = {
  SESSION_SECRET: "session-secret-abcdef123456",
  HEALTHCHECK_API_TOKEN: "healthcheck-token-abcdef123456",
  STORAGE_SIGNING_SECRET: "storage-signing-secret-abc",
  NODE_ENV: "test",
};
/** Throwaway values: the password is not a secret. */
const SMTP = {
  SMTP_HOST: "smtp.example.com",
  SMTP_PORT: "2525",
  SMTP_TLS: "starttls",
  SMTP_USER: "smtp-user",
  SMTP_PASSWORD: "smtp-password-not-a-secret",
  SMTP_EHLO_NAME: "app.example.com",
  EMAIL_FROM: "noreply@example.com",
};
const parse = (settings: Record<string, string> = {}): ServerEnv =>
  serverEnvSchema.parse({ ...base, ...SMTP, ...settings });
const email = () =>
  outgoingEmail({ kind: "EMAIL_VERIFICATION", to: "owner@example.test", subject: "Verify", text: "Hello." });

/** What was logged while `run` ran, each line parsed. */
async function logged(run: () => Promise<void>): Promise<Record<string, unknown>[]> {
  const lines: Record<string, unknown>[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((line: string) => lines.push(JSON.parse(line)));
  try {
    await run();
  } finally {
    spy.mockRestore();
  }
  return lines;
}

beforeEach(() => {
  built.options.length = 0;
  built.send.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the SMTP email sender in the web app", () => {
  it("is chosen by SMTP_HOST, before the outbox, which is chosen by its folder, and else none", () => {
    expect(chooseWebAdapters(parse()).email).toBe("smtp");
    const outbox = serverEnvSchema.parse({ ...base, EMAIL_OUTBOX_DIR: "/var/tmp/vtavision-outbox" });
    expect(chooseWebAdapters(outbox).email).toBe("outbox");
    expect(chooseWebAdapters(serverEnvSchema.parse(base)).email).toBe("none");
    // The schema refuses both; a hand-built environment with both still chooses the server.
    expect(chooseWebAdapters({ ...parse(), EMAIL_OUTBOX_DIR: "/var/tmp/vtavision-outbox" }).email).toBe("smtp");
  });

  it("is built for each email, from exactly the seven settings, the port as a number", () => {
    const adapters = createWebAdapters(parse());
    expect(adapters.email()).not.toBe(adapters.email());
    const expected = {
      host: "smtp.example.com",
      port: 2525,
      tls: "starttls",
      user: "smtp-user",
      password: "smtp-password-not-a-secret",
      from: "noreply@example.com",
      ehloName: "app.example.com",
    };
    expect(built.options).toEqual([expected, expected]);
  });

  it("is built from any environment the schema takes", () => {
    const settings: Record<string, string>[] = [
      { SMTP_TLS: "implicit", SMTP_PORT: "465" },
      { SMTP_HOST: `${"a".repeat(63)}.${"b".repeat(63)}.example.com`, SMTP_PORT: "1" },
      { EMAIL_FROM: "no.reply+vtavision@mail.example.co.jp", SMTP_PORT: "65535" },
    ];
    for (const setting of settings) expect(createWebAdapters(parse(setting)).email()).not.toBeNull();
    expect(built.options).toHaveLength(3);
  });

  it("is a production adapter: built where both NODE_ENV values say production", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(createWebAdapters(parse({ NODE_ENV: "production" })).email()).not.toBeNull();
    expect(built.options).toHaveLength(1);
  });

  it("refuses to fill in a setting a hand-built environment left out, and builds nothing", () => {
    for (const name of Object.keys(SMTP).slice(1)) {
      const adapters = createWebAdapters({ ...parse(), [name]: undefined });
      expect(adapters.choice.email).toBe("smtp");
      expect(() => adapters.email()).toThrow(
        new AppError("CONFIGURATION_ERROR", "SMTP is chosen without each of its settings"),
      );
    }
    expect(built.options).toEqual([]);
  });

  it("logs a send that rejects by its code alone, and the flow gets the same rejection", async () => {
    const failure = new AppError("PROVIDER_ERROR", "535 MARKER owner@example.test smtp-password-not-a-secret", {
      details: { smtpCode: "EAUTH" },
    });
    built.send.mockRejectedValue(failure);
    const sender = createWebAdapters(parse()).email();
    let thrown: unknown;
    const lines = await logged(async () => {
      thrown = await sender?.send(email()).catch((error: unknown) => error);
    });
    expect(thrown).toBe(failure);
    const line = { severity: "WARNING", component: "email", message: "An email was not accepted for delivery" };
    expect(lines).toEqual([{ ...line, code: "EAUTH", time: expect.any(String) }]);
    for (const shown of ["MARKER", "owner@example.test", "smtp-password-not-a-secret", "535"]) {
      expect(JSON.stringify(lines)).not.toContain(shown);
    }
  });

  it("logs nothing for a send that is accepted", async () => {
    built.send.mockResolvedValue(undefined);
    const sender = createWebAdapters(parse()).email();
    expect(await logged(async () => sender?.send(email()))).toEqual([]);
    expect(built.send).toHaveBeenCalledTimes(1);
  });

  it("rejects with the send's own error when the log cannot be written", async () => {
    const failure = new AppError("PROVIDER_ERROR", "The email was not accepted for delivery (ESOCKET)", {
      details: { smtpCode: "ESOCKET" },
    });
    built.send.mockRejectedValue(failure);
    const spy = vi.spyOn(console, "log").mockImplementation(() => {
      throw new Error("the log is closed");
    });
    try {
      await expect(createWebAdapters(parse()).email()?.send(email())).rejects.toBe(failure);
    } finally {
      spy.mockRestore();
    }
  });

  it("names a failure by the sender's code only when it is one plain word, and UNEXPECTED otherwise", () => {
    const failed = (details?: Record<string, unknown>) => new AppError("PROVIDER_ERROR", "failed", { details });
    for (const code of ["EAUTH", "ETIMEDOUT", "UNKNOWN", "A".repeat(40)]) {
      expect(emailFailureCode(failed({ smtpCode: code }))).toBe(code);
    }
    const others = [
      new Error("535 MARKER"),
      Object.assign(new Error("x"), { code: "EAUTH" }),
      failed(),
      failed({ code: "EAUTH" }),
      ...["535 5.7.8 MARKER", "eauth", "A".repeat(41), "", "E AUTH"].map((smtpCode) => failed({ smtpCode })),
      failed({ smtpCode: 535 }),
      "EAUTH",
      undefined,
    ];
    for (const error of others) expect(emailFailureCode(error)).toBe("UNEXPECTED");
  });
});
