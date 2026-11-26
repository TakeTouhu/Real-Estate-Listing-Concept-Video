import { z } from "zod";
import { createLogger, type Logger } from "@app/observability";

/**
 * Browsers' reports of page policy violations, `POST /api/csp-report`
 * (ADR-0189). Unauthenticated by nature: no cookie, session, database or
 * limiter is read. The body is read up to a byte cap and never kept; a report
 * whose page is not on `APP_BASE_URL`'s origin is dropped; the rest are
 * counted by derived categories only, and a request writes at most one line,
 * when one of its categories reaches 1, 2, 4, 8 ... reports in this process.
 */

/** The largest body read, in bytes; a larger one is refused with `413`. */
export const CSP_REPORT_MAX_BYTES = 16 * 1024;
/** The violations read from one request; the rest are counted as `dropped`. */
export const CSP_REPORT_MAX_VIOLATIONS = 10;
const REPORT_URI = "application/csp-report";
const REPORT_TO = "application/reports+json";

/** Our policy's directives and the finer ones a browser may name instead. */
const DIRECTIVES: ReadonlySet<string> = new Set([
  ...["default-src", "script-src", "style-src", "img-src", "media-src", "font-src", "connect-src", "object-src"],
  ...["base-uri", "form-action", "frame-src", "frame-ancestors", "script-src-elem", "script-src-attr"],
  ...["style-src-elem", "style-src-attr", "worker-src", "manifest-src"],
]);
const KEYWORDS: ReadonlySet<string> = new Set(["inline", "eval", "wasm-eval", "data", "blob", "self"]);
const EXTENSIONS: ReadonlySet<string> = new Set(["chrome-extension", "moz-extension", "safari-web-extension"]);
const NEXT_STATIC = /^\/_next\/static\/[A-Za-z0-9._/-]{1,160}$/;

/** What a bounded read gave: the text, or why there is none. */
export type BoundedRead =
  | { readonly kind: "ok"; readonly text: string }
  | { readonly kind: "tooLarge" }
  | { readonly kind: "unreadable" };

/**
 * The body as text, read chunk by chunk and cancelled once it passes `max`
 * bytes. Never throws: a stream that fails or yields something other than
 * bytes is `unreadable`.
 */
export async function readBounded(body: ReadableStream<Uint8Array> | null, max: number): Promise<BoundedRead> {
  if (body === null) return { kind: "ok", text: "" };
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    const reader = body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return { kind: "ok", text: Buffer.concat(chunks).toString("utf8") };
      size += value.byteLength;
      if (size > max) {
        reader.cancel().catch(() => undefined);
        return { kind: "tooLarge" };
      }
      chunks.push(value);
    }
  } catch { return { kind: "unreadable" }; }
}

/** The parsed JSON, or `undefined`, which no schema below accepts. */
function parseJson(text: string): unknown {
  try { return JSON.parse(text) as unknown; } catch { return undefined; }
}

const URI = z.string().max(4096);
const NAME = z.string().max(256);
/** An optional field: absent or `null`, as the specifications allow (`USVString? blockedURL`), read as absent. */
const opt = <T extends z.ZodType<string>>(schema: T) => schema.nullish().transform((value) => value ?? undefined);
/** `report-uri`: one violation. Unknown keys, `original-policy` and `script-sample` among them, are not kept. */
const REPORT_URI_BODY = z.object({
  "csp-report": z.object({
    "document-uri": URI,
    "blocked-uri": opt(URI),
    "effective-directive": opt(NAME),
    "violated-directive": opt(URI),
    disposition: opt(NAME),
    "source-file": opt(URI),
  }),
});
/** `report-to`: a batch of reports of any type; only `csp-violation` bodies are read. */
const REPORT_TO_BODY = z.array(z.object({ type: NAME, url: opt(URI), body: z.unknown() }));
const VIOLATION_BODY = z.object({
  documentURL: opt(URI),
  blockedURL: opt(URI),
  effectiveDirective: opt(NAME),
  disposition: opt(NAME),
  sourceFile: opt(URI),
});

/** One violation's fields as read, before anything is derived from them. */
type Violation = Readonly<Partial<Record<"document" | "blocked" | "directive" | "disposition" | "source", string>>>;

/** The violations a body holds, up to the cap, and how many were left unread; `undefined` for a wrong shape. */
function violationsOf(type: string, json: unknown): { violations: Violation[]; dropped: number } | undefined {
  if (type === REPORT_URI) {
    const parsed = REPORT_URI_BODY.safeParse(json);
    if (!parsed.success) return undefined;
    const report = parsed.data["csp-report"];
    const directive = report["effective-directive"] ?? report["violated-directive"]?.trim().split(" ")[0];
    const { "document-uri": document, "blocked-uri": blocked, disposition, "source-file": source } = report;
    return { violations: [{ document, blocked, directive, disposition, source }], dropped: 0 };
  }
  const batch = REPORT_TO_BODY.safeParse(json);
  if (!batch.success) return undefined;
  const reports = batch.data.filter((report) => report.type === "csp-violation");
  const violations: Violation[] = [];
  for (const report of reports.slice(0, CSP_REPORT_MAX_VIOLATIONS)) {
    const body = VIOLATION_BODY.safeParse(report.body);
    if (!body.success) return undefined;
    const { documentURL, blockedURL: blocked, effectiveDirective: directive, disposition, sourceFile } = body.data;
    violations.push({ document: documentURL ?? report.url, blocked, directive, disposition, source: sourceFile });
  }
  return { violations, dropped: reports.length - violations.length };
}

