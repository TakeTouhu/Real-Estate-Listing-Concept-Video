import { readFileSync, readdirSync } from "node:fs";
import { join, sep } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * Route handlers redirect to a path, never to an address built from
 * `request.url` (ADR-0175 Decision 7, built in RD-10b). A production server
 * builds `request.url` on its bind address, so in the image a redirect named
 * `0.0.0.0:3000` whatever `Host` said, and `form-action 'self'` made the
 * browser refuse it after a form post.
 *
 * Every redirect goes through `apps/web/src/lib/redirect.ts`: no other source
 * file of the web app calls `NextResponse.redirect` or `Response.redirect`,
 * names a `Location` header or a 3xx status. No source file reads
 * `request.url` but for its query (`new URL(request.url).searchParams`), nor
 * passes it on; a route file never reads `nextUrl` (built from it), names its
 * handler's request `request`, and never calls `next/navigation`'s `redirect`,
 * which pages use and a route never needs. Only the download route sends the
 * one absolute `Location`, the storage adapter's signed link.
 */
const WEB = join(__dirname, "..", "..", "apps", "web", "src");
const HELPER = join("lib", "redirect.ts");
const DOWNLOAD = join("app", "api", "video-projects", "[projectId]", "download", "route.ts");

/** The tokens of `text` in order, as TypeScript reads them: a JSDoc comment is not one. */
function tokens(file: ts.SourceFile): ts.Node[] {
  const found: ts.Node[] = [];
  const walk = (node: ts.Node) => {
    if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode) return;
    const children = node.getChildren(file);
    if (children.length === 0) found.push(node);
    else children.forEach(walk);
  };
  walk(file);
  return found;
}

