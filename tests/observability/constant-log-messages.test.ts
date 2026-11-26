import { readFileSync, readdirSync } from "node:fs";
import { join, sep } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * A log message is a constant (ADR-0182). Every call `x.debug(...)`,
 * `x.info(...)`, `x.warn(...)` or `x.error(...)` in the source of an app or a
 * package, `x` being anything but the identifier `console`, takes a string
 * literal or a template with no substitution as its first argument. The file
 * is read as TypeScript parses it, so a comment or a string never counts. The
 * guard is broad on purpose: it does not ask whether `x` is a `Logger`, so a
 * call on anything else that is not a constant is listed below, exactly, by
 * its file and its own text. An entry nothing matches fails. A callee or a
 * message in parentheses, `as` or `satisfies` is read through them, and
 * `x.error.call(t, msg)` and `x.error.apply(t, [msg])` are read as `x.error(msg)`.
 *
 * Not seen: a method read into a name (`const f = log.error`, or
 * `const { error } = log`), by element access (`log["error"]`), bound
 * (`log.error.bind(log)(msg)`) or passed as a callback (`xs.forEach(log.info)`).
 */
const NOT_A_LOG: Readonly<Record<string, readonly string[]>> = {
  // A ReadableStream's controller fails the stream with an error object.
  "packages/storage/src/google-cloud-storage/google-cloud-storage.ts": [
    "controller.error(new GoogleCloudStorageError(code))",
  ],
  "packages/storage/src/shared-folder-storage.ts": [
    'controller.error(new AppError("INTERNAL_ERROR", message))',
    'controller.error(new AppError("INTERNAL_ERROR", "A stored object ended before its size"))',
  ],
};

const ROOT = join(__dirname, "..", "..");
const METHODS = new Set(["debug", "info", "warn", "error"]);

interface Call {
  readonly file: string;
  readonly text: string;
  readonly constant: boolean;
}

/** Whether a file under `src` is a test: `*.test.ts(x)` or anything under `__tests__`. */
const isTest = (path: string) => /\.test\.tsx?$/.test(path) || path.split("/").includes("__tests__");

/** Every non-test `.ts` and `.tsx` under `apps/*\/src` and `packages/*\/src`, by its path from the root with `/`. */
function sources(): string[] {
  const found: string[] = [];
  for (const group of ["apps", "packages"]) {
    for (const entry of readdirSync(join(ROOT, group), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const src = join(ROOT, group, entry.name, "src");
      let paths: string[];
      try {
        paths = readdirSync(src, { recursive: true, encoding: "utf8" });
      } catch {
        continue;
      }
      for (const path of paths) {
        const relative = `${group}/${entry.name}/src/${path.split(sep).join("/")}`;
        if (/\.tsx?$/.test(path) && !isTest(relative)) found.push(relative);
      }
    }
  }
  return found.sort();
}

/** `node` with any parentheses, `as` and `satisfies` around it removed. */
const bare = (node: ts.Expression): ts.Expression =>
  ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)
    ? bare(node.expression)
    : node;

interface Logged {
  readonly method: ts.PropertyAccessExpression;
  readonly message: ts.Expression | undefined;
}

/** The method a call reaches and its message: `x.m(msg)`, `x.m.call(t, msg)` or `x.m.apply(t, [msg])`. */
function logged(node: ts.CallExpression): Logged | undefined {
  const callee = bare(node.expression);
  if (!ts.isPropertyAccessExpression(callee)) return undefined;
  const target = bare(callee.expression);
  const via = callee.name.text;
  if ((via === "call" || via === "apply") && ts.isPropertyAccessExpression(target) && METHODS.has(target.name.text)) {
    const second = node.arguments[1] === undefined ? undefined : bare(node.arguments[1]);
    const list = via === "apply" && second !== undefined && ts.isArrayLiteralExpression(second);
    return { method: target, message: list ? second.elements[0] : second };
  }
  return METHODS.has(via) ? { method: callee, message: node.arguments[0] } : undefined;
}

