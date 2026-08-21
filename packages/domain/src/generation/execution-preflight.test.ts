import { describe, expect, it } from "vitest";
import { AppError } from "@app/shared";
import { InMemoryMediaAssetRepository } from "../testing/index";
import { DOWNLOAD_URL_TTL_SECONDS } from "../property/asset-service";
import type { MediaAsset, MediaAssetStatus } from "../property/types";
import type { ObjectStorage, SignedUrl } from "../property/ports";
import type { VideoModelCapability, VideoModelCapabilityProvider } from "./capability";
import type { SystemGenerationCandidate } from "./execution-ports";
import {
  PREFLIGHT_SOURCE_URL_TTL_SECONDS,
  prepareQueuedGeneration,
  type ExecutionPreflightDeps,
} from "./execution-preflight";
import {
  PreflightRefusalError,
  isRetryablePreflightRefusal,
  type PreflightRefusalReason,
} from "./execution-preflight-errors";
import { computeGenerationRequestHash } from "./request-identity";
import { SCENE_GENERATION_STATES, type SceneGeneration, type SceneGenerationState } from "./types";

const ORG = "org_pf";
const OTHER_ORG = "org_pf_other";
const ASSET = "ast_pf";
const KEY = "org_pf/assets/ast_pf/normalized.jpg";

/** Records every signing request so a test can assert what was signed, and with what TTL. */
class FakeStorage implements ObjectStorage {
  readonly signed: { key: string; ttl: number }[] = [];
  existing = new Set<string>([KEY]);
  failOn: "none" | "exists" | "sign" = "none";

  exists(key: string): Promise<boolean> {
    if (this.failOn === "exists") return Promise.reject(new Error("storage down"));
    return Promise.resolve(this.existing.has(key));
  }
  createSignedDownloadUrl(key: string, ttlSeconds: number): Promise<SignedUrl> {
    if (this.failOn === "sign") return Promise.reject(new Error("storage down"));
    this.signed.push({ key, ttl: ttlSeconds });
    return Promise.resolve({
      url: `download://${key}?sig=secret-token`,
      expiresAt: new Date(Date.UTC(2026, 0, 1, 0, 10, 0)),
    });
  }
  createSignedUploadUrl(): Promise<SignedUrl> {
    throw new Error("preflight must never request an upload URL");
  }
  putObject(): Promise<void> {
    throw new Error("preflight must never write an object");
  }
  getObject(): Promise<Uint8Array | null> {
    throw new Error("preflight must never download the object itself");
  }
  deleteObject(): Promise<void> {
    throw new Error("preflight must never delete an object");
  }
}

const CAPABILITY: VideoModelCapability = {
  providerName: "fake",
  providerModelId: "fake/image-to-video",
  durationSeconds: { kind: "RANGE", minSeconds: 1, maxSeconds: 10 },
  resolutions: ["1080p"],
  aspectRatios: { kind: "PROVIDER_HONORED", ratios: ["16:9"] },
  negativePrompt: { kind: "UNSUPPORTED" },
  cameraMotion: { kind: "PROMPT_RENDERED" },
};

function capabilities(overrides: Partial<VideoModelCapability> = {}): VideoModelCapabilityProvider {
  return { current: () => ({ ...CAPABILITY, ...overrides }) };
}

function asset(overrides: Partial<MediaAsset> = {}): Omit<MediaAsset, "createdAt" | "updatedAt"> {
  return {
    id: ASSET,
    organizationId: ORG,
    propertyId: "prp_pf",
    storageKey: KEY,
    originalFilename: "kitchen.jpg",
    mimeType: "image/jpeg",
    sizeBytes: 2048,
    width: 1920,
    height: 1080,
    sha256: "abc",
    perceptualHash: null,
    status: "READY",
    failureReason: null,
    thumbnailKey: null,
    createdBy: "usr_pf",
    deletionRequestedAt: null,
    retentionExpiresAt: null,
    ...overrides,
  };
}

