import { describe, expect, it } from "vitest";
import { AppError } from "@app/shared";
import { DOWNLOAD_URL_TTL_SECONDS } from "../property/asset-service";
import type { MediaAsset, MediaAssetStatus } from "../property/types";
import type { SignedUrl } from "../property/ports";
import type { VideoModelCapability, VideoModelCapabilityProvider } from "./capability";
import type { SystemGenerationCandidate } from "./execution-ports";
import {
  PREFLIGHT_SOURCE_URL_TTL_SECONDS,
  prepareQueuedGeneration,
  type ExecutionPreflightDeps,
  type PreparedGeneration,
} from "./execution-preflight";
import {
  PREFLIGHT_REFUSAL_REASONS,
  PreflightRefusalError,
  preflightDispositionFor,
  type PreflightDisposition,
  type PreflightRefusalReason,
} from "./execution-preflight-errors";
import { computeGenerationRequestHash } from "./request-identity";
import { SCENE_GENERATION_STATES, type SceneGeneration, type SceneGenerationState } from "./types";

const ORG = "org_pf";
const OTHER_ORG = "org_pf_other";
const ASSET = "ast_pf";
const KEY = "org_pf/assets/ast_pf/normalized.jpg";
const OTHER_KEY = "org_pf/assets/ast_pf/normalized-v2.jpg";
const SIGNED_URL = `https://storage.example.test/${KEY}?sig=secret-token`;
const EXPIRES_AT = new Date(Date.UTC(2026, 0, 1, 0, 10, 0));

/** The narrowed capabilities preflight actually declares. */
type PreflightStorage = ExecutionPreflightDeps["storage"];
type PreflightAssets = ExecutionPreflightDeps["assets"];

/**
 * Records every call so a test can assert what was asked, and with what.
 *
 * Implements only what `ExecutionPreflightDeps` asks for — an earlier version
 * implemented the whole `ObjectStorage` and threw from the four write methods,
 * a runtime guard against calls the narrowed type now makes impossible.
 */
class FakeStorage implements PreflightStorage {
  readonly signed: { key: string; ttl: number }[] = [];
  readonly existsCalls: string[] = [];
  existing = new Set<string>([KEY, OTHER_KEY]);
  failOn: "none" | "exists" | "sign" = "none";
  /** What a successful signing returns. Overridden by the signed-URL tests. */
  result: SignedUrl = { url: SIGNED_URL, expiresAt: EXPIRES_AT };

  exists(key: string): Promise<boolean> {
    this.existsCalls.push(key);
    if (this.failOn === "exists") return Promise.reject(new Error(SECRET_BEARING_MESSAGE));
    return Promise.resolve(this.existing.has(key));
  }
  createSignedDownloadUrl(key: string, ttlSeconds: number): Promise<SignedUrl> {
    if (this.failOn === "sign") return Promise.reject(new Error(SECRET_BEARING_MESSAGE));
    this.signed.push({ key, ttl: ttlSeconds });
    return Promise.resolve(this.result);
  }
}

/** A storage error of the shape real SDKs throw: it names the key and a token. */
const SECRET_BEARING_MESSAGE = `PUT ${KEY} failed: signature=secret-token host=storage.example.test`;

/**
 * Hands out a different asset observation per read, in order.
 *
 * Implements `findById` alone — the narrowed dependency is the whole contract,
 * so there is nothing else to satisfy and no shared production abstraction to
 * add. It records the arguments of every read so a test can prove both used the
 * authoritative organization and the frozen asset id.
 */
class SequentialAssets implements PreflightAssets {
  readonly reads: { organizationId: string; assetId: string }[] = [];
  private index = 0;

  constructor(private readonly observations: readonly (MediaAsset | null)[]) {}