const parse = (text: string) =>
  ts.createSourceFile("source.tsx", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

/**
 * Source without comments, so a word in a comment never counts, read as
 * TypeScript reads it: a `//` or `/*` in a string, template or regular
 * expression stays, with the code after it. What lies between two tokens is
 * only white space and comments, and becomes one space or line break.
 */
function code(text: string): string {
  const file = parse(text);
  return tokens(file)
    .map((token) => {
      const start = token.getStart(file);
      const between = text.slice(token.pos, start);
      return `${between === "" ? "" : between.includes("\n") ? "\n" : " "}${text.slice(start, token.end)}`;
    })
    .join("");
}

/** One rule that any of `parts` meets. */
const anyOf = (...parts: RegExp[]) => new RegExp(parts.map((part) => part.source).join("|"));

/** What only the helper may write, in any source file of the web app. */
const REDIRECTS: readonly (readonly [string, RegExp])[] = [
  // Called on anything, by name in brackets, taken from (Next)Response, or (Next)Response imported by another name.
  [
    "a redirect call",
    anyOf(
      /\.\s*redirect\b/,
      /\[\s*["'`]redirect["'`]\s*\]/,
      /\}\s*=\s*(?:Next)?Response\b/,
      /\b(?:Next)?Response\s+as\b/,
    ),
  ],
  ["a Location header", /["'`]location["'`]\s*[,:\]]|[{,]\s*Location\s*(?::|[,}])/i],
  ["a 3xx status", /\b30[1-8]\b/],
];

/** What no source file may do with a request's address, beyond its query. */
const ADDRESS: readonly (readonly [string, RegExp])[] = [
  ["request.url beyond its query", /\brequest\.url\b(?!\)\.searchParams\b)/],
  ["request.url not read for its query", /(?<!\bnew URL\()\brequest\.url\b/],
  ["request's url read another way", /\brequest\s*(?:\?\.\s*)?\[|\}\s*=\s*request\b/],
];

/** What a route file may not do beyond that. */
const ROUTE_ONLY: readonly (readonly [string, RegExp])[] = [
  ["the URL Next.js builds from request.url", /\bnextUrl\b/],
  ["next/navigation's redirect", /(?<![.\w])(?:redirect|permanentRedirect)\s*\(/],
  // A handler is a function declaration whose first parameter, if any, is `request`.
  [
    "a handler's request not named request",
    anyOf(
      /\bexport\s+(?:async\s+)?function\s+(?:GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)\s*\(\s*(?!request\b)[\w$]/,
      /\bexport\s+(?:const|let|var)\s+(?:GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)\b/,
    ),
  ],
];

/** Each source file of the web app but tests, by its path under `src`. */
function sources(root: string = WEB): string[] {
  return readdirSync(root, { recursive: true, encoding: "utf8" })
    .filter((path) => /\.tsx?$/.test(path) && !/\.(?:test|spec)\.tsx?$/.test(path))
    .sort();
}

const isRoute = (path: string) => path === "route.ts" || path.endsWith(`${sep}route.ts`);

/** What `source` breaks, by name: the rules for every file, a route's beyond them. */
function breaches(source: string, route: boolean): string[] {
  const text = code(source);
  const rules = route ? [...REDIRECTS, ...ADDRESS, ...ROUTE_ONLY] : [...REDIRECTS, ...ADDRESS];
  return rules.filter(([, rule]) => rule.test(text)).map(([name]) => name);
}

describe("relative redirects' coverage", () => {
  const files = sources();
  const routes = files.filter(isRoute);

  it("reads every route file of the web app: 50 today", () => {
    expect(routes).toHaveLength(50);
  });

  it("finds no redirect outside the helper, and nothing built on a request's address", () => {
    const found = files
      .filter((path) => path !== HELPER)
      .flatMap((path) => {
        const names = breaches(readFileSync(join(WEB, path), "utf8"), isRoute(path));
        return names.map((name) => `${path}: ${name}`);
      });
    expect(found).toEqual([]);
  });

  it("reads each source file whole: its tokens and what lies between them give it back", () => {
    for (const path of files) {
      const text = readFileSync(join(WEB, path), "utf8");
      const file = parse(text);
      expect(tokens(file).map((token) => text.slice(token.pos, token.end)).join(""), path).toBe(text);
    }
  });

  it("finds the redirects in the route files that send them through the helper", () => {
    const helped = routes.filter((path) => /\bfrom "@\/lib\/redirect"/.test(readFileSync(join(WEB, path), "utf8")));
    expect(helped).toHaveLength(30);
  });

  it("finds the storage adapter's signed link sent from the download route alone", () => {
    const sends = (path: string) => /\bseeOtherToSignedLink\b/.test(code(readFileSync(join(WEB, path), "utf8")));
    const sending = files.filter(sends);
    expect(sending).toEqual([DOWNLOAD, HELPER].sort());
  });

  it("holds the helper to 303 with a path, and one absolute Location, the storage adapter's https: link", () => {
    const helper = code(readFileSync(join(WEB, HELPER), "utf8"));
    expect(helper.match(/\bstatus\s*:\s*\d+/g)).toEqual(["status: 303", "status: 303"]);
    expect(helper.match(/\bLocation\s*:[^}]*/g)).toEqual(["Location: pathWithQuery(path) ", "Location: store.href "]);
    expect(helper).toMatch(/\bif \(store\.protocol !== "https:"\) throw\b/);
    expect(helper).not.toMatch(/\brequest\b/);
  });

  it("catches each way back to an address", () => {
    const route = (body: string) => `export async function POST(request: Request) {\n  ${body}\n}`;
    const caught = (body: string, inRoute = true) => breaches(route(body), inRoute);
    expect(caught('return NextResponse.redirect(new URL("/x", request.url), { status: 303 });')).toEqual([
      "a redirect call",
      "a 3xx status",
      "request.url beyond its query",
      "request.url not read for its query",
    ]);
    expect(caught('return Response.redirect("https://app.example/x", 303);')).toEqual([
      "a redirect call",
      "a 3xx status",
    ]);
    expect(caught('return new NextResponse(null, { status: 303, headers: { Location: "https://x/y" } });')).toEqual([
      "a Location header",
      "a 3xx status",
    ]);
    expect(caught('response.headers.set("location", "https://x/y");', false)).toEqual(["a Location header"]);
    expect(caught("return seeOther(groupsPage(request.url, id, outcome));")).toEqual([
      "request.url beyond its query",
      "request.url not read for its query",
    ]);
    expect(caught("const { href } = request.nextUrl;")).toEqual([
      "request's url read another way",
      "the URL Next.js builds from request.url",
    ]);
    expect(caught('redirect("/login");')).toEqual(["next/navigation's redirect"]);
    expect(caught('const page = new URL(request.url); return seeOther(page.pathname);')).toEqual([
      "request.url beyond its query",
    ]);
    // Outside a route file too: a helper handed the request.
    expect(caught('return seeOther(new URL("/x", request.url).pathname);', false)).toEqual([
      "request.url beyond its query",
      "request.url not read for its query",
    ]);
    expect(caught('const { url } = request; return seeOther(new URL("/x", url).pathname);', false)).toEqual([
      "request's url read another way",
    ]);
    expect(caught('return seeOther(new URL("/x", request["url"]).pathname);', false)).toEqual([
      "request's url read another way",
    ]);
    expect(breaches("export async function POST(req: Request) {\n  return seeOther(req.url);\n}", true)).toEqual([
      "a handler's request not named request",
    ]);
    expect(breaches("export const POST = async (request: Request) => seeOther(\"/\");", true)).toEqual([
      "a handler's request not named request",
    ]);
  });

  it("catches a redirect however it is named or written", () => {
    const caught = (body: string) => breaches(body, false);
    expect(caught('import { NextResponse as R } from "next/server";')).toEqual(["a redirect call"]);
    expect(caught('return R.redirect(new URL("/login", url), 303);')).toEqual(["a redirect call", "a 3xx status"]);
    expect(caught('const { redirect: go } = NextResponse; return go(new URL("/x", u));')).toEqual(["a redirect call"]);
    expect(caught('return NextResponse["redirect"](link);')).toEqual(["a redirect call"]);
    expect(caught("const status = 303; return new NextResponse(null, { status, headers: { location } });")).toEqual([
      "a Location header",
      "a 3xx status",
    ]);
  });

  it("reads code after a string, template or regular expression that holds `//` or `/*`", () => {
    const after = 'NextResponse.redirect(new URL("/x", request.url));';
    const found = ["a redirect call", "request.url beyond its query", "request.url not read for its query"];
    expect(breaches(`const a = "see //"; return ${after}`, true)).toEqual(found);
    expect(breaches(`const accept = "image/*"; return ${after} /* closed */`, true)).toEqual(found);
    expect(breaches(`const t = \`a // \${b}\`; return ${after}`, true)).toEqual(found);
    expect(breaches(`const r = /\\/\\//; return ${after}`, true)).toEqual(found);
    expect(breaches(`return (<a href="//x">{/* note */}</a>) && ${after}`, true)).toEqual(found);
  });

  it("lets a route read its query and send a path through the helper", () => {
    const route = [
      "export async function POST(request: Request) {",
      '  const id = new URL(request.url).searchParams.get("id");',
      '  return seeOther(pathWithQuery("/x", { id }));',
      "}",
    ].join("\n");
    expect(breaches(route, true)).toEqual([]);
    expect(breaches("// NextResponse.redirect(new URL('/x', request.url))\nconst a = 1;", true)).toEqual([]);
  });
});