/** A generation whose stored hash genuinely matches its stored facts. */
function generation(overrides: Partial<SceneGeneration> = {}): SceneGeneration {
  const now = new Date("2026-01-01T00:00:00.000Z");
  const base: SceneGeneration = {
    id: "gen_pf",
    videoProjectId: "vpr_pf",
    sourceStoryboardSceneId: "scn_pf",
    assetId: ASSET,
    sourceAnalysisRevision: 1,
    requestHash: "placeholder",
    providerName: "fake",
    providerModelId: "fake/image-to-video",
    requestCompiledPrompt: '{"preservation":["keep the window"],"sceneFacts":{},"userCustomization":null}',
    requestDurationSeconds: 5,
    requestCameraMotion: "SLOW_PAN_LEFT",
    requestAspectRatio: "16:9",
    requestResolution: "1080p",
    requestRenderedPrompt: "Preservation rules:\n- keep the window",
    state: "QUEUED",
    providerPredictionId: null,
    submittedAt: null,
    lastPolledAt: null,
    normalizedErrorCode: null,
    normalizedErrorMessage: null,
    outputStorageKey: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
  // Recomputed rather than hard-coded so a fixture never silently drifts out of
  // agreement with its own facts and turns every test into a hash-mismatch.
  if (overrides.requestHash !== undefined) return base;
  return {
    ...base,
    requestHash: computeGenerationRequestHash({
      assetId: base.assetId,
      compiledPrompt: base.requestCompiledPrompt!,
      durationSeconds: base.requestDurationSeconds!,
      cameraMotion: base.requestCameraMotion,
      aspectRatio: base.requestAspectRatio!,
      resolution: base.requestResolution!,
      providerName: base.providerName,
      providerModelId: base.providerModelId,
    }),
  };
}

function candidateFor(gen: SceneGeneration, organizationId = ORG): SystemGenerationCandidate {
  return { organizationId, generation: gen };
}

async function fixture(
  opts: {
    readonly assetOverrides?: Partial<MediaAsset>;
    readonly capability?: Partial<VideoModelCapability>;
    readonly seedAsset?: boolean;
  } = {},
): Promise<{ deps: ExecutionPreflightDeps; storage: FakeStorage }> {
  const assets = new InMemoryMediaAssetRepository({ now: () => new Date("2026-01-01T00:00:00Z") });
  if (opts.seedAsset !== false) await assets.create(asset(opts.assetOverrides));
  const storage = new FakeStorage();
  return { deps: { assets, storage, capabilities: capabilities(opts.capability) }, storage };
}

async function refusalFrom(
  deps: ExecutionPreflightDeps,
  candidate: SystemGenerationCandidate,
): Promise<PreflightRefusalError> {
  try {
    await prepareQueuedGeneration(deps, candidate);
  } catch (error) {
    if (error instanceof PreflightRefusalError) return error;
    throw error;
  }
  throw new Error("expected a PreflightRefusalError, but preparation succeeded");
}

describe("prepareQueuedGeneration — the prepared artifact", () => {
  it("builds every field from the frozen snapshot and a freshly signed URL", async () => {
    const { deps, storage } = await fixture();
    const gen = generation();

    const prepared = await prepareQueuedGeneration(deps, candidateFor(gen));

    expect(prepared).toEqual({
      generationId: "gen_pf",
      organizationId: ORG,
      providerName: "fake",
      providerModelId: "fake/image-to-video",
      sourceImageUrl: `download://${KEY}?sig=secret-token`,
      sourceUrlExpiresAt: new Date(Date.UTC(2026, 0, 1, 0, 10, 0)),
      prompt: "Preservation rules:\n- keep the window",
      durationSeconds: 5,
      aspectRatio: "16:9",
      resolution: "1080p",
      requestHash: gen.requestHash,
    });
    expect(storage.signed).toEqual([{ key: KEY, ttl: 600 }]);
  });

  it("signs for longer than a human download, which is why the constant is its own", async () => {
    // Asserting the literal above would pass whatever the constant said if both
    // moved together. The property that actually matters is the relationship:
    // this URL has to survive preparation, the claim, the submission POST and
    // the provider's own fetch — not one browser click.
    expect(PREFLIGHT_SOURCE_URL_TTL_SECONDS).toBeGreaterThan(DOWNLOAD_URL_TTL_SECONDS);
  });

  it("submits the admitted settings, not whatever the row's neighbours now say", async () => {
    // The defect this guards is invisible at runtime: reading the project's
    // current aspect ratio or the asset's real dimensions would still produce a
    // plausible request, under a requestHash that still validated — for work
    // the customer never approved (ADR-0018 §3).
    // The asset is 4:3 and the deployment's model advertises only 16:9 / 1080p.
    // The snapshot says 9:16 / 720p, so every other source of these values
    // disagrees with it — and the snapshot is the one that must win.
    const { deps } = await fixture({ assetOverrides: { width: 640, height: 480 } });
    const gen = generation({
      requestAspectRatio: "9:16",
      requestResolution: "720p",
      requestDurationSeconds: 3,
    });

    const prepared = await prepareQueuedGeneration(deps, candidateFor(gen));

    expect(prepared.aspectRatio).toBe("9:16");
    expect(prepared.resolution).toBe("720p");
    expect(prepared.durationSeconds).toBe(3);
  });

  it("never re-renders the prompt", async () => {
    // The stored bytes are submitted verbatim, whatever a renderer would
    // produce today (ADR-0023).
    const { deps } = await fixture();
    const frozen = "text a current renderer would never produce";

    const prepared = await prepareQueuedGeneration(
      deps,
      candidateFor(generation({ requestRenderedPrompt: frozen })),
    );

    expect(prepared.prompt).toBe(frozen);
  });

  it("leaves the generation exactly as it found it", async () => {
    // Preparation is read-only by construction — there is no repository on the
    // deps that could write a generation — so this asserts the whole row.
    const { deps } = await fixture();
    const gen = generation();
    const before = { ...gen };

    await prepareQueuedGeneration(deps, candidateFor(gen));

    expect(gen).toEqual(before);
    expect(gen.state).toBe("QUEUED");
  });
});

describe("prepareQueuedGeneration — refusals", () => {
  it("refuses a row admitted before the request snapshot existed", async () => {
    const { deps } = await fixture();
    const legacy = generation({ requestCompiledPrompt: null, requestHash: "sha256:legacy" });

    expect((await refusalFrom(deps, candidateFor(legacy))).reason).toBe("LEGACY_SNAPSHOT_MISSING");
  });

  it("refuses a row admitted before the prompt freeze", async () => {
    const { deps } = await fixture();
    const legacy = generation({ requestRenderedPrompt: null });

    expect((await refusalFrom(deps, candidateFor(legacy))).reason).toBe("LEGACY_PROMPT_MISSING");
  });

  it("refuses when the stored hash disagrees with the stored facts", async () => {
    // Identity is what stops a provider being paid twice for one request. A row
    // whose hash no longer matches its facts has already lost it.
    const { deps } = await fixture();
    const tampered = generation({ requestHash: "sha256:not-the-real-digest" });

    expect((await refusalFrom(deps, candidateFor(tampered))).reason).toBe("REQUEST_HASH_MISMATCH");
  });

  it.each([
    ["provider", { providerName: "wavespeed" }],
    ["model", { providerModelId: "fake/some-other-model" }],
  ])("refuses when the deployment's %s no longer matches the admitted one", async (_label, cap) => {
    const { deps } = await fixture({ capability: cap });

    expect((await refusalFrom(deps, candidateFor(generation()))).reason).toBe(
      "PROVIDER_CONTRACT_CHANGED",
    );
  });

  it("refuses when the asset no longer exists", async () => {
    const { deps } = await fixture({ seedAsset: false });

    expect((await refusalFrom(deps, candidateFor(generation()))).reason).toBe("ASSET_NOT_FOUND");
  });

  it.each<MediaAssetStatus>(["PENDING_UPLOAD", "UPLOADED", "SCANNING", "PROCESSING"])(
    "treats a %s asset as not ready yet",
    async (status) => {
      const { deps } = await fixture({ assetOverrides: { status } });
      const refusal = await refusalFrom(deps, candidateFor(generation()));

      expect(refusal.reason).toBe("ASSET_NOT_READY");
      expect(refusal.retryable).toBe(true);
    },
  );

  it.each<MediaAssetStatus>(["QUARANTINED", "REJECTED", "FAILED", "DELETION_PENDING", "DELETED"])(
    "treats a %s asset as gone for good",
    async (status) => {
      const { deps } = await fixture({ assetOverrides: { status } });
      const refusal = await refusalFrom(deps, candidateFor(generation()));

      expect(refusal.reason).toBe("ASSET_GONE");
      expect(refusal.retryable).toBe(false);
    },
  );

  it("refuses a READY asset whose deletion the customer has already requested", async () => {
    // Retention can be requested while the row still reads READY. Submitting a
    // photo someone has asked to delete would be worse than refusing.
    const { deps } = await fixture({
      assetOverrides: { status: "READY", deletionRequestedAt: new Date("2026-01-01T00:00:00Z") },
    });

    expect((await refusalFrom(deps, candidateFor(generation()))).reason).toBe("ASSET_GONE");
  });

  it("refuses when the asset row points at an object storage does not have", async () => {
    const { deps, storage } = await fixture();
    storage.existing.clear();

    const refusal = await refusalFrom(deps, candidateFor(generation()));

    expect(refusal.reason).toBe("SOURCE_OBJECT_MISSING");
    expect(refusal.retryable).toBe(false);
    expect(storage.signed).toHaveLength(0);
  });

  it.each(["exists", "sign"] as const)(
    "classifies a storage failure during %s as unavailable rather than absent",
    async (failOn) => {
      const { deps, storage } = await fixture();
      storage.failOn = failOn;

      const refusal = await refusalFrom(deps, candidateFor(generation()));

      expect(refusal.reason).toBe("STORAGE_UNAVAILABLE");
      expect(refusal.retryable).toBe(true);
    },
  );

  it.each(SCENE_GENERATION_STATES.filter((s) => s !== "QUEUED"))(
    "rejects a %s generation as a caller error, not a refusal",
    async (state: SceneGenerationState) => {
      // No refusal reason, because Phase 4C-2B maps refusals *out of* QUEUED and
      // this row has already left it. Someone else owns it.
      const { deps } = await fixture();

      await expect(
        prepareQueuedGeneration(deps, candidateFor(generation({ state }))),
      ).rejects.toBeInstanceOf(AppError);
      await expect(
        prepareQueuedGeneration(deps, candidateFor(generation({ state }))),
      ).rejects.not.toBeInstanceOf(PreflightRefusalError);
    },
  );
});

describe("prepareQueuedGeneration — tenant isolation", () => {
  it("cannot reach an asset belonging to another organization", async () => {
    // The candidate's organizationId was resolved through VideoProject, so a
    // mismatch means the asset is somebody else's. The scoped read returns null
    // and no cross-tenant row is ever loaded.
    const { deps } = await fixture();

    const refusal = await refusalFrom(deps, candidateFor(generation(), OTHER_ORG));

    expect(refusal.reason).toBe("ASSET_NOT_FOUND");
  });

  it("signs nothing when the asset is not the caller's", async () => {
    const { deps, storage } = await fixture();

    await refusalFrom(deps, candidateFor(generation(), OTHER_ORG));

    expect(storage.signed).toHaveLength(0);
  });
});

describe("preflight refusals as a contract", () => {
  it("never leaks the signed URL, the storage key, or the prompt into a message", async () => {
    // Two of those are customer-authored and one is a credential. A refusal is
    // logged; the message is the part that travels.
    const { deps, storage } = await fixture();
    storage.existing.clear();

    const refusal = await refusalFrom(deps, candidateFor(generation()));

    expect(refusal.message).not.toContain(KEY);
    expect(refusal.message).not.toContain("secret-token");
    expect(refusal.message).not.toContain("keep the window");
  });

  it("carries INTERNAL_ERROR, because none of this is the customer's mistake", async () => {
    const { deps } = await fixture({ seedAsset: false });

    const refusal = await refusalFrom(deps, candidateFor(generation()));

    expect(refusal.code).toBe("INTERNAL_ERROR");
    expect(refusal.details).toEqual({ reason: "ASSET_NOT_FOUND" });
  });

  it("classifies retryability by whether the world could change", async () => {
    // Not by how the failure felt. A processing asset may become READY and
    // storage may come back; a missing frozen prompt never appears.
    const retryable: PreflightRefusalReason[] = ["ASSET_NOT_READY", "STORAGE_UNAVAILABLE"];
    const terminal: PreflightRefusalReason[] = [
      "LEGACY_SNAPSHOT_MISSING",
      "LEGACY_PROMPT_MISSING",
      "REQUEST_HASH_MISMATCH",
      "PROVIDER_CONTRACT_CHANGED",
      "ASSET_NOT_FOUND",
      "ASSET_GONE",
      "SOURCE_OBJECT_MISSING",
    ];

    for (const reason of retryable) expect(isRetryablePreflightRefusal(reason)).toBe(true);
    for (const reason of terminal) expect(isRetryablePreflightRefusal(reason)).toBe(false);
  });
});

describe("preflight holds no capability it should not", () => {
  it("declares no way to claim, submit, or write (compile-time)", () => {
    // Preparation must stay separable from claiming, and must never acquire a
    // provider: the whole reason the SUBMITTING window is narrow is that the
    // expensive step happens somewhere else.
    type ForbiddenNames =
      | "generations"
      | "execution"
      | "executionRepository"
      | "provider"
      | "videoProvider"
      | "videoGenerationProvider"
      | "queue"
      | "audit";
    type DeclaredForbidden = Extract<keyof ExecutionPreflightDeps, ForbiddenNames>;

    const noneDeclared: DeclaredForbidden extends never ? true : never = true;
    expect(noneDeclared).toBe(true);
  });
});
