import type { ObjectStorage } from "@app/domain";
import { verifyStorageToken } from "@app/storage";
import type { FakeSourcePhotoReader } from "@app/video-providers";

/**
 * How the test provider reads a scene's photo in the development pipeline
 * (GS-9b, ADR-0106): through the signed URL preparation gave it, redeemed the
 * way the download route redeems one, from the shared folder.
 *
 * A URL is read only under the pipeline's own base, for download, with a token
 * signed with the shared folder's secret that has not expired. The web app
 * signs with the same secret, so its download tokens read here too, as the
 * pipeline's would at its route. Anything else names nothing readable, and the
 * test provider then refuses the request, as a real provider refuses a URL it
 * cannot fetch.
 *
 * Nothing is fetched. The base's host is under `.invalid`, which never
 * resolves, so the URL cannot reach a network either.
 */
export interface SharedFolderPhotoReaderOptions {
  /** The base the pipeline signs URLs under, e.g. `https://development.invalid/api/storage`. */
  readonly base: string;
  /** The secret the shared folder signs with. */
  readonly secret: string;
  readonly storage: Pick<ObjectStorage, "getObject">;
}

export function createSharedFolderPhotoReader(options: SharedFolderPhotoReaderOptions): FakeSourcePhotoReader {
  const download = `${options.base}/download`;
  return {
    async read(signedUrl: string): Promise<Uint8Array | null> {
      let url: URL;
      try {
        url = new URL(signedUrl);
      } catch {
        return null;
      }
      if (`${url.origin}${url.pathname}` !== download) return null;
      const token = url.searchParams.get("token");
      if (token === null) return null;
      const verified = verifyStorageToken(token, options.secret, "download");
      return verified === null ? null : options.storage.getObject(verified.key);
    },
  };
}
