import type { MediaAsset } from "@app/domain";
import { beforeEach, describe, expect, it, vi } from "vitest";

const createDownloadUrl = vi.fn();
vi.mock("./property", () => ({
  getPropertyServices: () => ({ assets: { createDownloadUrl } }),
}));

const { thumbnailUrls } = await import("./thumbnails");

const USER = "usr_1";
const ORG = "org_1";

function asset(overrides: Partial<MediaAsset> = {}): MediaAsset {
  return {
    id: "ast_1",
    organizationId: ORG,
    propertyId: "prp_1",
    originalFilename: "a.jpg",
    status: "READY",
    storageKey: "org_1/prp_1/ast_1/original.jpg",
    thumbnailKey: "org_1/prp_1/ast_1/thumb.jpg",
    ...overrides,
  } as MediaAsset;
}

beforeEach(() => {
  createDownloadUrl.mockReset();
  createDownloadUrl.mockImplementation((_u: string, _o: string, assetId: string) =>
    Promise.resolve({ url: `https://signed.example/${assetId}?sig=abc` }),
  );
});

describe("thumbnailUrls", () => {
  it("mints one thumbnail URL per previewable asset, keyed by asset id", async () => {
    const urls = await thumbnailUrls(USER, ORG, [
      asset({ id: "ast_1" }),
      asset({ id: "ast_2" }),
    ]);

    expect(urls.get("ast_1")).toBe("https://signed.example/ast_1?sig=abc");
    expect(urls.get("ast_2")).toBe("https://signed.example/ast_2?sig=abc");
    expect(createDownloadUrl).toHaveBeenCalledTimes(2);
    expect(createDownloadUrl).toHaveBeenCalledWith(USER, ORG, "ast_1", "thumbnail");
  });

  it("skips an asset that is not READY or has no thumbnail variant", async () => {
    const urls = await thumbnailUrls(USER, ORG, [
      asset({ id: "ready", status: "READY" }),
      asset({ id: "processing", status: "PROCESSING" }),
      asset({ id: "quarantined", status: "QUARANTINED" }),
      asset({ id: "no-thumb", thumbnailKey: null }),
    ]);

    expect([...urls.keys()]).toEqual(["ready"]);
    expect(createDownloadUrl).toHaveBeenCalledTimes(1);
  });

  it("returns only signed URLs — never a storage key", async () => {
    const urls = await thumbnailUrls(USER, ORG, [asset()]);

    for (const url of urls.values()) {
      expect(url).not.toContain("original.jpg");
      expect(url).not.toContain("thumb.jpg");
      expect(url).toContain("sig=");
    }
  });

  it("is empty for no assets and makes no call", async () => {
    const urls = await thumbnailUrls(USER, ORG, []);
    expect(urls.size).toBe(0);
    expect(createDownloadUrl).not.toHaveBeenCalled();
  });
});
