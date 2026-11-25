import { createLogger, type Logger } from "@app/observability";
import type { ServerEnv } from "@app/shared";
import { getServerEnv } from "./env";

/** Why a change was refused by the origin check (ADR-0174 Decision 5). Never a header's value. */
export type OriginRefusal = "NO_ORIGIN" | "OPAQUE" | "MISMATCH" | "NO_HOST" | "NO_SETTING";

/** What the request's `Origin` is compared with. */
export interface OriginSetting {
  /** `APP_BASE_URL`, where it is set. */
  readonly baseUrl: string | undefined;
  /** A production process, by the ambient or the configured `NODE_ENV`. */
  readonly production: boolean;
}

/**
 * Why a cookie-based change did not come from a page of this site, or null
 * when it did (ADR-0174 Decisions 2 and 3, amending ADR-0068 Decision 4).
 *
 * With `APP_BASE_URL` set, `Origin` must equal its origin exactly: scheme,
 * host and port. Unset, production refuses every change; elsewhere the host
 * the browser addressed is compared as before: the first `X-Forwarded-Host`
 * a proxy set, else `Host`. No `Origin`, `null` or a malformed one is refused.
 * Pure: it reads the request's headers and nothing else, never its URL.
 */
export function originRefusal(request: Request, setting: OriginSetting): OriginRefusal | null {
  const expected = setting.baseUrl !== undefined && URL.canParse(setting.baseUrl) ? new URL(setting.baseUrl) : null;
  if (expected === null && (setting.production || setting.baseUrl !== undefined)) return "NO_SETTING";
  const origin = request.headers.get("origin");
  if (origin === null) return "NO_ORIGIN";
  if (origin === "null") return "OPAQUE";
  if (expected !== null) return origin === expected.origin ? null : "MISMATCH";
  const host = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim() || request.headers.get("host");
  if (!host) return "NO_HOST";
  return URL.canParse(origin) && new URL(origin).host === host ? null : "MISMATCH";
}

/**
 * The setting this process compares with. An environment that cannot be read
 * leaves the ambient `NODE_ENV` alone to decide, as the start check does: a
 * production build refuses, and a test run given no environment keeps the
 * host rule (ADR-0174 Decision 2).
 */
function originSetting(): OriginSetting {
  const ambient = process.env.NODE_ENV === "production";
  let env: ServerEnv;
  try {
    env = getServerEnv();
  } catch {
    return { baseUrl: undefined, production: ambient };
  }
  return { baseUrl: env.APP_BASE_URL, production: ambient || env.NODE_ENV === "production" };
}

let logger: Logger | undefined;
const originLog = (): Pick<Logger, "warn"> => (logger ??= createLogger({ base: { component: "same-origin" } }));

/**
 * Whether a cookie-authenticated change came from a page of this site
 * (ADR-0174). A refusal is logged at `warn` with its reason and, where the
 * call names it, the route, as `POST /api/auth/login`; never a header's
 * value (Decision 5).
 */
export function isSameOriginPost(request: Request, route?: string): boolean {
  const refusal = originRefusal(request, originSetting());
  if (refusal === null) return true;
  originLog().warn("A change was refused by the origin check", {
    code: "ORIGIN_REFUSED",
    reason: refusal,
    ...(route === undefined ? {} : { route }),
  });
  return false;
}
