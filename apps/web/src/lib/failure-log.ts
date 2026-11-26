import { createLogger, type Logger } from "@app/observability";
import { AppError } from "@app/shared";

/** A name a line may carry: one word, as a class's or Node.js's own names are. */
const NAME = /^[A-Za-z][A-Za-z0-9_$]{0,59}$/;
/** How many causes are read for a code beyond the error itself. */
const CAUSE_DEPTH = 4;

let logger: Logger | undefined;
const log = (): Logger => (logger ??= createLogger({ base: { component: "request" } }));

/**
 * A short code for why a probe did not answer: the error's own code when it
 * is one plain word, as Prisma's and Node.js's are, and never its message,
 * which can name a host, a user or a path.
 */
export function probeFailureCode(error: unknown): string {
  if (typeof error !== "object" || error === null) return "UNEXPECTED";
  const { code, errorCode } = error as { readonly code?: unknown; readonly errorCode?: unknown };
  const named = [code, errorCode].find((value) => typeof value === "string" && /^[A-Z0-9][A-Z0-9_]{0,39}$/.test(value));
  return typeof named === "string" ? named : "UNEXPECTED";
}

/** The error's `name` when it is one word, else `UNNAMED`: never its message. */
export function failureName(error: unknown): string {
  if (typeof error !== "object" || error === null) return "UNNAMED";
  const { name } = error as { readonly name?: unknown };
  return typeof name === "string" && NAME.test(name) ? name : "UNNAMED";
}

/** The first plain code of the error or of its causes, four deep; `UNEXPECTED` when none has one. */
export function failureCode(error: unknown): string {
  let current: unknown = error;
  for (let depth = 0; depth <= CAUSE_DEPTH && typeof current === "object" && current !== null; depth += 1) {
    const code = probeFailureCode(current);
    if (code !== "UNEXPECTED") return code;
    current = (current as { readonly cause?: unknown }).cause;
  }
  return "UNEXPECTED";
}

/** The name of what the error stands for: a recorded `causeName`, else its `cause`'s name, else none. */
function failureCauseName(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const { causeName, cause } = error as { readonly causeName?: unknown; readonly cause?: unknown };
  if (typeof causeName === "string") return failureName({ name: causeName });
  return typeof cause === "object" && cause !== null ? failureName(cause) : undefined;
}

/**
 * Whether an answered error is one the app does not know: anything that is
 * not an `AppError`, or an `AppError` answered 500 or more. A 4xx `AppError`
 * is an expected answer (ADR-0177 Decision 1).
 */
export function isUnknownFailure(error: unknown): boolean {
  return !(error instanceof AppError) || error.httpStatus >= 500;
}

/**
 * Log a request's failure the app does not know, as one `error` line of the
 * component `request`: the route as the code names it, the request's id, the
 * error's name and code, and its cause's name (ADR-0177 Decision 2). Never
 * its message, stack or object, nor anything of the request. Writes nothing
 * for an expected answer, waits on nothing, and never throws: the answer is
 * the same whether or not the line could be written. Returns the id.
 */
export function logRequestFailure(error: unknown, route: string, requestId: string = crypto.randomUUID()): string {
  try {
    if (!isUnknownFailure(error)) return requestId;
    const causeName = failureCauseName(error);
    log().error("A request failed", {
      route,
      requestId,
      errorName: failureName(error),
      code: failureCode(error),
      ...(causeName === undefined ? {} : { causeName }),
    });
  } catch {
    // The answer is the same whether or not the line could be written.
  }
  return requestId;
}

/** The methods the app answers. A request's method is the client's to choose, so any other is `OTHER`. */
const METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);
/** A route's pattern as Next.js names it, such as `/properties/[propertyId]`: never a path with a query. */
const ROUTE_PATH = /^\/[\w./[\]()@-]{0,119}$/;
/** The values Next.js 15.5 gives `routeType` and `renderSource` (`server/instrumentation/types.d.ts`). */
const ROUTE_TYPES: ReadonlySet<string> = new Set(["render", "route", "action", "middleware"]);
const RENDER_SOURCES: ReadonlySet<string> = new Set([
  "react-server-components",
  "react-server-components-payload",
  "server-rendering",
]);
/** Next.js's hash of a server component's error, which its error page also sends: digits only. */
const DIGEST = /^\d{1,20}$/;

/** What Next.js's `onRequestError` is told of the route, as far as the line reads it. */
export interface UncaughtRequestContext {
  readonly routePath: string;
  readonly routeType: string;
  readonly renderSource?: string;
}

/** A value read from the error, or the fallback when reading it throws. */
function safely<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch {
    return fallback;
  }
}

/** A value in the list, or `other`: the line never carries a value it has not checked. */
function listed(values: ReadonlySet<string>, value: unknown): string {
  return typeof value === "string" && values.has(value) ? value : "other";
}

/**
 * The fields of an error no catch took, which Next.js reported to
 * `onRequestError` (ADR-0185): the method and the route's pattern, the route's
 * type and render source, the request's id, the error's name and code, its
 * cause's name and a digest of digits. Never the request's path, which holds
 * its query, nor its headers, nor the error's message, stack or object. A read
 * of the context or the error that throws gives the field's fallback.
 */
export function uncaughtRequestFields(
  error: unknown,
  method: string,
  context: UncaughtRequestContext,
  requestId: string,
): Record<string, string> {
  const routePath = safely<unknown>(() => context.routePath, undefined);
  const renderSource = safely<unknown>(() => context.renderSource, undefined);
  const pattern = typeof routePath === "string" && ROUTE_PATH.test(routePath);
  const causeName = safely(() => failureCauseName(error), undefined);
  const digest = safely(() => (error as { readonly digest?: unknown } | null)?.digest, undefined);
  return {
    route: `${METHODS.has(method) ? method : "OTHER"} ${pattern ? routePath : "(other)"}`,
    requestId,
    errorName: safely(() => failureName(error), "UNNAMED"),
    code: safely(() => failureCode(error), "UNEXPECTED"),
    ...(causeName === undefined ? {} : { causeName }),
    routeType: listed(ROUTE_TYPES, safely<unknown>(() => context.routeType, undefined)),
    ...(renderSource === undefined ? {} : { renderSource: listed(RENDER_SOURCES, renderSource) }),
    ...(typeof digest === "string" && DIGEST.test(digest) ? { digest } : {}),
  };
}

/**
 * Log an error that no catch took, as one `error` line of the component
 * `request`, an `AppError` of 4xx included: whatever status Next.js answered,
 * no catch knew the failure. Called by `onRequestError` in `instrumentation.ts`,
 * after Next.js's own print. Waits on nothing and never throws.
 */
export function logUncaughtRequestFailure(
  error: unknown,
  method: string,
  context: UncaughtRequestContext,
  requestId: string = crypto.randomUUID(),
): void {
  try {
    log().error("Next.js answered a request that failed", uncaughtRequestFields(error, method, context, requestId));
  } catch {
    // Next.js answers the same whether or not the line could be written.
  }
}
