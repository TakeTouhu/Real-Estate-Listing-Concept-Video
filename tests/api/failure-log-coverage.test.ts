import { readFileSync, readdirSync } from "node:fs";
import { join, sep } from "node:path";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { AppError } from "@app/shared";

/**
 * A request that fails for a reason the app does not know is logged
 * (ADR-0177 Decision 5). Every `catch` clause and every `.catch(` call in a
 * route file, a server page or layout, `lib/mfa.ts` and `lib/csp-report.ts` takes one of these
 * shapes, read as TypeScript parses the file, so a comment or a string never
 * counts:
 *
 * 1. Logged under its own key: its first statement calls
 *    `appErrorToResponse(<binding>, "<key>")` (returned or assigned) or
 *    `logRequestFailure(<binding>, "<key>")`, imported by that name from
 *    `@/lib/http` or `@/lib/failure-log` (`./http` or `./failure-log` in `lib/mfa.ts`) and
 *    declared nowhere in the file, the key being the enclosing handler's
 *    `METHOD /path` in a route file and `GET /path` in a page or layout; in
 *    `lib/mfa.ts`, `appErrorToResponse(error, route)`.
 * 2. A body that is not JSON or a form: no binding, and its `try` is the one
 *    statement `x = await request.json()` or `request.formData()`, optionally
 *    `as T`, `x` a name or a destructuring of names.
 * 3. In a page or layout only, a rethrow: its binding is thrown on every path
 *    but one where it is known to be an `AppError` with a code whose default status is under 500
 *    (`FORBIDDEN`, `NOT_FOUND`, ...; the code is read, not `httpStatus`), which the page answers itself; what
 *    it rethrows Next.js prints. A `.catch(` given a function declared in the
 *    same file is read as that function.
 * 4. Listed below, exactly, by its own text.
 *
 * A `.then(` given two functions, and `Promise.allSettled`, are refused.
 */
const UNLOGGED: Readonly<Record<string, readonly string[]>> = {
  // Cancels a stream whose client has gone: no request is left to answer.
  "app/api/storage/download/route.ts": ["body.cancel().catch(() => undefined)"],
  // A report's reader and parser never throw: a body that cannot be read or is not JSON is a 400 with no line, never
  // an error line an unauthenticated client could cause at will (ADR-0189); a stream past the cap is cancelled.
  "lib/csp-report.ts": [
    "reader.cancel().catch(() => undefined)",
    'catch { return { kind: "unreadable" }; }',
    "catch { return undefined; }",
  ],
};

const WEB = join(__dirname, "..", "..", "apps", "web", "src");
const MFA = "lib/mfa.ts";
const CSP = "lib/csp-report.ts";
const HELPERS = new Set(["appErrorToResponse", "logRequestFailure"]);
/** The codes whose default status is under 500: the only ones a page may answer itself (ADR-0177 Decision 5). */
const EXPECTED = new Set(["UNAUTHENTICATED", "FORBIDDEN", "NOT_FOUND", "VALIDATION_FAILED", "RATE_LIMITED"]);
const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);

type Kind = "route" | "page" | "mfa" | "lib";

/** Where the helpers may come from. */
const SOURCES: Readonly<Record<Kind, readonly string[]>> = {
  route: ["@/lib/http", "@/lib/failure-log"],
  page: ["@/lib/http", "@/lib/failure-log"],
  mfa: ["./http", "./failure-log"],
  lib: ["./http", "./failure-log"],
};

interface Catch {
  readonly file: string;
  readonly line: number;
  readonly text: string;
  readonly accepted: boolean;
}

