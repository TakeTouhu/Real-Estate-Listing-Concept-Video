import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  AttemptFailureSettlementRunner,
  AttemptSubmissionRunner,
  CompositionPlanRunner,
  DISCLOSURE_LAYER_ASSETS,
  DeliverableCompositionRunner,
  DeliverableValidationRunner,
  FailedJobSceneClosureRunner,
  JobLaunchRunner,
  MediaFailureResolutionRunner,
  MediaValidationLifecycleRunner,
  ValidatedSceneDeliveryRunner,
  validateReconciliationPolicy,
} from "@app/domain";
import {
  DEVELOPMENT_DISCLOSURE_LAYER_DIRECTORY,
  DEVELOPMENT_RECONCILIATION,
  DEVELOPMENT_SIGNED_URL_BASE,
  assembleDevelopmentPipeline,
  developmentPipelineContext,
  type DevelopmentPipelineEnv,
} from "./assembly";

const SECRET = "assembly-signing-secret-0123456789";
/** Never connected to: building the steps queries nothing. */
const prisma = new PrismaClient({ datasourceUrl: "postgresql://unused:unused@localhost:1/unused" });

let dir: string;
let n = 0;

/** A fresh pair of folders that do not exist yet. */
function folders(): { shared: string; provider: string } {
  n += 1;
  return { shared: join(dir, `shared-${n}`), provider: join(dir, `provider-${n}`) };
}

/** A Cloud Storage emulator's settings in place of the folder. Nothing listens at this address. */
const EMULATOR = {
  SHARED_STORAGE_DIR: undefined,
  GOOGLE_CLOUD_STORAGE_BUCKET: "vtavision-dev",
  GOOGLE_CLOUD_STORAGE_ENDPOINT: "http://127.0.0.1:1",
} as const;
const NO_STORE = "The development pipeline needs SHARED_STORAGE_DIR, or a Cloud Storage emulator's bucket and endpoint";
const NOT_GOOGLE = "The development pipeline uses a Cloud Storage emulator, never Google's own store";
const NOT_BOTH = "The development pipeline takes SHARED_STORAGE_DIR or the Cloud Storage settings, not both";
const { GOOGLE_CLOUD_STORAGE_BUCKET: BUCKET, GOOGLE_CLOUD_STORAGE_ENDPOINT: ENDPOINT } = EMULATOR;
/** The emulator's settings with another endpoint. */
const at = (endpoint: string | undefined) => ({ ...EMULATOR, GOOGLE_CLOUD_STORAGE_ENDPOINT: endpoint });

/** Each way the environment can name a store the pipeline refuses (ADR-0162), and the refusal. */
const REFUSED_STORES: readonly (readonly [string, Partial<DevelopmentPipelineEnv>, string])[] = [
  ["no store", { SHARED_STORAGE_DIR: undefined }, NO_STORE],
  ["a bucket and an endpoint beside the folder", { ...EMULATOR, SHARED_STORAGE_DIR: "/unused" }, NOT_BOTH],
  ["an endpoint beside the folder", { GOOGLE_CLOUD_STORAGE_ENDPOINT: ENDPOINT }, NOT_BOTH],
  ["a bucket beside the folder", { GOOGLE_CLOUD_STORAGE_BUCKET: BUCKET }, NOT_BOTH],
  [
    "an endpoint with no bucket",
    { ...EMULATOR, GOOGLE_CLOUD_STORAGE_BUCKET: undefined },
    "The development pipeline needs GOOGLE_CLOUD_STORAGE_BUCKET with GOOGLE_CLOUD_STORAGE_ENDPOINT",
  ],
  ["a bucket alone, which is Google's own store", at(undefined), NOT_GOOGLE],
  ...[
    "https://storage.googleapis.com",
    "https://STORAGE.googleapis.com:443/",
    "https://storage.googleapis.com./",
    "https://storage%2Egoogleapis.com",
    "https://storage.googleapis.com\t",
    "http://storage.googleapis.com",
    "https://storage.asia-northeast1.rep.googleapis.com",
    "https://googleapis.com",
    "http://127.0.0.1.storage.googleapis.com:4443",
  ].map((endpoint) => [`an endpoint at ${endpoint}`, at(endpoint), NOT_GOOGLE] as const),
  // The adapter's own refusals, made as it is built, before anything is asked.
  ...["not an address", "http://", "ftp://127.0.0.1:4443", "http://127.0.0.1:4443/v1", "http://u:p@127.0.0.1:4443"].map(
    (endpoint) =>
      [
        `an endpoint that is not an http origin (${endpoint})`,
        at(endpoint),
        "The storage endpoint must be an http or https origin",
      ] as const,
  ),
  [
    "a bucket Cloud Storage cannot name",
    { ...EMULATOR, GOOGLE_CLOUD_STORAGE_BUCKET: "Shared_Folder/x" },
    "The storage bucket must be named by Cloud Storage's rules",
  ],
];

