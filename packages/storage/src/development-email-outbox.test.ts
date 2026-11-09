/**
 * The development outbox (ADR-0126), against real files in a fresh folder per
 * test: what it writes, what it never leaves behind, what it refuses, and that
 * nothing in either application uses it yet.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { outgoingEmail, type OutgoingEmail } from "@app/domain";
import { AppError } from "@app/shared";
import {
  DEVELOPMENT_EMAIL_OUTBOX_FORMAT,
  createDevelopmentEmailOutbox,
  readDevelopmentEmailOutbox,
} from "./development-email-outbox";
import { NonProductionAdapterError } from "./production-guard";

const REPO_ROOT = join(__dirname, "..", "..", "..");

/** Makes the outbox's one rename fail while `on`, as a full disk or a lost folder would. */
const renameFailure = vi.hoisted(() => ({ on: false }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: (from: string, to: string) =>
      renameFailure.on
        ? Promise.reject(Object.assign(new Error("simulated"), { code: "ENOSPC" }))
        : actual.rename(from, to),
  };
});

const VERIFY = outgoingEmail({
  kind: "EMAIL_VERIFICATION",
  to: "owner@example.test",
  subject: "メールアドレスの確認",
  text: "次のリンクを開いてください。\nhttps://app.example.test/verify?token=one-time",
});
const RESET = outgoingEmail({
  kind: "PASSWORD_RESET",
  to: "staff@example.test",
  subject: "パスワードの再設定",
  text: "https://app.example.test/reset?token=one-time",
});

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "outbox-"));
});

afterEach(async () => {
  renameFailure.on = false;
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

function clock(...times: string[]): () => Date {
  let next = 0;
  return () => new Date(times[Math.min(next++, times.length - 1)] ?? "2026-11-09T00:00:00.000Z");
}

describe("sending", () => {
  it("writes each email to its own file, which the reader gives back oldest first", async () => {
    const folder = join(root, "outbox");
    const outbox = createDevelopmentEmailOutbox({
      folder,
      now: clock("2026-11-09T04:00:00.002Z", "2026-11-09T04:00:00.001Z"),
    });
    await outbox.send(RESET);
    await outbox.send(VERIFY);

    const messages = await readDevelopmentEmailOutbox(folder);
    expect(messages.map(({ kind, to, subject, text, sentAt }) => ({ kind, to, subject, text, sentAt }))).toEqual([
      { ...VERIFY, sentAt: new Date("2026-11-09T04:00:00.001Z") },
      { ...RESET, sentAt: new Date("2026-11-09T04:00:00.002Z") },
    ]);
    expect(readdirSync(folder).sort()).toEqual(messages.map(({ file }) => file));
    for (const { id, file } of messages) {
      expect(file).toMatch(/^1794196800\d{3}-[0-9a-f-]{36}\.json$/);
      expect(file.endsWith(`${id}.json`)).toBe(true);
    }
    expect(JSON.parse(readFileSync(join(folder, messages[0]!.file), "utf8"))).toEqual({
      format: DEVELOPMENT_EMAIL_OUTBOX_FORMAT,
      id: messages[0]!.id,
      ...VERIFY,
      sentAt: "2026-11-09T04:00:00.001Z",
    });
  });

  it("keeps the folder it makes, and every message, private to their owner", async () => {
    const folder = join(root, "made", "outbox");
    await createDevelopmentEmailOutbox({ folder }).send(VERIFY);
    expect(statSync(folder).mode & 0o777).toBe(0o700);
    const [file] = readdirSync(folder);
    expect(statSync(join(folder, file!)).mode & 0o777).toBe(0o600);
  });

  it("writes many emails at once to as many files", async () => {
    const outbox = createDevelopmentEmailOutbox({ folder: root, now: clock("2026-11-09T04:00:00.000Z") });
    await Promise.all(Array.from({ length: 20 }, () => outbox.send(VERIFY)));
    const messages = await readDevelopmentEmailOutbox(root);
    expect(messages).toHaveLength(20);
    expect(new Set(messages.map(({ id }) => id)).size).toBe(20);
    expect(readdirSync(root)).toHaveLength(20);
  });

  it("checks the email again, so a cast cannot pass one that was never made", async () => {
    const outbox = createDevelopmentEmailOutbox({ folder: root });
    const forged = { ...VERIFY, to: "owner@example.test\r\nBcc: x@example.test" } as OutgoingEmail;
    await expect(outbox.send(forged)).rejects.toThrow("The email's recipient is not an address mail can be sent to");
    expect(readdirSync(root)).toEqual([]);
  });

  it("leaves no file behind when one cannot be put in place, and says why by code alone", async () => {
    const outbox = createDevelopmentEmailOutbox({ folder: root });
    renameFailure.on = true;
    const failure = await outbox.send(VERIFY).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AppError);
    expect((failure as AppError).message).toBe("The email could not be written to the outbox (ENOSPC)");
    expect(readdirSync(root)).toEqual([]);
  });

  it("says why a file cannot be written by code alone", async () => {
    const folder = join(root, "outbox");
    const outbox = createDevelopmentEmailOutbox({ folder });
    await rm(folder, { recursive: true });
    const failure = await outbox.send(VERIFY).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AppError);
    expect((failure as AppError).message).toBe("The email could not be written to the outbox (ENOENT)");
    expect(existsSync(folder)).toBe(false);
  });
});