/** Every `.debug/.info/.warn/.error(` call in `text` whose receiver is not `console`, and whether it is constant. */
function logCalls(text: string, file: string): Call[] {
  const parsed = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const calls: Call[] = [];
  const walk = (node: ts.Node) => {
    const found = ts.isCallExpression(node) ? logged(node) : undefined;
    if (found !== undefined) {
      const receiver = bare(found.method.expression);
      const isConsole = ts.isIdentifier(receiver) && receiver.text === "console";
      const message = found.message === undefined ? undefined : bare(found.message);
      const constant =
        message !== undefined && (ts.isStringLiteral(message) || ts.isNoSubstitutionTemplateLiteral(message));
      if (!isConsole) calls.push({ file, text: node.getText(parsed), constant });
    }
    ts.forEachChild(node, walk);
  };
  walk(parsed);
  return calls;
}

/** The calls in `text` that are neither constant nor listed for `file`. */
const refused = (text: string, file: string, listed: Readonly<Record<string, readonly string[]>> = {}) =>
  logCalls(text, file)
    .filter(({ constant, text: call }) => !constant && !(listed[file] ?? []).includes(call))
    .map(({ text: call }) => `${file}: ${call}`);

describe("a log message is a constant", () => {
  const all = sources().flatMap((file) => logCalls(readFileSync(join(ROOT, file), "utf8"), file));

  it("reads the logger's calls in apps and packages", () => {
    expect(all.filter(({ constant }) => constant).length).toBeGreaterThan(0);
  });

  it("finds every call whose message is not a constant listed, by its file and its text", () => {
    const unlisted = all
      .filter(({ constant, file, text }) => !constant && !(NOT_A_LOG[file] ?? []).includes(text))
      .map(({ file, text }) => `${file}: ${text}`);
    expect(unlisted).toEqual([]);
  });

  it("has no listed entry that nothing matches", () => {
    const stale = Object.entries(NOT_A_LOG).flatMap(([file, texts]) =>
      texts
        .filter((text) => !all.some((call) => call.file === file && call.text === text && !call.constant))
        .map((text) => `${file}: ${text}`),
    );
    expect(stale).toEqual([]);
  });

  it("refuses a substitution, a variable, a call, a concatenation, a tag, no message in any callee form", () => {
    const file = "packages/x/src/a.ts";
    expect(refused('log.info("ready"); log.warn(`ready`, { n: 1 }); console.error(e, `${u}`);', file)).toEqual([]);
    expect(refused("log.error(`failed at ${url}`);", file)).toEqual([`${file}: log.error(\`failed at \${url}\`)`]);
    expect(refused("log.warn(message);", file)).toEqual([`${file}: log.warn(message)`]);
    expect(refused("this.logger.debug(String(error));", file)).toEqual([`${file}: this.logger.debug(String(error))`]);
    expect(refused('logger.child({}).info("a " + url);', file)).toEqual([`${file}: logger.child({}).info("a " + url)`]);
    expect(refused("log.error();", file)).toEqual([`${file}: log.error()`]);
    expect(refused('log.warn(("x")); log.warn("x" as const); log.info.call(log, "x");', file)).toEqual([]);
    expect(refused('log.warn.apply(log, ["x"]); console.error.call(console, e);', file)).toEqual([]);
    expect(refused("(log.error)(url); log.error.call(log, url); log.error.apply(log, [url]);", file)).toEqual([
      `${file}: (log.error)(url)`,
      `${file}: log.error.call(log, url)`,
      `${file}: log.error.apply(log, [url])`,
    ]);
    expect(refused("log.warn(tag`x`); log.error.apply(log, args);", file)).toHaveLength(2);
    expect(refused('// log.error(url);\nconst s = "log.error(url)";', file)).toEqual([]);
    expect(refused("log.warn(message);", file, { [file]: ["log.warn(message)"] })).toEqual([]);
    expect(refused("log.warn(message);", file, { "packages/y/src/a.ts": ["log.warn(message)"] })).toHaveLength(1);
  });
});
