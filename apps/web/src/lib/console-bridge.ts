import { types } from "node:util";

import { createLogger, redact } from "@app/observability";
import { failureDigest, failureFields } from "./failure-log";

/**
 * Texts a line may carry, by exact equality, so none can hold a value: a new
 * entry is a reviewed change (ADR-0186 Decision 3). nodemailer's warning, where
 * its host finds no address of a family it can use (`dist/cjs/shared/index.js:272`).
 */
const TEXTS: ReadonlySet<string> = new Set([
  "Failed to resolve IPv4 addresses with current network",
  "Failed to resolve IPv6 addresses with current network",
]);
/** At most this many frames per line, and this many characters per frame (ADR-0186 Decision 2). */
const MAX_FRAMES = 50;
const MAX_FRAME_LENGTH = 400;
/** Lines read after the header, and the longest tested as a frame, so the test stays fast on any text. */
const MAX_LINES = 200;
const MAX_LINE_LENGTH = 1000;
/** Where V8 says a frame ran: a file or URL with line and column, `native`, `<anonymous>` or a promise's index. */
const PLACE = String.raw`(?:[^\s\p{Cc}][^\p{Cc}]*:\d+:\d+|native|<anonymous>|index \d+)`;
/**
 * One frame as V8 writes it, trimmed: `at `, then a place, or a name and a
 * place in brackets, with no control character. A line of free text that does
 * not end in a place is not a frame (ADR-0186 Decision 2).
 */
const FRAME = new RegExp(String.raw`^at (?:[^\s\p{Cc}][^\p{Cc}]* \(${PLACE}\)|${PLACE})$`, "u");

/** The two methods the bridge replaces, on the global console or a test's own. */
export interface BridgedConsole {
  error: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
}

/** A frame's URLs through `redact`, word by word, then cut to its bound. */
const scrubbed = (frame: string): string =>
  frame
    .split(/([\s()]+)/)
    .map((part) => String(redact(part)))
    .join("")
    .slice(0, MAX_FRAME_LENGTH);

/**
 * What follows the stack's header. V8 writes the header as the error's
 * `toString()`, Node.js as `Name [ERR_CODE]: message` for its own coded errors
 * (`Name [ERR_CODE]: ` or `Name [ERR_CODE]` when the message is empty), and
 * puts a script's place, source line and caret, then a blank line, before the
 * header of an error thrown out of `vm`. Anything else gives nothing.
 */
function afterHeader(error: object, stack: string): string | undefined {
  const header = Error.prototype.toString.call(error);
  const { name, code } = error as { readonly name?: unknown; readonly code?: unknown };
  const named = name === undefined ? "Error" : String(name);
  const heads = [header];
  if (typeof code === "string" && /^ERR_[A-Z0-9_]+$/.test(code) && (header + ":").startsWith(`${named}:`)) {
    const coded = `${named} [${code}]${header.slice(named.length)}`;
    heads.push(coded, ...(header === named ? [`${coded}: `] : []));
  }
  for (const head of heads) {
    if (stack.startsWith(`${head}\n`)) return stack.slice(head.length + 1);
    const at = stack.indexOf(`\n\n${head}\n`);
    if (at !== -1) return stack.slice(at + head.length + 3);
  }
  return undefined;
}

/**
 * The frames of the error's stack, never its message. Only the part after the
 * exact header is read, since a message of several lines can hold lines that
 * look like frames; a stack without the header gives none. Text that still
 * follows the header, as after a message shortened to a prefix once the stack
 * was read, is kept only where it reads as a frame, place and all (ADR-0186
 * Decision 2).
 */
export function stackFrames(error: object): string[] {
  try {
    const { stack } = error as { readonly stack?: unknown };
    const rest = typeof stack === "string" ? afterHeader(error, stack) : undefined;
    if (rest === undefined) return [];
    return rest
      .split("\n", MAX_LINES)
      .map((line) => line.trim())
      .filter((line) => line.length <= MAX_LINE_LENGTH && FRAME.test(line))
      .slice(0, MAX_FRAMES)
      .map(scrubbed);
  } catch {
    return [];
  }
}

/**
 * An error of this realm, as Prisma's are whatever their tag, or a real error
 * from another realm, as Node.js tells by the object itself; never a plain
 * object, whatever its tag says.
 */
function isError(value: unknown): value is object {
  try {
    return value instanceof Error || types.isNativeError(value);
  } catch {
    return false;
  }
}

/**
 * The fields of one call: the method, an allowed text and, of the first
 * argument that is an error, its name, code, cause's name, digest of digits
 * and stack frames. Every other argument is dropped.
 */
function consoleFields(method: "error" | "warn", args: readonly unknown[]): Record<string, unknown> {
  const text = args.find((arg): arg is string => typeof arg === "string" && TEXTS.has(arg));
  const said = { method, ...(text === undefined ? {} : { text }) };
  const error = args.find(isError);
  if (error === undefined) return said;
  const digest = failureDigest(error);
  const frames = stackFrames(error);
  return {
    ...said,
    ...failureFields(error),
    ...(digest === undefined ? {} : { digest }),
    ...(frames.length === 0 ? {} : { frames }),
  };
}

const installed = new WeakMap<BridgedConsole, () => void>();
/** True while a line is being built: a call made by reading an argument writes `method` alone, so no call recurses. */
let busy = false;

function fieldsOnce(method: "error" | "warn", args: readonly unknown[]): Record<string, unknown> {
  if (busy) return { method };
  busy = true;
  try {
    return consoleFields(method, args);
  } finally {
    busy = false;
  }
}

/**
 * Replace `console.error` and `console.warn` with functions that write one JSON
 * line through the logger, component `console`, and return (ADR-0186). The
 * raw line is gone: nothing is passed on. The logger's sink is `console.log`,
 * which is not replaced, so a line cannot come back here. Never throws.
 * Installing on a console twice changes nothing and gives the first restore,
 * which puts the original methods back while the bridge's are still in place.
 */
export function installConsoleBridge(target: BridgedConsole = console, sink?: (line: string) => void): () => void {
  const existing = installed.get(target);
  if (existing !== undefined) return existing;
  const log = createLogger({ base: { component: "console" }, ...(sink === undefined ? {} : { sink }) });
  const original = { error: target.error, warn: target.warn };
  const bridge: BridgedConsole = {
    error: (...args) => {
      try {
        log.error("The web server printed an error", fieldsOnce("error", args));
      } catch {
        // The caller goes on whether or not the line could be written.
      }
    },
    warn: (...args) => {
      try {
        log.warn("The web server printed a warning", fieldsOnce("warn", args));
      } catch {
        // The caller goes on whether or not the line could be written.
      }
    },
  };
  target.error = bridge.error;
  target.warn = bridge.warn;
  const restore = (): void => {
    if (installed.get(target) !== restore) return;
    installed.delete(target);
    if (target.error === bridge.error) target.error = original.error;
    if (target.warn === bridge.warn) target.warn = original.warn;
  };
  installed.set(target, restore);
  return restore;
}