describe("refusals", () => {
  it("refuses production when told it is production", () => {
    expect(() => createDevelopmentEmailOutbox({ folder: root, nodeEnv: "production" })).toThrow(
      NonProductionAdapterError,
    );
  });

  it("refuses production when the process runs in production, whatever it is told", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(() => createDevelopmentEmailOutbox({ folder: root, nodeEnv: "test" })).toThrow(NonProductionAdapterError);
  });

  it.each(["", "relative/outbox"])("refuses the folder %j, which is not absolute", (folder) => {
    expect(() => createDevelopmentEmailOutbox({ folder })).toThrow("The email outbox folder must be an absolute path");
  });

  it("refuses a folder it cannot open, naming the code and not the path", async () => {
    const file = join(root, "a-file");
    await writeFile(file, "");
    const failure = (() => {
      try {
        createDevelopmentEmailOutbox({ folder: join(file, "outbox") });
      } catch (error) {
        return error;
      }
      return undefined;
    })();
    expect(failure).toBeInstanceOf(AppError);
    expect((failure as AppError).message).toBe("The email outbox folder could not be opened (ENOTDIR)");
  });
});

describe("reading", () => {
  it("finds no message in a folder not made yet", async () => {
    await expect(readDevelopmentEmailOutbox(join(root, "missing"))).resolves.toEqual([]);
  });

  it("passes over hidden files and files not in a message's form", async () => {
    await createDevelopmentEmailOutbox({ folder: root }).send(VERIFY);
    await writeFile(join(root, ".0b7c5d54-8a0e-4cbb-9d40-3d5d7c0e6f00.tmp"), "half a mess");
    await writeFile(join(root, "README.txt"), "notes");
    const messages = await readDevelopmentEmailOutbox(root);
    expect(messages.map(({ to }) => to)).toEqual(["owner@example.test"]);
  });

  it.each([
    ["not JSON", "{"],
    ["not an object", "null"],
    ["another format", { format: "other/1" }],
    ["an unknown kind", { kind: "NEWSLETTER" }],
    ["a recipient that is not text", { to: 7 }],
    ["a subject that is not text", { subject: null }],
    ["a text that is not text", { text: ["a"] }],
    ["an id that is not text", { id: 1 }],
    ["a time that is not a time", { sentAt: "yesterday" }],
    ["a time not in its own form", { sentAt: "2026-11-09T04:00:00Z" }],
  ])("fails on a message file that is %s, naming the file", async (_reason, change) => {
    const file = "1794196800000-0b7c5d54-8a0e-4cbb-9d40-3d5d7c0e6f00.json";
    const good = {
      format: DEVELOPMENT_EMAIL_OUTBOX_FORMAT,
      id: "0b7c5d54-8a0e-4cbb-9d40-3d5d7c0e6f00",
      ...VERIFY,
      sentAt: "2026-11-09T04:00:00.000Z",
    };
    await writeFile(join(root, file), typeof change === "string" ? change : JSON.stringify({ ...good, ...change }));
    await expect(readDevelopmentEmailOutbox(root)).rejects.toThrow(
      `The outbox file ${file} is not in the outbox's format`,
    );
  });

  it("fails on a folder or a file it cannot read, naming the code and not the path", async () => {
    const file = join(root, "a-file");
    await writeFile(file, "");
    await expect(readDevelopmentEmailOutbox(file)).rejects.toThrow(
      new Error("The email outbox folder could not be read (ENOTDIR)"),
    );
    const name = "1794196800000-0b7c5d54-8a0e-4cbb-9d40-3d5d7c0e6f00.json";
    await mkdir(join(root, "outbox", name), { recursive: true });
    await expect(readDevelopmentEmailOutbox(join(root, "outbox"))).rejects.toThrow(
      new Error(`The outbox file ${name} could not be read (EISDIR)`),
    );
  });

  it("refuses a folder that is not absolute", async () => {
    await expect(readDevelopmentEmailOutbox("relative/outbox")).rejects.toThrow(
      "The email outbox folder must be an absolute path",
    );
  });
});

describe("dormancy", () => {
  /** Comments stripped, so prose naming a symbol is not mistaken for using it. */
  function code(text: string): string {
    return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
  }

  function sourceFiles(dir: string): { name: string; text: string }[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return entry.name === "node_modules" || entry.name === ".next" ? [] : sourceFiles(full);
      if (!/\.tsx?$/.test(entry.name) || entry.name.includes(".test.")) return [];
      return [{ name: full.slice(REPO_ROOT.length + 1), text: code(readFileSync(full, "utf8")) }];
    });
  }

  it("is used by neither application yet, and neither reads its folder's setting", () => {
    const files = sourceFiles(join(REPO_ROOT, "apps"));
    // The scan reaches both applications, including where sign-up is wired.
    const scanned = files.map(({ name }) => name);
    expect(scanned).toContain("apps/web/src/lib/identity.ts");
    expect(scanned).toContain("apps/worker/src/bootstrap.ts");
    const names = ["DevelopmentEmailOutbox", "EMAIL_OUTBOX_DIR", "EmailSender", "outgoingEmail("];
    const users = files.filter(({ text }) => names.some((name) => text.includes(name)));
    expect(users.map(({ name }) => name)).toEqual([]);
  });
});
