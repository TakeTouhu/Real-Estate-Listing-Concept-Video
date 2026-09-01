import { AppError } from "@app/shared";

const MAX_ID_LENGTH = 64;
const MAX_FIELD_LENGTH = 2000;

/**
 * Shape-only validation of a caller-supplied organization id. Whether the
 * caller may act in that organization is decided by the domain services, which
 * check membership and scope every read to it — this only rejects input that
 * cannot be an id at all.
 */
function validOrganizationId(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_ID_LENGTH) {
    throw new AppError("VALIDATION_FAILED", "organizationId is required");
  }
  return value;
}

/** Read `organizationId` from a JSON request body. */
export async function requireOrganizationId(request: Request): Promise<string> {
  let body: { readonly organizationId?: unknown };
  try {
    body = (await request.json()) as { readonly organizationId?: unknown };
  } catch {
    throw new AppError("VALIDATION_FAILED", "Invalid JSON body");
  }
  return validOrganizationId(body.organizationId);
}

/** Read `organizationId` from the query string of a GET request. */
export function requireOrganizationIdFromQuery(request: Request): string {
  return validOrganizationId(new URL(request.url).searchParams.get("organizationId"));
}

/**
 * Read a JSON body once, returning `organizationId` alongside the raw object so
 * a route can forward its remaining fields without re-reading the stream.
 *
 * Only shape is checked. Whether a field is *required* — a rejection reason, a
 * primary asset for a duplicate group — is a domain rule, decided by
 * AnalysisService, never here.
 */
export async function readJsonBody(
  request: Request,
): Promise<{ organizationId: string; body: Record<string, unknown> }> {
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    throw new AppError("VALIDATION_FAILED", "Invalid JSON body");
  }
  const body = (parsed ?? {}) as Record<string, unknown>;
  return { organizationId: validOrganizationId(body.organizationId), body };
}

/** Shape-only: a string field if present and non-empty, otherwise undefined. */
export function optionalString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.length > MAX_FIELD_LENGTH) {
    throw new AppError("VALIDATION_FAILED", `${key} must be a string`);
  }
  return value;
}

/** Shape-only: a required string field. Meaning is the domain's business. */
export function requiredString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_FIELD_LENGTH) {
    throw new AppError("VALIDATION_FAILED", `${key} must be a non-empty string`);
  }
  return value;
}

/**
 * A required field whose value must be one of a closed set.
 *
 * Still shape-only in the sense the rest of this module means it — the set is
 * supplied by the caller from a domain constant, and nothing here decides what
 * belongs in it. What it adds is that the returned value is *typed* as a member,
 * so a route cannot hand untrusted JSON to a service that declares a union and
 * have the two agree only by convention.
 *
 * The message lists the accepted values. They are a public product vocabulary,
 * not configuration or a secret, and a client that sent the wrong one cannot
 * fix it from "invalid".
 */
export function requiredMember<T extends string>(
  body: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
): T {
  // `find` rather than `includes`, so the member comes back already typed as
  // one. `includes` would leave a cast as the only way to express the narrowing
  // it just proved, and a cast is the same syntax whether or not the check
  // above it is still there.
  const value = body[key];
  const member = allowed.find((candidate) => candidate === value);
  if (member === undefined) {
    throw new AppError("VALIDATION_FAILED", `${key} must be one of: ${allowed.join(", ")}`);
  }
  return member;
}

/** Shape-only: a whole number above zero. Achievability is the domain's call. */
export function requiredPositiveInteger(body: Record<string, unknown>, key: string): number {
  const value = body[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new AppError("VALIDATION_FAILED", `${key} must be a positive whole number`);
  }
  return value;
}