const parse = (text: string) =>
  ts.createSourceFile("source.tsx", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

/** The files read, by their path under `src` with `/`: route files, server pages and layouts, and the two libs. */
function files(): string[] {
  const all = readdirSync(join(WEB, "app"), { recursive: true, encoding: "utf8" }).map((path) =>
    `app/${path.split(sep).join("/")}`,
  );
  const server = all.filter((path) => {
    if (/(?:^|\/)route\.ts$/.test(path)) return true;
    if (!/(?:^|\/)(?:page|layout)\.tsx$/.test(path)) return false;
    return !/^\s*["']use client["']/.test(readFileSync(join(WEB, path), "utf8"));
  });
  return [...server.sort(), MFA, CSP];
}

const kindOf = (file: string): Kind =>
  file === MFA ? "mfa" : file === CSP ? "lib" : file.endsWith("route.ts") ? "route" : "page";

/** `/api/auth/login` for `app/api/auth/login/route.ts`; `/` for `app/page.tsx`. */
const pathOf = (file: string) => `/${file.split("/").slice(1, -1).join("/")}`;

/** The exported handler's `METHOD` a node lies in, if any. */
function methodOf(node: ts.Node): string | undefined {
  const handler = ts.findAncestor(node, (at) => ts.isFunctionDeclaration(at) && METHODS.has(at.name?.text ?? ""));
  if (handler === undefined || !ts.isFunctionDeclaration(handler)) return undefined;
  const exported = handler.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
  return exported ? handler.name?.text : undefined;
}

/** The key a helper must be given here: a string, or the identifier `route` in `lib/mfa.ts`. */
function keyOf(kind: Kind, file: string, node: ts.Node): string | undefined {
  if (kind === "mfa") return "route";
  if (kind === "lib") return undefined;
  if (kind === "page") return `GET ${pathOf(file)}`;
  const method = methodOf(node);
  return method === undefined ? undefined : `${method} ${pathOf(file)}`;
}

/** The helper call a statement makes at its top: `f(...)`, `return f(...)` or `x = f(...)`. */
function topCall(statement: ts.Node): ts.CallExpression | undefined {
  let expression: ts.Expression | undefined;
  if (ts.isExpressionStatement(statement)) expression = statement.expression;
  else if (ts.isReturnStatement(statement)) expression = statement.expression;
  else if (ts.isExpression(statement)) expression = statement;
  if (expression && ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    expression = expression.right;
  }
  return expression && ts.isCallExpression(expression) ? expression : undefined;
}

/** Whether `node` names the declaration it is the name of: a variable, function, class or parameter. */
function declares(node: ts.Identifier): boolean {
  const { parent } = node;
  const declaration =
    ts.isVariableDeclaration(parent) ||
    ts.isFunctionDeclaration(parent) ||
    ts.isFunctionExpression(parent) ||
    ts.isClassDeclaration(parent) ||
    ts.isParameter(parent) ||
    ts.isBindingElement(parent);
  return declaration && parent.name === node;
}

/** The helpers a file imports, by their own name, from where they live; none when the file declares one itself. */
function importedHelpers(parsed: ts.SourceFile, kind: Kind): ReadonlySet<string> {
  const names = new Set<string>();
  for (const statement of parsed.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const clause = statement.importClause;
    const bindings = clause?.namedBindings;
    if (!SOURCES[kind].includes(statement.moduleSpecifier.text) || clause?.isTypeOnly) continue;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const { name, propertyName, isTypeOnly } of bindings.elements) {
      if (propertyName === undefined && !isTypeOnly && HELPERS.has(name.text)) names.add(name.text);
    }
  }
  const shadowed = within(parsed, false).some(
    (node) => ts.isIdentifier(node) && HELPERS.has(node.text) && declares(node),
  );
  return shadowed ? new Set() : names;
}

/** Whether `call` is a helper given the binding and the key: a string literal, or `route` in `lib/mfa.ts`. */
function logsWith(
  call: ts.CallExpression | undefined,
  binding: string,
  key: string,
  kind: Kind,
  helpers: ReadonlySet<string>,
): boolean {
  if (!call || !ts.isIdentifier(call.expression) || !helpers.has(call.expression.text)) return false;
  const [error, route] = call.arguments;
  if (!error || !ts.isIdentifier(error) || error.text !== binding || !route) return false;
  if (kind === "mfa") return ts.isIdentifier(route) && route.text === key;
  return ts.isStringLiteral(route) && route.text === key;
}

/** Whether a catch's first statement logs its binding under the key. */
function logsFirst(
  first: ts.Node | undefined,
  binding: string | undefined,
  key: string | undefined,
  kind: Kind,
  helpers: ReadonlySet<string>,
) {
  if (first === undefined || binding === undefined || key === undefined) return false;
  return logsWith(topCall(first), binding, key, kind, helpers);
}

/** Every node under `node`; with `own`, not entering nested functions. */
function within(node: ts.Node, own = true): ts.Node[] {
  const found: ts.Node[] = [];
  const walk = (at: ts.Node) => {
    found.push(at);
    if (own && at !== node && ts.isFunctionLike(at)) return;
    ts.forEachChild(at, walk);
  };
  walk(node);
  return found;
}

const unwrap = (node: ts.Expression): ts.Expression =>
  ts.isParenthesizedExpression(node) ? unwrap(node.expression) : node;

/** A `try` of the one statement `x = await request.json()` or `formData()`, optionally `as T`. */
function readsBodyAlone(block: ts.Block): boolean {
  const [statement, ...rest] = block.statements;
  if (!statement || rest.length > 0 || !ts.isExpressionStatement(statement)) return false;
  const assignment = unwrap(statement.expression);
  if (!ts.isBinaryExpression(assignment) || assignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return false;
  const { left } = assignment;
  const names = (property: ts.ObjectLiteralElementLike) =>
    ts.isShorthandPropertyAssignment(property) && property.objectAssignmentInitializer === undefined;
  if (!ts.isIdentifier(left) && !(ts.isObjectLiteralExpression(left) && left.properties.every(names))) return false;
  let value = unwrap(assignment.right);
  if (ts.isAsExpression(value)) value = unwrap(value.expression);
  if (!ts.isAwaitExpression(value) || !ts.isCallExpression(value.expression)) return false;
  const call = value.expression;
  const callee = call.expression;
  return (
    call.arguments.length === 0 &&
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === "request" &&
    ["json", "formData"].includes(callee.name.text)
  );
}

/** What a page's catch knows of its binding at a point: that it is an `AppError`, and which code it has. */
interface Known {
  readonly app: boolean;
  readonly code?: string;
}

/** The code of `binding.code <operator> "CODE"`, if `node` is that comparison. */
function comparedCode(node: ts.Expression, binding: string, operator: ts.SyntaxKind): string | undefined {
  const at = unwrap(node);
  if (!ts.isBinaryExpression(at) || at.operatorToken.kind !== operator) return undefined;
  if (!ts.isStringLiteral(at.right)) return undefined;
  const { left } = at;
  const ours = ts.isPropertyAccessExpression(left) && ts.isIdentifier(left.expression) && left.name.text === "code";
  return ours && left.expression.text === binding ? at.right.text : undefined;
}

/** Whether `node` is `binding instanceof AppError`. */
function isAppErrorTest(node: ts.Expression, binding: string): boolean {
  const at = unwrap(node);
  return (
    ts.isBinaryExpression(at) &&
    at.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword &&
    ts.isIdentifier(at.left) &&
    at.left.text === binding &&
    ts.isIdentifier(at.right) &&
    at.right.text === "AppError"
  );
}

/** What is known once `condition` holds: only `instanceof AppError` and `.code === "CODE"`, joined by `&&`. */
function knownIfTrue(condition: ts.Expression, binding: string, known: Known): Known {
  const at = unwrap(condition);
  if (ts.isBinaryExpression(at) && at.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
    return knownIfTrue(at.right, binding, knownIfTrue(at.left, binding, known));
  }
  if (ts.isPrefixUnaryExpression(at) && at.operator === ts.SyntaxKind.ExclamationToken) {
    return knownIfFalse(at.operand, binding, known);
  }
  if (isAppErrorTest(at, binding)) return { ...known, app: true };
  const code = comparedCode(at, binding, ts.SyntaxKind.EqualsEqualsEqualsToken);
  return code !== undefined && known.app ? { ...known, code } : known;
}

/** What is known once `condition` fails: its `||` parts each fail, and `.code !== "CODE"` fails as `=== "CODE"`. */
function knownIfFalse(condition: ts.Expression, binding: string, known: Known): Known {
  const at = unwrap(condition);
  if (ts.isBinaryExpression(at) && at.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
    return knownIfFalse(at.right, binding, knownIfFalse(at.left, binding, known));
  }
  if (ts.isPrefixUnaryExpression(at) && at.operator === ts.SyntaxKind.ExclamationToken) {
    return knownIfTrue(at.operand, binding, known);
  }
  const code = comparedCode(at, binding, ts.SyntaxKind.ExclamationEqualsEqualsToken);
  return code !== undefined && known.app ? { ...known, code } : known;
}

/** Whether a statement is `throw <binding>`, alone or in a block. */
function throwsBinding(statement: ts.Statement, binding: string): boolean {
  if (ts.isBlock(statement)) {
    const [only, ...rest] = statement.statements;
    return only !== undefined && rest.length === 0 && throwsBinding(only, binding);
  }
  if (!ts.isThrowStatement(statement)) return false;
  return ts.isIdentifier(statement.expression) && statement.expression.text === binding;
}

/**
 * Whether a page's catch rethrows its binding on every path but those where it
 * is known to be an `AppError` with an expected code: `if (...) throw <binding>`
 * guards, `if (...)` answers for an expected code, then a rethrow or an answer
 * once the code is known to be expected.
 */
function rethrowsUnexpected(body: ts.ConciseBody, binding: string): boolean {
  const expected = ({ app, code }: Known) => app && code !== undefined && EXPECTED.has(code);
  if (!ts.isBlock(body)) return false;
  let known: Known = { app: false };
  for (const statement of body.statements) {
    if (throwsBinding(statement, binding)) return true;
    if (!ts.isIfStatement(statement) || statement.elseStatement !== undefined) return expected(known);
    if (throwsBinding(statement.thenStatement, binding)) known = knownIfFalse(statement.expression, binding, known);
    else if (!expected(knownIfTrue(statement.expression, binding, known))) return false;
  }
  return expected(known);
}

/** A function declared at the top of the file under `name`, if any. */
function declaredFunction(parsed: ts.SourceFile, name: string): ts.FunctionDeclaration | undefined {
  return parsed.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === name && statement.body !== undefined,
  );
}

/** Every catch of `source`, read as file `file`, and whether it takes one of the shapes. */
function catches(source: string, file: string): Catch[] {
  const parsed = parse(source);
  const kind = kindOf(file);
  const helpers = importedHelpers(parsed, kind);
  const found: Catch[] = [];
  const push = (node: ts.Node, accepted: boolean) =>
    found.push({
      file,
      line: parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1,
      text: node.getText(parsed),
      accepted,
    });
  /** A handler: it logs first, or, in a page, rethrows all but an expected code. */
  const handles = (handler: ts.FunctionLikeDeclaration, body: ts.ConciseBody, at: ts.Node) => {
    const parameter = handler.parameters[0]?.name;
    const name = parameter && ts.isIdentifier(parameter) ? parameter.text : undefined;
    const first = ts.isBlock(body) ? body.statements[0] : body;
    if (logsFirst(first, name, keyOf(kind, file, at), kind, helpers)) return true;
    return kind === "page" && name !== undefined && rethrowsUnexpected(body, name);
  };
  const visit = (node: ts.Node) => {
    if (ts.isCatchClause(node)) {
      const binding = node.variableDeclaration?.name;
      const name = binding && ts.isIdentifier(binding) ? binding.text : undefined;
      const key = keyOf(kind, file, node);
      const accepted =
        logsFirst(node.block.statements[0], name, key, kind, helpers) ||
        (binding === undefined && ts.isTryStatement(node.parent) && readsBodyAlone(node.parent.tryBlock)) ||
        (kind === "page" && name !== undefined && rethrowsUnexpected(node.block, name));
      push(node, accepted);
    } else if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      const [handler] = node.arguments;
      if (method === "catch") {
        let accepted = false;
        if (handler && (ts.isArrowFunction(handler) || ts.isFunctionExpression(handler))) {
          accepted = handles(handler, handler.body, node);
        } else if (handler && ts.isIdentifier(handler)) {
          const named = declaredFunction(parsed, handler.text);
          accepted = named?.body !== undefined && handles(named, named.body, node);
        }
        push(node, accepted);
      } else if ((method === "then" && node.arguments.length > 1) || method === "allSettled") {
        push(node, false);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return found;
}

/** Helper calls given a route that is not a string literal (or `route` in `lib/mfa.ts`). */
function unnamedRoutes(source: string, file: string): string[] {
  const parsed = parse(source);
  return within(parsed, false)
    .filter(ts.isCallExpression)
    .filter((call) => ts.isIdentifier(call.expression) && HELPERS.has(call.expression.text))
    .flatMap((call) => {
      const route = call.arguments[1];
      if (route === undefined || ts.isStringLiteral(route)) return [];
      if (kindOf(file) === "mfa" && ts.isIdentifier(route) && route.text === "route") return [];
      return [`${file}: ${route.getText(parsed)}`];
    });
}

const read = (file: string) => readFileSync(join(WEB, file), "utf8");
/** The helpers' imports, as a route file or page has them. */
const IMPORTS =
  'import { appErrorToResponse } from "@/lib/http";\n' + 'import { logRequestFailure } from "@/lib/failure-log";\n';
const refused = (source: string, file: string, imports = IMPORTS) =>
  catches(imports + source, file).filter(({ accepted }) => !accepted).length;

describe("the failure log's coverage", () => {
  const all = files();
  const found = all.flatMap((file) => catches(read(file), file));

  it("reads every catch in route files, server pages and layouts, and the two libs: 52 today", () => {
    expect(all.filter((file) => kindOf(file) === "route")).toHaveLength(51);
    expect(found).toHaveLength(52);
    const byKind = (kind: Kind) => found.filter(({ file }) => kindOf(file) === kind).length;
    expect([byKind("route"), byKind("page"), byKind("mfa"), byKind("lib")]).toEqual([34, 13, 2, 3]);
  });

  it("answers 400 with no line, never an error, to a report whose stream errors after one chunk", async () => {
    const { POST } = await import("@/app/api/csp-report/route");
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: string) => void lines.push(line));
    vi.spyOn(console, "error").mockImplementation((line: string) => void lines.push(line));
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"csp-report":'));
        controller.error(new Error("the client went away"));
      },
    });
    const init = { method: "POST", headers: { "content-type": "application/csp-report" }, body, duplex: "half" };
    try {
      const response = await POST(new Request("https://app.example.test/api/csp-report", init as RequestInit));
      expect(response.status).toBe(400);
      expect(lines).toEqual([]);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("finds every catch logged, a body read, a page's rethrow or listed, and the list exact", () => {
    const unlogged: Record<string, string[]> = {};
    for (const { file, text, accepted } of found) if (!accepted) (unlogged[file] ??= []).push(text);
    expect(unlogged).toEqual(UNLOGGED);
  });

  it("takes as expected only the codes whose default status is under 500", () => {
    for (const code of EXPECTED) expect(new AppError(code as "FORBIDDEN", "x").httpStatus).toBeLessThan(500);
    for (const code of ["CONFIGURATION_ERROR", "PROVIDER_ERROR", "INTERNAL_ERROR"] as const) {
      expect(new AppError(code, "x").httpStatus).toBeGreaterThanOrEqual(500);
    }
  });

  it("gives no helper a route that is not a literal: no request.url, error.message or template", () => {
    expect(all.flatMap((file) => unnamedRoutes(read(file), file))).toEqual([]);
  });

  it("refuses a swallowing catch, a wrong key, a commented-out call and a template or address as the route", () => {
    const route = "app/api/x/route.ts";
    const handler = (body: string) =>
      `export async function POST(request: Request) { try { await work(); } catch (error) { ${body} } }`;
    expect(refused(handler('return appErrorToResponse(error, "POST /api/x");'), route)).toBe(0);
    expect(refused(handler('logRequestFailure(error, "POST /api/x"); return seeOther("/");'), route)).toBe(0);
    expect(refused("export async function POST() { try { await work(); } catch {} }", route)).toBe(1);
    expect(refused(handler('return appErrorToResponse(error, "POST /api/y");'), route)).toBe(1);
    expect(refused(handler('return appErrorToResponse(error, "GET /api/x");'), route)).toBe(1);
    expect(refused(handler('// logRequestFailure(error, "POST /api/x");\nreturn seeOther("/");'), route)).toBe(1);
    expect(refused(handler('return seeOther("/"); logRequestFailure(error, "POST /api/x");'), route)).toBe(1);
    expect(refused(handler("return appErrorToResponse(error, `POST /api/x`);"), route)).toBe(1);
    expect(refused(handler("return appErrorToResponse(error, request.url);"), route)).toBe(1);
    expect(refused(handler('return appErrorToResponse(other, "POST /api/x");'), route)).toBe(1);
    expect(unnamedRoutes(handler("return appErrorToResponse(error, request.url);"), route)).toEqual([
      `${route}: request.url`,
    ]);
    expect(unnamedRoutes(handler("logRequestFailure(error, error.message);"), route)).toEqual([
      `${route}: error.message`,
    ]);
    // Outside an exported handler a route file has no key to name.
    const helper =
      'async function helper() { try { await work(); } catch (error) { logRequestFailure(error, "POST /api/x"); } }';
    expect(refused(helper, route)).toBe(1);
  });

  it("takes a rethrow in a page alone, and a body read only as one awaited request.json() or formData()", () => {
    const rethrow = 'export async function POST() { try { await work(); } catch (error) { throw error; } }';
    expect(refused(rethrow, "app/api/x/route.ts")).toBe(1);
    expect(refused(rethrow, "app/x/page.tsx")).toBe(0);
    const other = "export default async function P() { try { await w(); } catch (error) { throw new Error(); } }";
    expect(refused(other, "app/x/page.tsx")).toBe(1);
    const bodyRead = (statements: string, binding = "") =>
      `export async function POST(request: Request) { try { ${statements} } catch ${binding}{ return a(); } }`;
    expect(refused(bodyRead("form = await request.formData();"), "app/api/x/route.ts")).toBe(0);
    expect(refused(bodyRead("body = await request.json(); await work();"), "app/api/x/route.ts")).toBe(1);
    expect(refused(bodyRead("body = await parse(await request.json());"), "app/api/x/route.ts")).toBe(1);
    expect(refused(bodyRead("body = await request.json();", "(error) "), "app/api/x/route.ts")).toBe(1);
    const page =
      "export default async function P() { const p = await get()" +
      '.catch((error: unknown) => { logRequestFailure(error, "GET /x"); return null; }); }';
    expect(refused(page, "app/x/page.tsx")).toBe(0);
    expect(refused(page.replace("logRequestFailure(error, \"GET /x\"); ", ""), "app/x/page.tsx")).toBe(1);
    expect(refused("export default async function P() { await get().catch(() => null); }", "app/x/page.tsx")).toBe(1);
    const parsedBody =
      "export async function POST(request: Request) { try { ({ id } = (new Body(await request.json())) " +
      "as { id?: unknown }); } catch { return a(); } }";
    expect(refused(parsedBody, "app/api/x/route.ts")).toBe(1);
    expect(refused(parsedBody.replace("new Body(await request.json())", "await request.json()"), "app/api/x/route.ts"))
      .toBe(0);
  });

  it("takes a page's rethrow only where it answers itself only codes whose default status is under 500", () => {
    const page = (body: string) =>
      `export default async function P() { for (const o of os) { try { await w(o); } catch (error) { ${body} } } }`;
    const forbidden = 'error.code !== "FORBIDDEN"';
    for (const accepted of [
      `if (!(error instanceof AppError) || ${forbidden}) throw error; return null;`,
      'if (error instanceof AppError && error.code === "FORBIDDEN") { return null; } throw error;',
      `if (!(error instanceof AppError)) throw error; if (error.code === "NOT_FOUND") continue; if (${forbidden}) ` +
        "throw error; offer = null;",
    ]) {
      expect(refused(page(accepted), "app/x/page.tsx")).toBe(0);
    }
    for (const swallowing of [
      "if (error instanceof AppError) continue; throw error;",
      "if (!(error instanceof AppError)) throw error; return null;",
      'if (error instanceof AppError && error.code === "CONFIGURATION_ERROR") return null; throw error;',
      'if (error.code === "FORBIDDEN") return null; throw error;',
      "if (x) throw error;",
      `if (!(error instanceof AppError) || ${forbidden}) throw error; else return null;`,
    ]) {
      expect(refused(page(swallowing), "app/x/page.tsx")).toBe(1);
    }
    const named = (body: string) =>
      `export default async function P() { await get().catch(without); }\nfunction without(error: unknown) { ${body} }`;
    expect(refused(named('if (error instanceof AppError && error.code === "FORBIDDEN") return null; throw error;'),
      "app/x/page.tsx")).toBe(0);
    expect(refused(named("return null;"), "app/x/page.tsx")).toBe(1);
    expect(refused("export default async function P() { await get().catch(elsewhere); }", "app/x/page.tsx")).toBe(1);
  });

  it("refuses a helper not imported by its name, or shadowed, and a two-function .then( or allSettled", () => {
    const route = "app/api/x/route.ts";
    const logged =
      "export async function POST() { try { await work(); } " +
      'catch (error) { logRequestFailure(error, "POST /api/x"); } }';
    expect(refused(logged, route)).toBe(0);
    expect(refused(logged, route, "")).toBe(1);
    expect(refused(logged, route, 'import { logRequestFailure } from "./elsewhere";\n')).toBe(1);
    expect(refused(logged, route, 'import { failureName as logRequestFailure } from "@/lib/failure-log";\n')).toBe(1);
    expect(refused(`${logged}\nconst logRequestFailure = () => undefined;`, route)).toBe(1);
    expect(refused("export async function POST() { await work().then(undefined, () => undefined); }", route)).toBe(1);
    expect(refused("export async function POST() { await work().then(() => undefined); }", route)).toBe(0);
    expect(refused("export async function POST() { await Promise.allSettled([work()]); }", route)).toBe(1);
  });

  it("finds appErrorToResponse logging before it answers, and mfaRoute naming its own route", () => {
    const http = parse(read("lib/http.ts"));
    const answer = within(http, false)
      .filter(ts.isFunctionDeclaration)
      .find((node) => node.name?.text === "appErrorToResponse");
    const calls = within(answer?.body ?? http).filter(ts.isCallExpression).map((call) => call.expression.getText(http));
    expect(calls[0]).toBe("logRequestFailure");
    expect(catches(read(MFA), MFA).map(({ accepted }) => accepted)).toEqual([true, true]);
  });
});
