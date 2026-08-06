import { AppError } from "@app/shared";
import type { MediaAsset } from "@app/domain";
import { beforeEach, describe, expect, it, vi } from "vitest";

const list = vi.fn();
vi.mock("./property", () => ({
  getPropertyServices: () => ({ assets: { list } }),
}));

const { requireAssetInProperty } = await import("./asset-route");

const USER = "usr_1";
const ORG = "org_1";
const PROPERTY = "prp_1";

function asset(id: string, propertyId = PROPERTY): MediaAsset {
  return { id, organizationId: ORG, propertyId } as MediaAsset;
}

beforeEach(() => {
  list.mockReset();
});

describe("requireAssetInProperty", () => {
  it("accepts an asset that belongs to the property in the URL", async () => {
    list.mockResolvedValue([asset("ast_other"), asset("ast_1")]);

    await expect(
      requireAssetInProperty(USER, ORG, PROPERTY, "ast_1"),
    ).resolves.toBeUndefined();
    expect(list).toHaveBeenCalledWith(USER, ORG, PROPERTY);
  });

  it("rejects an asset from another property in the same organization", async () => {
    // The service call is scoped to the URL's property, so a same-tenant asset
    // filed elsewhere simply is not in the list.
    list.mockResolvedValue([asset("ast_elsewhere")]);

    const error = await requireAssetInProperty(USER, ORG, PROPERTY, "ast_1").catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe("NOT_FOUND");
  });

  it("rejects an unknown asset the same way", async () => {
    list.mockResolvedValue([]);

    const error = await requireAssetInProperty(USER, ORG, PROPERTY, "ast_missing").catch(
      (e: unknown) => e,
    );
    expect((error as AppError).code).toBe("NOT_FOUND");
  });

  it("makes a property mismatch indistinguishable from a missing asset", async () => {
    list.mockResolvedValueOnce([asset("ast_elsewhere")]);
    const mismatch = (await requireAssetInProperty(USER, ORG, PROPERTY, "ast_1").then(
      () => null,
      (e: unknown) => e as AppError,
    ))!;
    list.mockResolvedValueOnce([]);
    const missing = (await requireAssetInProperty(USER, ORG, PROPERTY, "ast_1").then(
      () => null,
      (e: unknown) => e as AppError,
    ))!;

    // Same code and same message, so the response can never reveal that the
    // asset exists under some other property.
    expect(mismatch.code).toBe(missing.code);
    expect(mismatch.message).toBe(missing.message);
  });

  it("does not disclose the property or asset in the message", async () => {
    list.mockResolvedValue([asset("ast_elsewhere", "prp_secret")]);

    const error = await requireAssetInProperty(USER, ORG, PROPERTY, "ast_1").then(
      () => null,
      (e: unknown) => e as AppError,
    );
    expect(JSON.stringify(error)).not.toContain("prp_secret");
    expect(JSON.stringify(error)).not.toContain("ast_elsewhere");
  });

  it.each([
    ["an authorization refusal", new AppError("FORBIDDEN", "Your role lacks permission")],
    ["an unauthenticated caller", new AppError("UNAUTHENTICATED", "Sign in required")],
    ["a repository failure", new Error("connection terminated unexpectedly")],
  ])("propagates %s instead of reporting not found", async (_label, thrown) => {
    // Flattening these into NOT_FOUND would present a broken system as a
    // missing page.
    list.mockRejectedValue(thrown);
    await expect(requireAssetInProperty(USER, ORG, PROPERTY, "ast_1")).rejects.toBe(thrown);
  });

  it("reads the property list exactly once", async () => {
    list.mockResolvedValue([asset("ast_1")]);
    await requireAssetInProperty(USER, ORG, PROPERTY, "ast_1");
    expect(list).toHaveBeenCalledTimes(1);
  });
});
