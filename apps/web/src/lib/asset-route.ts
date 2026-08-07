import { AppError } from "@app/shared";
import { getPropertyServices } from "./property";

/**
 * Enforce the nested-route invariant for
 * `/api/properties/{propertyId}/assets/{assetId}/…`.
 *
 * The analysis services take `organizationId + assetId` and resolve the asset
 * organization-scoped — which is correct, and is the tenant boundary. But they
 * are never told the property in the URL, so an asset belonging to a *different
 * property in the same organization* would be acted on happily through a
 * hand-built path. Not a cross-tenant leak; still wrong, and the same defect
 * class the storyboard detail page hit in Phase 3C-6b.
 *
 * A mismatch is indistinguishable from a missing asset: both raise the same
 * `NOT_FOUND`, so the response never reveals that the asset exists under some
 * other property. An unknown property in the caller's organization simply lists
 * nothing and lands in the same place.
 *
 * **This is URL integrity, not authorization.** `assets.list` authorizes
 * organization membership only, exactly as every read on these routes already
 * does, and grants the caller nothing they could not already do. The action's
 * own `video:review` (or `property:write`) check still runs afterwards in the
 * domain, untouched — a member without permission still gets `403` on a
 * well-formed path, and lifecycle and tenancy rules stay where they are.
 *
 * There is deliberately **no** `try`/`catch`: an authorization refusal, a
 * repository failure, or any other error propagates unchanged. Flattening those
 * into `NOT_FOUND` would present a broken system as a missing page — the
 * mistake `isFresh` and `resolveStoryboardForProperty` are both written to
 * avoid.
 *
 * @throws AppError NOT_FOUND when the asset is unknown, another tenant's, or
 *   belongs to a different property than the URL names.
 */
export async function requireAssetInProperty(
  actorUserId: string,
  organizationId: string,
  propertyId: string,
  assetId: string,
): Promise<void> {
  const assets = await getPropertyServices().assets.list(
    actorUserId,
    organizationId,
    propertyId,
  );
  if (!assets.some((asset) => asset.id === assetId)) {
    throw new AppError("NOT_FOUND", "Asset not found");
  }
}
