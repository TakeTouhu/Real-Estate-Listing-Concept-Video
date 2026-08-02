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
