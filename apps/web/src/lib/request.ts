import { AppError } from "@app/shared";

const MAX_ID_LENGTH = 64;

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
