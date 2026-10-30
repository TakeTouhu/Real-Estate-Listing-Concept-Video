import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
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
    ["no shared folder", { SHARED_STORAGE_DIR: undefined }, "The development pipeline needs SHARED_STORAGE_DIR"],
  ] as const)("is refused with %s, before anything is opened", (_, overrides, message) => {
    const { shared, provider } = folders();
    expect(() => assembleDevelopmentPipeline(env(shared, overrides), { providerFolder: provider }, { prisma })).toThrow(
      expect.objectContaining({ code: "CONFIGURATION_ERROR", message }),
    );
    expect([existsSync(shared), existsSync(provider)]).toEqual([false, false]);
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
