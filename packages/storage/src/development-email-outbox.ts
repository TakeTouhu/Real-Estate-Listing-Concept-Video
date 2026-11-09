import { randomUUID } from "node:crypto";
import { mkdirSync, realpathSync } from "node:fs";
import { open, readdir, readFile, rename, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { EMAIL_KINDS, outgoingEmail, type EmailKind, type EmailSender, type OutgoingEmail } from "@app/domain";
import { AppError } from "@app/shared";
import { assertNotProduction } from "./production-guard";

/**
 * The development outbox (ADR-0126): every email the product sends, written as
 * one file in a folder on this machine, for a developer or a browser test to
 * read. It delivers nothing, and production refuses it.
 *
 * A message holds one-time links, so a folder the outbox makes is private to
 * its owner, and every file is readable by its owner alone. Nothing here logs a
 * message, its recipient or the folder's path.
 */

/** The `format` of every message file, so a reader refuses a file it does not know. */
export const DEVELOPMENT_EMAIL_OUTBOX_FORMAT = "vtavision-development-email/1";

export interface DevelopmentEmailOutboxOptions {
  /** The folder, absolute; made if it is missing. */
  readonly folder: string;
  /** Injectable for tests; the ambient `NODE_ENV` is asked too. */
  readonly nodeEnv?: string;
  /** Injectable for tests; when a message was sent. */
  readonly now?: () => Date;
}

/** One message as the outbox keeps it. */
export interface DevelopmentOutboxMessage {
  readonly id: string;
  readonly kind: EmailKind;
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly sentAt: Date;
  /** The file's name in the folder. */
  readonly file: string;
}

const MESSAGE_FILE = /^\d{13}-[0-9a-f-]{36}\.json$/;

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : "unknown";
}

/**
 * An `EmailSender` that writes each email to its own file in `folder`, named by
 * the millisecond it was sent and a random id, so the folder lists oldest first
 * (two sent in one millisecond in either order). A file appears whole or not at
 * all: it is written under a hidden temporary name and renamed into place.
 *
 * Refused under `NODE_ENV=production`, given or ambient, and for a folder that
 * is not absolute.
 */
export function createDevelopmentEmailOutbox(options: DevelopmentEmailOutboxOptions): EmailSender {
  // The given value cannot vouch for the ambient one: either says production.
  for (const nodeEnv of [options.nodeEnv, process.env.NODE_ENV]) {
    assertNotProduction(
      "DevelopmentEmailOutbox",
      "it writes every email to a folder on this machine and delivers none",
      "configure a production email service",
      { nodeEnv },
    );
  }
  if (typeof options.folder !== "string" || !isAbsolute(options.folder)) {
    throw new AppError("CONFIGURATION_ERROR", "The email outbox folder must be an absolute path");
  }
  let folder: string;
  try {
    mkdirSync(options.folder, { recursive: true, mode: 0o700 });
    folder = realpathSync(options.folder);
  } catch (error) {
    // The code, never the path.
    throw new AppError("CONFIGURATION_ERROR", `The email outbox folder could not be opened (${errorCode(error)})`);
  }
  const now = options.now ?? (() => new Date());

  return {
    async send(email: OutgoingEmail): Promise<void> {
      // Checked again: the brand is the compiler's promise, and a cast can break it.
      const checked = outgoingEmail(email);
      const id = randomUUID();
      const sentAt = now();
      const body = JSON.stringify({
        format: DEVELOPMENT_EMAIL_OUTBOX_FORMAT,
        id,
        kind: checked.kind,
        to: checked.to,
        subject: checked.subject,
        text: checked.text,
        sentAt: sentAt.toISOString(),
      });
      const temporary = join(folder, `.${id}.tmp`);
      const final = join(folder, `${String(sentAt.getTime()).padStart(13, "0")}-${id}.json`);
      try {
        const handle = await open(temporary, "wx", 0o600);
        try {
          await handle.writeFile(body, "utf8");
        } finally {
          await handle.close();
        }
        await rename(temporary, final);
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => undefined);
        throw new AppError("INTERNAL_ERROR", `The email could not be written to the outbox (${errorCode(error)})`);
      }
    },
  };
}

function parseMessage(file: string, raw: string): DevelopmentOutboxMessage {
  const refuse = (): never => {
    throw new Error(`The outbox file ${file} is not a message this outbox wrote`);
  };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return refuse();
  }
  if (typeof value !== "object" || value === null) return refuse();
  const record = value as Record<string, unknown>;
  const { format, id, kind, to, subject, text, sentAt } = record;
  if (
    format !== DEVELOPMENT_EMAIL_OUTBOX_FORMAT ||
    typeof id !== "string" ||
    typeof kind !== "string" ||
    !(EMAIL_KINDS as readonly string[]).includes(kind) ||
    typeof to !== "string" ||
    typeof subject !== "string" ||
    typeof text !== "string" ||
    typeof sentAt !== "string"
  ) {
    return refuse();
  }
  const sent = new Date(sentAt);
  if (Number.isNaN(sent.getTime()) || sent.toISOString() !== sentAt) return refuse();
  return { id, kind: kind as EmailKind, to, subject, text, sentAt: sent, file };
}

/**
 * Every message in the outbox folder, oldest first, for tests and developers.
 * A folder not made yet holds none. A file in the message files' form that is
 * not a message this outbox wrote fails the read, naming the file; hidden files,
 * such as a message still being written, are passed over.
 */
export async function readDevelopmentEmailOutbox(folder: string): Promise<DevelopmentOutboxMessage[]> {
  if (!isAbsolute(folder)) throw new Error("The email outbox folder must be an absolute path");
  let names: string[];
  try {
    names = await readdir(folder);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return [];
    throw error;
  }
  const files = names.filter((name) => MESSAGE_FILE.test(name)).sort();
  return Promise.all(files.map(async (file) => parseMessage(file, await readFile(join(folder, file), "utf8"))));
}
