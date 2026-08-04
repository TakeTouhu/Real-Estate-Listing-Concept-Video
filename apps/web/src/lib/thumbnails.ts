import type { MediaAsset } from "@app/domain";
import { getPropertyServices } from "./property";

/**
 * Short-lived signed thumbnail URLs, keyed by asset id.
 *
 * **Server-only.** It reaches the asset service and, through it, object
 * storage; importing it from a Client Component would drag both into the
 * browser bundle.
 *
 * URLs are minted per render and never persisted — that is the whole point of
 * a signed link. Storage keys stay on this side of the boundary: only the
 * signed URL is returned, and an asset that has no thumbnail variant is simply
 * absent from the map so its caller renders without a preview.
 *
 * Extracted unchanged from the review page in Phase 3C-6b, when the storyboard
 * detail page became a second consumer of the same behaviour. It is not a media
 * abstraction and should not grow into one.
 */
export async function thumbnailUrls(
  userId: string,
  organizationId: string,
  assets: readonly MediaAsset[],
): Promise<Map<string, string>> {
  const urls = new Map<string, string>();
  const previewable = assets.filter((a) => a.status === "READY" && a.thumbnailKey);
  for (const asset of previewable) {
    const signed = await getPropertyServices().assets.createDownloadUrl(
      userId,
      organizationId,
      asset.id,
      "thumbnail",
    );
    urls.set(asset.id, signed.url);
  }
  return urls;
}
