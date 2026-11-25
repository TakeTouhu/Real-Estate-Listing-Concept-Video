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