function env(shared: string, overrides: Partial<DevelopmentPipelineEnv> = {}): DevelopmentPipelineEnv {
  return {
    NODE_ENV: "test",
    VIDEO_PROVIDER: "fake",
    SHARED_STORAGE_DIR: shared,
    STORAGE_SIGNING_SECRET: SECRET,
    ...overrides,
  };
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "devpipe-assembly-"));
});

afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
  await prisma.$disconnect();
});

describe("assembling the development pipeline", () => {
  it.each([
    ["production", { NODE_ENV: "production" }, "The development pipeline is refused in production"],
    ["another provider", { VIDEO_PROVIDER: "wavespeed" }, "The development pipeline needs VIDEO_PROVIDER=fake"],
  ] as const)("is refused with %s, before anything is opened", (_, overrides, message) => {
    const { shared, provider } = folders();
    expect(() => assembleDevelopmentPipeline(env(shared, overrides), { providerFolder: provider }, { prisma })).toThrow(
      expect.objectContaining({ code: "CONFIGURATION_ERROR", message }),
    );
    expect([existsSync(shared), existsSync(provider)]).toEqual([false, false]);
  });

  it.each([
    ["production", { NODE_ENV: "production", ...at(undefined) }, "The development pipeline is refused in production"],
    [
      "another provider",
      { VIDEO_PROVIDER: "wavespeed", SHARED_STORAGE_DIR: undefined },
      "The development pipeline needs VIDEO_PROVIDER=fake",
    ],
  ] as const)("refuses %s before it reads the store's settings (ADR-0162)", (_, overrides, message) => {
    const { shared, provider } = folders();
    expect(() => assembleDevelopmentPipeline(env(shared, overrides), { providerFolder: provider }, { prisma })).toThrow(
      expect.objectContaining({ code: "CONFIGURATION_ERROR", message }),
    );
  });

  it.each(REFUSED_STORES)("is refused with %s, before anything is opened", (_, overrides, message) => {
    const { shared, provider } = folders();
    expect(() => assembleDevelopmentPipeline(env(shared, overrides), { providerFolder: provider }, { prisma })).toThrow(
      expect.objectContaining({ code: "CONFIGURATION_ERROR", message }),
    );
    expect([existsSync(shared), existsSync(provider)]).toEqual([false, false]);
  });

  it("is refused in production with an emulator too, by either value, before anything is opened", () => {
    const { provider } = folders();
    const production = env("/unused", { ...EMULATOR, NODE_ENV: "production" });
    expect(() => assembleDevelopmentPipeline(production, { providerFolder: provider }, { prisma })).toThrow(
      "The development pipeline is refused in production",
    );
    vi.stubEnv("NODE_ENV", "production");
    const given = env("/unused", EMULATOR);
    expect(() => assembleDevelopmentPipeline(given, { providerFolder: provider }, { prisma })).toThrow(
      "The development pipeline is refused in production",
    );
    expect(existsSync(provider)).toBe(false);
  });

  it("builds every step on an emulator's bucket, asking it nothing as it is built", async () => {
    const asked: string[] = [];
    const store = createServer((request, response) => {
      asked.push(`${request.method} ${request.url}`);
      response.writeHead(500).end();
    });
    await new Promise<void>((listening) => store.listen(0, "127.0.0.1", listening));
    try {
      const endpoint = `http://127.0.0.1:${(store.address() as AddressInfo).port}`;
      const { shared, provider } = folders();
      const emulator = env(shared, at(endpoint));
      const steps = assembleDevelopmentPipeline(emulator, { providerFolder: provider }, { prisma });
      expect(steps.providerOutput.runProviderOutputBatchOnce).toBeTypeOf("function");
      expect(steps.composition).toBeInstanceOf(DeliverableCompositionRunner);
      expect(steps.deliverableValidation).toBeInstanceOf(DeliverableValidationRunner);
      // The test provider keeps its clips in its own folder; no shared folder is made.
      expect([existsSync(shared), existsSync(join(provider, "clips"))]).toEqual([false, true]);
      // A request sent while the steps were built would have reached the stand-in by now.
      await new Promise((settled) => setTimeout(settled, 250));
      expect(asked).toEqual([]);
    } finally {
      await new Promise((closed) => store.close(closed));
    }
  });

  it("is refused when the process runs in production, whatever it is given", () => {
    vi.stubEnv("NODE_ENV", "production");
    const { shared, provider } = folders();
    expect(() => assembleDevelopmentPipeline(env(shared), { providerFolder: provider }, { prisma })).toThrow(
      "The development pipeline is refused in production",
    );
    expect([existsSync(shared), existsSync(provider)]).toEqual([false, false]);
  });

  it("is refused with a relative folder for the test provider, before anything is opened", () => {
    const { shared } = folders();
    expect(() => assembleDevelopmentPipeline(env(shared), { providerFolder: "provider" }, { prisma })).toThrow(
      expect.objectContaining({
        code: "CONFIGURATION_ERROR",
        message: "The test provider's folder must be an absolute path",
      }),
    );
    expect(existsSync(shared)).toBe(false);
  });

  it.each([
    ["no store", { SHARED_STORAGE_DIR: undefined }, NO_STORE],
    ["Google's own store", at(undefined), NOT_GOOGLE],
  ] as const)("refuses %s before a relative test provider folder, in ADR-0106's order", (_, overrides, message) => {
    const given = env(folders().shared, overrides);
    expect(() => assembleDevelopmentPipeline(given, { providerFolder: "provider" }, { prisma })).toThrow(
      expect.objectContaining({ code: "CONFIGURATION_ERROR", message }),
    );
  });

  it("builds every step on the test provider and the shared folder", () => {
    const { shared, provider } = folders();
    const steps = assembleDevelopmentPipeline(env(shared), { providerFolder: provider }, { prisma });
    expect(steps.launch).toBeInstanceOf(JobLaunchRunner);
    expect(steps.submission).toBeInstanceOf(AttemptSubmissionRunner);
    expect(steps.attemptFailureSettlement).toBeInstanceOf(AttemptFailureSettlementRunner);
    expect(steps.failedJobSceneClosure).toBeInstanceOf(FailedJobSceneClosureRunner);
    expect(typeof steps.providerOutput.runProviderOutputBatchOnce).toBe("function");
    expect(typeof steps.reconciliation.runOnce).toBe("function");
    expect(steps.mediaValidation).toBeInstanceOf(MediaValidationLifecycleRunner);
    expect(steps.mediaFailureResolution).toBeInstanceOf(MediaFailureResolutionRunner);
    expect(steps.sceneDelivery).toBeInstanceOf(ValidatedSceneDeliveryRunner);
    expect(steps.compositionPlan).toBeInstanceOf(CompositionPlanRunner);
    expect(steps.composition).toBeInstanceOf(DeliverableCompositionRunner);
    expect(steps.deliverableValidation).toBeInstanceOf(DeliverableValidationRunner);
    expect([existsSync(shared), existsSync(join(provider, "clips"))]).toEqual([true, true]);
  });

  it("composes with the repository's own disclosure images", () => {
    const repository = join(__dirname, "..", "..", "..", "..");
    expect(DEVELOPMENT_DISCLOSURE_LAYER_DIRECTORY).toBe(join(repository, "assets", "disclosure"));
    // Every image the composer may ask for is there, as committed.
    for (const layer of DISCLOSURE_LAYER_ASSETS) {
      const bytes = readFileSync(join(DEVELOPMENT_DISCLOSURE_LAYER_DIRECTORY, layer.fileName));
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      expect([layer.fileName, sha256]).toEqual([layer.fileName, layer.sha256]);
    }
  });

  it("signs photo URLs under an https base whose host never resolves", () => {
    const base = new URL(DEVELOPMENT_SIGNED_URL_BASE);
    expect([base.protocol, base.hostname, base.pathname]).toEqual(["https:", "development.invalid", "/api/storage"]);
  });

  it("uses a reconciliation policy that validates, with the stale threshold inside the window", () => {
    expect(validateReconciliationPolicy(DEVELOPMENT_RECONCILIATION).ok).toBe(true);
    expect(DEVELOPMENT_RECONCILIATION.staleSubmittingAfterMs).toBeLessThan(
      DEVELOPMENT_RECONCILIATION.reconciliationWindowMs,
    );
  });

  it("gives each transition a worker's context with its own correlation", () => {
    const first = developmentPipelineContext("launch");
    const second = developmentPipelineContext("launch");
    expect(first).toEqual({
      actorType: "WORKER",
      actorUserId: null,
      correlationId: expect.stringMatching(/^corr_/),
      causationId: null,
      reasonCode: null,
      eventType: "pipeline.launch",
      metadata: {},
    });
    expect(second.correlationId).not.toBe(first.correlationId);
    expect(developmentPipelineContext("provider_output").eventType).toBe("pipeline.provider_output");
    expect(developmentPipelineContext("deliverable_validation").eventType).toBe("pipeline.deliverable_validation");
  });
});