  findById(organizationId: string, id: string): Promise<MediaAsset | null> {
    this.reads.push({ organizationId, assetId: id });
    const observation = this.observations[Math.min(this.index, this.observations.length - 1)];
    this.index += 1;
    return Promise.resolve(organizationId === ORG ? (observation ?? null) : null);
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

function asset(overrides: Partial<MediaAsset> = {}): MediaAsset {
  const now = new Date("2026-01-01T00:00:00.000Z");
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
    thumbnailKey: "org_pf/assets/ast_pf/thumb.webp",
    createdBy: "usr_pf",
    deletionRequestedAt: null,
    retentionExpiresAt: null,
    createdAt: now,
    updatedAt: now,
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
    requestCompiledPrompt:
      '{"preservation":["keep the window"],"sceneFacts":{},"userCustomization":null}',
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

interface Fixture {
  readonly deps: ExecutionPreflightDeps;
  readonly storage: FakeStorage;
  readonly assets: SequentialAssets;
}

/** `observations` is read in order: the first for the pre-sign read, then the post-sign one. */
function fixture(
  observations: readonly (MediaAsset | null)[] = [asset()],
  capabilityOverrides: Partial<VideoModelCapability> = {},
): Fixture {
  const assets = new SequentialAssets(observations);
  const storage = new FakeStorage();
  return { deps: { assets, storage, capabilities: capabilities(capabilityOverrides) }, storage, assets };
}

async function refusalFrom(f: Fixture, candidate: SystemGenerationCandidate) {
  try {
    await prepareQueuedGeneration(f.deps, candidate);
  } catch (error) {
    if (error instanceof PreflightRefusalError) return error;
    throw error;
  }
  throw new Error("expected a PreflightRefusalError, but preparation succeeded");
}

describe("prepareQueuedGeneration — the prepared artifact", () => {
  it("builds every field from the frozen snapshot and a freshly signed URL", async () => {
    const f = fixture();
    const gen = generation();

    const prepared = await prepareQueuedGeneration(f.deps, candidateFor(gen));

    expect(prepared).toEqual({
      generationId: "gen_pf",
      organizationId: ORG,
      providerName: "fake",
      providerModelId: "fake/image-to-video",
      sourceImageUrl: SIGNED_URL,
      sourceUrlExpiresAt: EXPIRES_AT,
      prompt: "Preservation rules:\n- keep the window",
      durationSeconds: 5,
      aspectRatio: "16:9",
      resolution: "1080p",
      requestHash: gen.requestHash,
    } satisfies PreparedGeneration);
  });

  it("submits the admitted settings, not whatever the row's neighbours now say", async () => {
    // The asset is 4:3 and the deployment's model advertises only 16:9 / 1080p.
    // The snapshot says 9:16 / 720p, so every other source of these values
    // disagrees with it — and the snapshot is the one that must win.
    const f = fixture([asset({ width: 640, height: 480 })]);
    const gen = generation({
      requestAspectRatio: "9:16",
      requestResolution: "720p",
      requestDurationSeconds: 3,
    });

    const prepared = await prepareQueuedGeneration(f.deps, candidateFor(gen));

    expect(prepared.aspectRatio).toBe("9:16");
    expect(prepared.resolution).toBe("720p");
    expect(prepared.durationSeconds).toBe(3);
  });

  it("never re-renders the prompt", async () => {
    const f = fixture();
    const frozen = "text a current renderer would never produce";

    const prepared = await prepareQueuedGeneration(
      f.deps,
      candidateFor(generation({ requestRenderedPrompt: frozen })),
    );

    expect(prepared.prompt).toBe(frozen);
  });

  it("leaves the generation exactly as it found it", async () => {
    const f = fixture();
    const gen = generation();
    const before = { ...gen };

    await prepareQueuedGeneration(f.deps, candidateFor(gen));

    expect(gen).toEqual(before);
    expect(gen.state).toBe("QUEUED");
  });

  it("reads the asset twice, both scoped and both by the frozen id", async () => {
    const f = fixture([asset(), asset()]);

    await prepareQueuedGeneration(f.deps, candidateFor(generation()));

    expect(f.assets.reads).toEqual([
      { organizationId: ORG, assetId: ASSET },
      { organizationId: ORG, assetId: ASSET },
    ]);
  });
});

describe("the source URL", () => {
  it("signs the validated key for exactly the preflight TTL", async () => {
    const f = fixture();

    await prepareQueuedGeneration(f.deps, candidateFor(generation()));

    expect(f.storage.signed).toEqual([{ key: KEY, ttl: 600 }]);
  });

  it("declares that TTL as the literal 600", () => {
    expect(PREFLIGHT_SOURCE_URL_TTL_SECONDS).toBe(600);
  });

  it("signs for longer than a human download, which is why the constant is its own", () => {
    // Asserting the literal alone would pass whatever the constant said if both
    // moved together. The property that matters is the relationship: this URL
    // has to survive the claim, the submission POST and the provider's fetch.
    expect(PREFLIGHT_SOURCE_URL_TTL_SECONDS).toBeGreaterThan(DOWNLOAD_URL_TTL_SECONDS);
  });

  it("propagates the signer's expiry exactly, rather than computing one", async () => {
    // A locally computed expiry would drift from what storage actually issued,
    // and the caller would refuse or submit on the wrong answer.
    const f = fixture();
    const storageExpiry = new Date(Date.UTC(2030, 5, 5, 5, 5, 5));
    f.storage.result = { url: SIGNED_URL, expiresAt: storageExpiry };

    const prepared = await prepareQueuedGeneration(f.deps, candidateFor(generation()));

    expect(prepared.sourceUrlExpiresAt).toBe(storageExpiry);
  });

  it.each([
    ["a URL the runtime cannot parse", { url: "not a url at all", expiresAt: EXPIRES_AT }],
    ["a plain-HTTP URL", { url: `http://storage.example.test/${KEY}`, expiresAt: EXPIRES_AT }],
    ["an expiry that is not a real instant", { url: SIGNED_URL, expiresAt: new Date(NaN) }],
  ])("refuses %s", async (_label, result) => {
    // Each would be discovered by the provider — after the request was paid for.
    const f = fixture();
    f.storage.result = result as SignedUrl;

    const refusal = await refusalFrom(f, candidateFor(generation()));

    expect(refusal.reason).toBe("SIGNED_SOURCE_URL_UNUSABLE");
    expect(refusal.disposition).toBe("RETRYABLE");
  });

  // There is deliberately no "no host" case. Under the WHATWG parser every
  // string that yields protocol `https:` also yields a non-empty hostname, so a
  // constructed example would be testing the parser rather than this code. The
  // guard stays because it is cheap and the invariant is worth stating.
});

describe("the normalized source format", () => {
  it.each<[string, Partial<MediaAsset>]>([
    ["a non-JPEG normalized source", { mimeType: "image/webp" }],
    ["an empty storage key", { storageKey: "" }],
    ["a whitespace-only storage key", { storageKey: "   " }],
  ])("refuses %s, before touching storage", async (_label, overrides) => {
    // The media pipeline normalizes every accepted upload to JPEG, so a READY
    // asset that is not one is not the normalized master. A blank key is not
    // addressable at all.
    const f = fixture([asset(overrides)]);

    const refusal = await refusalFrom(f, candidateFor(generation()));

    expect(refusal.reason).toBe("ASSET_FORMAT_UNSUPPORTED");
    expect(refusal.disposition).toBe("TERMINAL");
    expect(f.storage.existsCalls).toHaveLength(0);
    expect(f.storage.signed).toHaveLength(0);
  });

  it("never reaches for the thumbnail", async () => {
    // `thumbnailKey` is a downscaled derivative; paying to animate it would be
    // a silent quality substitution.
    const f = fixture();

    await prepareQueuedGeneration(f.deps, candidateFor(generation()));

    expect(f.storage.signed.map((s) => s.key)).toEqual([KEY]);
    expect(f.storage.existsCalls).toEqual([KEY]);
  });
});

describe("refusals before signing", () => {
  it("refuses a row admitted before the request snapshot existed", async () => {
    const f = fixture();
    const legacy = generation({ requestCompiledPrompt: null, requestHash: "sha256:legacy" });

    expect((await refusalFrom(f, candidateFor(legacy))).reason).toBe("LEGACY_SNAPSHOT_MISSING");
  });

  it("refuses a row admitted before the prompt freeze", async () => {
    const f = fixture();

    expect(
      (await refusalFrom(f, candidateFor(generation({ requestRenderedPrompt: null })))).reason,
    ).toBe("LEGACY_PROMPT_MISSING");
  });

  it("refuses when the stored hash disagrees with the stored facts", async () => {
    const f = fixture();

    expect(
      (await refusalFrom(f, candidateFor(generation({ requestHash: "sha256:wrong" })))).reason,
    ).toBe("REQUEST_HASH_MISMATCH");
  });

  it.each([
    ["provider", { providerName: "wavespeed" }],
    ["model", { providerModelId: "fake/some-other-model" }],
  ])("refuses when the deployment's %s no longer matches the admitted one", async (_l, cap) => {
    const f = fixture([asset()], cap);

    expect((await refusalFrom(f, candidateFor(generation()))).reason).toBe(
      "PROVIDER_IDENTITY_MISMATCH",
    );
  });

  it("refuses when the asset no longer exists", async () => {
    const f = fixture([null]);

    expect((await refusalFrom(f, candidateFor(generation()))).reason).toBe("ASSET_NOT_FOUND");
  });

  it.each<MediaAssetStatus>(["PENDING_UPLOAD", "UPLOADED", "SCANNING", "PROCESSING"])(
    "treats a %s asset as not ready yet",
    async (status) => {
      const refusal = await refusalFrom(fixture([asset({ status })]), candidateFor(generation()));

      expect(refusal.reason).toBe("ASSET_NOT_READY");
      expect(refusal.disposition).toBe("RETRYABLE");
    },
  );

  it("treats a FAILED upload as recoverable, because retryUpload accepts it", async () => {
    // `AssetService.retryUpload` resets a FAILED asset to PENDING_UPLOAD on the
    // same id, so its source can still arrive. Grouping it with deleted and
    // quarantined assets would permanently fail an attempt whose photo is one
    // customer action away — found in review of this milestone.
    const refusal = await refusalFrom(
      fixture([asset({ status: "FAILED" })]),
      candidateFor(generation()),
    );

    expect(refusal.reason).toBe("ASSET_UPLOAD_FAILED");
    expect(refusal.disposition).toBe("RETRYABLE");
  });

  it.each<MediaAssetStatus>(["QUARANTINED", "REJECTED", "DELETION_PENDING", "DELETED"])(
    "treats a %s asset as unrecoverable",
    async (status) => {
      const refusal = await refusalFrom(fixture([asset({ status })]), candidateFor(generation()));

      expect(refusal.reason).toBe("ASSET_UNRECOVERABLE");
      expect(refusal.disposition).toBe("TERMINAL");
    },
  );

  it("refuses a READY asset whose deletion the customer has already requested", async () => {
    const f = fixture([asset({ deletionRequestedAt: new Date("2026-01-01T00:00:00Z") })]);

    expect((await refusalFrom(f, candidateFor(generation()))).reason).toBe("ASSET_UNRECOVERABLE");
  });

  it("refuses when the asset row points at an object storage does not have", async () => {
    const f = fixture();
    f.storage.existing.clear();

    const refusal = await refusalFrom(f, candidateFor(generation()));

    expect(refusal.reason).toBe("ASSET_OBJECT_MISSING");
    expect(refusal.disposition).toBe("TERMINAL");
    expect(f.storage.signed).toHaveLength(0);
  });

  it.each(["exists", "sign"] as const)(
    "classifies a storage failure during %s as unavailable rather than absent",
    async (failOn) => {
      const f = fixture();
      f.storage.failOn = failOn;

      const refusal = await refusalFrom(f, candidateFor(generation()));

      expect(refusal.reason).toBe("STORAGE_UNAVAILABLE");
      expect(refusal.disposition).toBe("RETRYABLE");
    },
  );

  it.each(SCENE_GENERATION_STATES.filter((s) => s !== "QUEUED"))(
    "rejects a %s generation as a caller error, not a refusal",
    async (state: SceneGenerationState) => {
      const f = fixture();
      const candidate = candidateFor(generation({ state }));

      await expect(prepareQueuedGeneration(f.deps, candidate)).rejects.toBeInstanceOf(AppError);
      await expect(prepareQueuedGeneration(f.deps, candidate)).rejects.not.toBeInstanceOf(
        PreflightRefusalError,
      );
    },
  );
});

describe("the asset can change while the URL is being signed", () => {
  // Each case signs successfully, then finds a different world on the second
  // read. None may return a PreparedGeneration: the caller would be holding a
  // credential for a source that is no longer the admitted one.
  it.each<[string, MediaAsset | null, PreflightRefusalReason, PreflightDisposition]>([
    ["disappears", null, "ASSET_NOT_FOUND", "TERMINAL"],
    [
      "is marked for deletion",
      asset({ status: "DELETION_PENDING" }),
      "ASSET_UNRECOVERABLE",
      "TERMINAL",
    ],
    ["goes back to processing", asset({ status: "PROCESSING" }), "ASSET_NOT_READY", "RETRYABLE"],
    ["fails", asset({ status: "FAILED" }), "ASSET_UPLOAD_FAILED", "RETRYABLE"],
    ["is repointed at another key", asset({ storageKey: OTHER_KEY }), "ASSET_SOURCE_CHANGED", "TERMINAL"],
    ["changes format", asset({ mimeType: "image/png" }), "ASSET_SOURCE_CHANGED", "TERMINAL"],
  ])("refuses when the asset %s after signing", async (_label, second, reason, disposition) => {
    const f = fixture([asset(), second]);

    const refusal = await refusalFrom(f, candidateFor(generation()));

    expect(refusal.reason).toBe(reason);
    expect(refusal.disposition).toBe(disposition);
    // Signing already happened — that is the point of checking again after it.
    expect(f.storage.signed).toEqual([{ key: KEY, ttl: 600 }]);
    // And the signed URL went nowhere: nothing is returned and nothing stored.
    expect(f.assets.reads).toHaveLength(2);
  });

  it("uses the same authoritative organization and frozen asset id for both reads", async () => {
    const f = fixture([asset(), asset({ storageKey: OTHER_KEY })]);

    await refusalFrom(f, candidateFor(generation()));

    expect(f.assets.reads).toEqual([
      { organizationId: ORG, assetId: ASSET },
      { organizationId: ORG, assetId: ASSET },
    ]);
  });
});

describe("tenant isolation", () => {
  it("cannot reach an asset belonging to another organization", async () => {
    // The candidate's organizationId was resolved through VideoProject, so a
    // mismatch means the asset is somebody else's. The scoped read returns null
    // and no cross-tenant row is ever loaded.
    const f = fixture();

    const refusal = await refusalFrom(f, candidateFor(generation(), OTHER_ORG));

    expect(refusal.reason).toBe("ASSET_NOT_FOUND");
    expect(refusal.disposition).toBe("TERMINAL");
    expect(f.assets.reads).toEqual([{ organizationId: OTHER_ORG, assetId: ASSET }]);
    expect(f.storage.existsCalls).toHaveLength(0);
    expect(f.storage.signed).toHaveLength(0);
  });
});

describe("the refusal contract", () => {
  it("maps every reason to a disposition, and nothing else does", () => {
    // One exhaustive Record is the canonical answer. There is no second
    // retryable list and no terminal list — two sources would disagree
    // eventually, and this is the wrong place to find that out.
    const retryable: PreflightRefusalReason[] = [
      "ASSET_NOT_READY",
      "ASSET_UPLOAD_FAILED",
      "STORAGE_UNAVAILABLE",
      "SIGNED_SOURCE_URL_UNUSABLE",
    ];
    const terminal: PreflightRefusalReason[] = [
      "LEGACY_SNAPSHOT_MISSING",
      "LEGACY_PROMPT_MISSING",
      "REQUEST_HASH_MISMATCH",
      "PROVIDER_IDENTITY_MISMATCH",
      "ASSET_NOT_FOUND",
      "ASSET_UNRECOVERABLE",
      "ASSET_FORMAT_UNSUPPORTED",
      "ASSET_SOURCE_CHANGED",
      "ASSET_OBJECT_MISSING",
    ];

    for (const reason of retryable) expect(preflightDispositionFor(reason)).toBe("RETRYABLE");
    for (const reason of terminal) expect(preflightDispositionFor(reason)).toBe("TERMINAL");
    expect([...retryable, ...terminal].sort()).toEqual([...PREFLIGHT_REFUSAL_REASONS].sort());
  });

  it("has exactly thirteen reasons", () => {
    expect(PREFLIGHT_REFUSAL_REASONS).toHaveLength(13);
    expect(new Set(PREFLIGHT_REFUSAL_REASONS).size).toBe(13);
  });

  it("derives disposition from the reason rather than accepting one", () => {
    const refusal = new PreflightRefusalError("ASSET_NOT_READY", "fixed text");

    expect(refusal.disposition).toBe(preflightDispositionFor("ASSET_NOT_READY"));
    expect(refusal.code).toBe("INTERNAL_ERROR");
    expect(refusal.details).toEqual({ reason: "ASSET_NOT_READY" });
  });

  it("lets a programmer error escape instead of relabelling it as legacy", async () => {
    // Converting every throw would tell a future durable mapper to permanently
    // fail customer work over a defect in this code. Only the fail-closed
    // INTERNAL_ERROR shape is translated, detected by type and code rather than
    // by matching message text.
    const f = fixture();
    const boom = new TypeError("reading 'x' of undefined");
    const brokenGeneration = new Proxy(generation(), {
      get(target, property, receiver) {
        if (property === "requestCompiledPrompt") throw boom;
        return Reflect.get(target, property, receiver);
      },
    });

    await expect(
      prepareQueuedGeneration(f.deps, candidateFor(brokenGeneration)),
    ).rejects.toBeInstanceOf(TypeError);
  });
});

describe("a refusal is safe to log whole", () => {
  const forbidden = [
    "secret-token",
    KEY,
    "storage.example.test",
    "keep the window",
    "Preservation rules",
  ];

  function assertNothingLeaked(refusal: PreflightRefusalError, gen: SceneGeneration): void {
    // Only the public surface — that is what a structured logger serializes.
    const exposed = JSON.stringify({
      message: refusal.message,
      details: refusal.details,
      reason: refusal.reason,
      disposition: refusal.disposition,
    });
    for (const secret of forbidden) expect(exposed).not.toContain(secret);
    expect(exposed).not.toContain(ORG);
    expect(exposed).not.toContain(ASSET);
    expect(exposed).not.toContain(gen.requestHash);
  }

  it("drops a storage error that names the key and a credential", async () => {
    // The thrown dependency error deliberately carries both. Before the raw
    // cause was removed, attaching it would have carried them into the refusal.
    const f = fixture();
    f.storage.failOn = "exists";
    const gen = generation();

    const refusal = await refusalFrom(f, candidateFor(gen));

    expect(refusal.reason).toBe("STORAGE_UNAVAILABLE");
    expect(refusal.cause).toBeUndefined();
    assertNothingLeaked(refusal, gen);
  });

  it("names nothing when the signed URL itself is unusable", async () => {
    const f = fixture();
    f.storage.result = { url: `http://storage.example.test/${KEY}?sig=secret-token`, expiresAt: EXPIRES_AT };
    const gen = generation();

    assertNothingLeaked(await refusalFrom(f, candidateFor(gen)), gen);
  });

  it("names nothing when the asset is refused", async () => {
    const f = fixture([asset({ status: "QUARANTINED" })]);
    const gen = generation();

    assertNothingLeaked(await refusalFrom(f, candidateFor(gen)), gen);
  });
});

describe("preflight holds no capability it should not", () => {
  it("declares no way to claim, submit, or write (compile-time)", () => {
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

  it("holds no method that could mutate an asset or an object (compile-time)", () => {
    // The dependencies are narrowed with `Pick`, so "preparation changes
    // nothing" is enforced by the compiler rather than asserted in prose. If
    // either were widened back to the full interface, these stop compiling.
    type AssetMethods = keyof ExecutionPreflightDeps["assets"];
    type StorageMethods = keyof ExecutionPreflightDeps["storage"];

    const assetsReadOnly: AssetMethods extends "findById" ? true : never = true;
    const storageReadOnly: StorageMethods extends "exists" | "createSignedDownloadUrl"
      ? true
      : never = true;

    expect(assetsReadOnly && storageReadOnly).toBe(true);
  });
});