const originOf = (value: string | undefined) =>
  value !== undefined && URL.canParse(value) ? new URL(value).origin : undefined;
/** A URL's scheme, lower case: `https` for `https://x`; empty for none. */
const schemeOf = (value: string) => (/^([a-z][a-z0-9+.-]*):/i.exec(value)?.[1] ?? "").toLowerCase();
/** An extension's scheme, alone (as a browser may report it) or as a URL's. */
const isExtension = (value: string) => EXTENSIONS.has(value) || EXTENSIONS.has(schemeOf(value));

/** The directive's name when it is on the list, else `other`. */
export const directiveCategory = (value: string | undefined): string =>
  value !== undefined && DIRECTIVES.has(value.toLowerCase()) ? value.toLowerCase() : "other";

/** `enforce` or `report` as sent, else `other`: never the sender's own text. */
export const dispositionCategory = (value: string | undefined): string =>
  value === "enforce" || value === "report" ? value : "other";

/** What was refused, as a category: never its address, host or path. */
export function blockedCategory(value: string | undefined, origin: string): string {
  if (value === undefined) return "other";
  if (KEYWORDS.has(value)) return value;
  const scheme = schemeOf(value);
  if (scheme === "data" || scheme === "blob") return scheme;
  if (isExtension(value)) return "extension";
  if (scheme !== "http" && scheme !== "https") return "other";
  return originOf(value) === origin ? "self" : "external";
}

/** Where the refused code came from: our own built scripts, an extension, nowhere named, or anything else. */
export function sourceCategory(value: string | undefined, origin: string): string {
  if (value === undefined || value === "") return "none";
  if (isExtension(value)) return "extension";
  if (/[?#]/.test(value) || originOf(value) !== origin) return "other";
  return NEXT_STATIC.test(new URL(value).pathname) ? "next-static" : "other";
}

/** A violation's category key: each value from a fixed list, so the keys are finite (ADR-0189 Decision 4). */
type Categories = Readonly<Record<"mechanism" | "directive" | "blocked" | "disposition" | "source", string>>;

/** Reports seen by this process, by category key, since it started: the sampler's only state. */
const seen = new Map<string, number>();

/** Forget every count. Tests only: the counts otherwise last as long as the process. */
export function resetCspReportCountsForTests(): void {
  seen.clear();
}

let logger: Logger | undefined;
const log = (): Logger => (logger ??= createLogger({ base: { component: "csp-report" } }));

/**
 * Add a request's counts to the process's and write one line listing every
 * category whose running count reached a power of two with this request, or
 * none when no category did. Nothing reads a clock.
 */
function sample(counts: ReadonlyMap<string, { categories: Categories; count: number }>, dropped: number): void {
  const reached: Record<string, string | number>[] = [];
  for (const [key, { categories, count }] of counts) {
    const before = seen.get(key) ?? 0;
    const total = before + count;
    seen.set(key, total);
    if (2 ** Math.floor(Math.log2(total)) > before) reached.push({ ...categories, count, total });
  }
  if (reached.length > 0) log().info("Browsers reported page policy violations", { violations: reached, dropped });
}

/**
 * The answer to a report: `415` for another type, `413` past the byte cap,
 * `400` for a body that cannot be read, is not JSON or has the wrong shape, and
 * `204` otherwise, whether or not anything was counted or written. `baseUrl`
 * is read only once the body is valid; with none, every report is dropped.
 */
export async function answerCspReport(
  request: Request,
  baseUrl: () => string | undefined,
): Promise<204 | 400 | 413 | 415> {
  const type = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (type !== REPORT_URI && type !== REPORT_TO) return 415;
  if (Number(request.headers.get("content-length")) > CSP_REPORT_MAX_BYTES) return 413;
  const read = await readBounded(request.body, CSP_REPORT_MAX_BYTES);
  if (read.kind !== "ok") return read.kind === "tooLarge" ? 413 : 400;
  const batch = violationsOf(type, parseJson(read.text));
  if (batch === undefined) return 400;
  const origin = originOf(baseUrl());
  const counts = new Map<string, { categories: Categories; count: number }>();
  for (const violation of batch.violations) {
    if (violation.document === undefined || origin === undefined || originOf(violation.document) !== origin) continue;
    const categories: Categories = {
      mechanism: type === REPORT_URI ? "report-uri" : "report-to",
      directive: directiveCategory(violation.directive),
      blocked: blockedCategory(violation.blocked, origin),
      disposition: dispositionCategory(violation.disposition),
      source: sourceCategory(violation.source, origin),
    };
    const key = Object.values(categories).join(" ");
    counts.set(key, { categories, count: (counts.get(key)?.count ?? 0) + 1 });
  }
  sample(counts, batch.dropped);
  return 204;
}
