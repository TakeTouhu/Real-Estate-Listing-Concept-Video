import { describe, expect, it } from "vitest";
import type { PaidSubmissionAuthorizationOutcome } from "../authorization/types";
import type { VerifiedModelEntry } from "../generation/model-catalog";
import { PREFLIGHT_SOURCE_URL_TTL_SECONDS, type PreparedGeneration } from "../generation/execution-preflight";
import { computeGenerationRequestHash } from "../generation/request-identity";
import type { SceneGeneration } from "../generation/types";
import type { TransitionContext } from "../orchestration/ports";
import { epochMillis, yen } from "../pricing/units";
import type { MediaAsset } from "../property/types";
import type { ProviderSubmissionObservation } from "../submission/observation";
import type { SubmissionOutcomeResult } from "../submission/ports";
import type {
  AttemptSubmissionCandidate,
  AttemptSubmissionCandidateQuery,
  EndPreparationRefusalInput,
  EndPreparationRefusalOutcome,
} from "./ports";
import { AttemptSubmissionRunner, MIN_SOURCE_URL_REMAINING_MS, type AttemptSubmissionRunnerDeps } from "./runner";

const ORG = "org_send";
const NOW = Date.UTC(2026, 10, 10, 1, 0, 0);
const KEY = "org/org_send/a/ast_send/normalized.jpg";
const DIGEST = "c".repeat(64);
const MODEL_KEY = "send-model";

const ENTRY: VerifiedModelEntry = {
  key: MODEL_KEY,
  providerName: "fake",
  providerModelId: "fake/image-to-video",
  displayName: "Send fixture",
  tier: "RECOMMENDED",
  recommended: true,
  availability: { kind: "SELECTABLE" },
  capability: {
    providerName: "fake",
    providerModelId: "fake/image-to-video",
    durationSeconds: { kind: "RANGE", minSeconds: 1, maxSeconds: 10 },
    nativeGenerationResolutions: ["720p"],
    aspectRatios: { kind: "PROVIDER_HONORED", ratios: ["16:9"] },
    negativePrompt: { kind: "UNSUPPORTED" },
    cameraMotion: { kind: "PROMPT_RENDERED" },
  },
  nativeGeneration: {
    byTarget: {
      "720p": { nativeGenerationResolution: { providerValue: "720p" }, normalization: "NONE", nativeMeetsTarget: true },
    },
  },
  pricing: null,
};

/** A queued attempt whose stored hash matches its facts, so preparation accepts it. */
function attempt(id: string, providerName = "fake"): SceneGeneration {
  const at = new Date(NOW - 60_000);
  const base: SceneGeneration = {
    id,
    videoProjectId: "vpr_send",
    sourceStoryboardSceneId: `sbs_${id}`,
    assetId: "ast_send",
    sourceAnalysisRevision: 1,
    requestHash: "",
    providerName,
    providerModelId: "fake/image-to-video",
    requestCompiledPrompt: '{"preservation":["keep the window"],"sceneFacts":{},"userCustomization":null}',
    requestDurationSeconds: 5,
    requestCameraMotion: null,
    requestAspectRatio: "16:9",
    requestResolution: null,
    requestModelKey: MODEL_KEY,
    requestTargetOutputResolution: "720p",
    requestNativeGenerationResolution: "720p",
    requestResolutionNormalization: "NONE",
    requestNativeMeetsTarget: true,
    requestRenderedPrompt: "Preservation rules:\n- keep the window",
    state: "QUEUED",
    providerPredictionId: null,
    submittedAt: null,
    lastPolledAt: null,
    normalizedErrorCode: null,
    normalizedErrorMessage: null,
    outputStorageKey: null,
    createdAt: at,
    updatedAt: at,
  };
  return {
    ...base,
    requestHash: computeGenerationRequestHash({
      assetId: base.assetId,
      compiledPrompt: base.requestCompiledPrompt!,
      durationSeconds: 5,
      cameraMotion: null,
      aspectRatio: "16:9",
      targetOutputResolution: "720p",
      nativeGenerationResolution: "720p",
      resolutionNormalization: "NONE",
      nativeMeetsTarget: true,
      modelKey: MODEL_KEY,
      providerName,
      providerModelId: "fake/image-to-video",
    }),
  };
}

function photo(overrides: Partial<MediaAsset> = {}): MediaAsset {
  const at = new Date(NOW - 3_600_000);
  return {
    id: "ast_send",
    organizationId: ORG,
    propertyId: "prp_send",
    storageKey: KEY,
    originalFilename: "room.jpg",
    mimeType: "image/jpeg",
    sizeBytes: 2048,
    width: 1280,
    height: 720,
    sha256: DIGEST,
    perceptualHash: null,
    status: "READY",
    failureReason: null,
    thumbnailKey: null,
    createdBy: "usr_send",
    deletionRequestedAt: null,
    retentionExpiresAt: null,
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
}

const AUTHORIZED: PaidSubmissionAuthorizationOutcome = {
  kind: "AUTHORIZED",
  attemptId: "ignored",
  armedStateVersion: 2,
  safetyGuardWarning: null,
};
const ACCEPTED: ProviderSubmissionObservation = { kind: "ACCEPTED", providerPredictionId: "pred_send" };
const UNKNOWN: ProviderSubmissionObservation = { kind: "SUBMISSION_UNKNOWN", normalizedErrorCode: null };
const WARNING = {
  state: "WARNING" as const,
  projectedContributionProfitYen: yen(20_000),
  thresholds: { warningFloorYen: yen(25_000), hardPauseFloorYen: yen(15_000) },
};

/** Every collaborator, recording what it was asked, in one ordered log. */
function harness(jobs: Record<string, string>) {
  const log: string[] = [];
  const queries: AttemptSubmissionCandidateQuery[] = [];
  const endings: EndPreparationRefusalInput[] = [];
  const gateContexts: TransitionContext[] = [];
  const recorded: { attemptId: string; observation: ProviderSubmissionObservation; context: TransitionContext }[] = [];
  const sentPrepared: PreparedGeneration[] = [];
  const contexts: TransitionContext[] = [];
  const state = {
    candidates: [] as AttemptSubmissionCandidate[],
    photo: photo(),
    existsFails: false,
    expiresAt: new Date(NOW + PREFLIGHT_SOURCE_URL_TTL_SECONDS * 1000),
    ending: { kind: "ENDED", attemptId: "x", stateVersion: 2 } as EndPreparationRefusalOutcome,
    endThrows: false,
    gate: new Map<string, PaidSubmissionAuthorizationOutcome | "THROW">(),
    answer: new Map<string, unknown>(),
    recordThrows: false,
  };
  const deps: AttemptSubmissionRunnerDeps = {
    repository: {
      async findSubmissionCandidates(query) {
        queries.push(query);
        return state.candidates;
      },
      async endPreparationRefusal(input) {
        log.push(`end:${input.attemptId}`);
        endings.push(input);
        if (state.endThrows) throw new Error("database gone");
        return state.ending;
      },
    },
    preflight: {
      assets: { findById: async (organizationId) => (organizationId === ORG ? state.photo : null) },
      storage: {
        async exists() {
          if (state.existsFails) throw new Error("storage gone");
          return true;
        },
        async createSignedDownloadUrl(key) {
          log.push(`sign:${key}`);
          return { url: "https://storage.example.test/source?sig=secret", expiresAt: state.expiresAt };
        },
      },
      models: { find: (key) => (key === MODEL_KEY ? ENTRY : undefined) },
    },
    gate: {
      async authorize(input) {
        log.push(`gate:${input.attemptId}`);
        gateContexts.push(input.context);
        expect(input).toMatchObject({ organizationId: ORG, source: { storageKey: KEY, sha256: DIGEST } });
        const answer = state.gate.get(input.attemptId) ?? AUTHORIZED;
        if (answer === "THROW") throw new Error("gate gone");
        return answer;
      },
    },
    sender: {
      providerName: "fake",
      async send(prepared) {
        log.push(`send:${prepared.generationId}`);
        sentPrepared.push(prepared);
        const answer = state.answer.get(prepared.generationId) ?? ACCEPTED;
        if (answer === "THROW") throw new Error("socket closed");
        return answer as ProviderSubmissionObservation;
      },
    },
    outcomes: {
      async recordObservation(input): Promise<SubmissionOutcomeResult> {
        log.push(`record:${input.attemptId}`);
        recorded.push(input);
        if (state.recordThrows) throw new Error("database gone");
        return { kind: "APPLIED", attemptId: input.attemptId, stateVersion: 3, entitlementAnomaly: "NONE" };
      },
    },
    clock: { now: () => epochMillis(NOW) },
    context: () => {
      const made: TransitionContext = {
        actorType: "WORKER",
        actorUserId: null,
        correlationId: `corr_${contexts.length + 1}`,
        causationId: null,
        reasonCode: null,
        metadata: {},
        eventType: "IGNORED",
      };
      contexts.push(made);
      return made;
    },
  };
  function offer(...ids: string[]): void {
    state.candidates = ids.map((id) => ({ organizationId: ORG, generationJobId: jobs[id]!, generation: attempt(id) }));
  }
  return { deps, log, queries, endings, gateContexts, recorded, sentPrepared, contexts, state, offer };
}

const run = (h: ReturnType<typeof harness>, limit = 10) => new AttemptSubmissionRunner(h.deps).runOnce(limit);

describe("sending an attempt the gate authorized", () => {
  it("prepares, asks the gate, sends once and records the answer, in that order, under one context", async () => {
    const h = harness({ sg1: "job1" });
    h.offer("sg1");
    const report = await run(h);

    expect(h.log).toEqual([`sign:${KEY}`, "gate:sg1", "send:sg1", "record:sg1"]);
    expect(report).toMatchObject({ sent: 1, ended: 0, failed: 0, next: null });
    expect(report.outcomes).toEqual([
      {
        organizationId: ORG,
        attemptId: "sg1",
        outcome: { kind: "SENT", observed: "ACCEPTED", recorded: "APPLIED", safetyGuardWarning: false },
      },
    ]);
    expect(h.sentPrepared[0]).toMatchObject({
      generationId: "sg1",
      providerName: "fake",
      sourceImageUrl: "https://storage.example.test/source?sig=secret",
    });
    expect(h.recorded).toEqual([
      { organizationId: ORG, attemptId: "sg1", observation: ACCEPTED, context: h.contexts[0] },
    ]);
    expect(h.gateContexts).toEqual([h.contexts[0]]);
    expect(h.contexts).toHaveLength(1);
  });

  it("gives each attempt its own context", async () => {
    const h = harness({ sg1: "job1", sg2: "job2" });
    h.offer("sg1", "sg2");
    await run(h);
    expect(h.recorded.map((r) => r.context.correlationId)).toEqual(["corr_1", "corr_2"]);
  });

  it("reports a warning the Safety Guard gave", async () => {
    const h = harness({ sg1: "job1" });
    h.offer("sg1");
    h.state.gate.set("sg1", { ...AUTHORIZED, safetyGuardWarning: WARNING });
    expect((await run(h)).outcomes[0]!.outcome).toMatchObject({ kind: "SENT", safetyGuardWarning: true });
  });

  it.each<[string, unknown]>([
    ["throws", "THROW"],
    ["answers an acceptance that names nothing", { kind: "ACCEPTED", providerPredictionId: "" }],
    ["answers with no observation", { kind: "PROBABLY_FINE" }],
  ])("records SUBMISSION_UNKNOWN, once, when the sender %s", async (_, answer) => {
    const h = harness({ sg1: "job1" });
    h.offer("sg1");
    h.state.answer.set("sg1", answer);
    const report = await run(h);
    expect(h.log.filter((entry) => entry.startsWith("send:"))).toEqual(["send:sg1"]);
    expect(h.recorded.map((r) => r.observation)).toEqual([UNKNOWN]);
    expect(report.outcomes[0]!.outcome).toMatchObject({ kind: "SENT", observed: "SUBMISSION_UNKNOWN" });
  });

  it("reports a record that threw, and sends nothing again", async () => {
    const h = harness({ sg1: "job1" });
    h.offer("sg1");
    h.state.recordThrows = true;
    const report = await run(h);
    expect(report).toMatchObject({ sent: 1, failed: 0 });
    expect(report.outcomes[0]!.outcome).toEqual({
      kind: "SENT",
      observed: "ACCEPTED",
      recorded: null,
      safetyGuardWarning: false,
    });
    expect(h.log).toEqual([`sign:${KEY}`, "gate:sg1", "send:sg1", "record:sg1"]);
  });
});

describe("what is not sent", () => {
  it("writes and sends nothing when the gate refuses, and keeps its reason", async () => {
    const h = harness({ sg1: "job1", sg2: "job1" });
    h.offer("sg1", "sg2");
    h.state.gate.set("sg1", {
      kind: "SAFETY_GUARD_HARD_PAUSE",
      reason: "HARD_PAUSE_PROJECTED_PROFIT_BELOW_FLOOR",
      decision: { ...WARNING, state: "HARD_PAUSE" },
    });
    h.state.gate.set("sg2", { kind: "LOST_CONCURRENCY" });
    const report = await run(h);
    expect(report.outcomes.map((o) => o.outcome)).toEqual([
      { kind: "NOT_AUTHORIZED", refusal: "SAFETY_GUARD_HARD_PAUSE", reason: "HARD_PAUSE_PROJECTED_PROFIT_BELOW_FLOOR" },
      { kind: "NOT_AUTHORIZED", refusal: "LOST_CONCURRENCY", reason: null },
    ]);
    expect(h.log).toEqual([`sign:${KEY}`, "gate:sg1", `sign:${KEY}`, "gate:sg2"]);
    expect(report).toMatchObject({ sent: 0, ended: 0, failed: 0 });
  });

  it("signs nothing for another provider's attempt", async () => {
    const h = harness({ sg1: "job1" });
    h.state.candidates = [{ organizationId: ORG, generationJobId: "job1", generation: attempt("sg1", "wavespeed") }];
    const report = await run(h);
    expect(report.outcomes[0]!.outcome).toEqual({ kind: "NOT_SENT", reason: "OTHER_PROVIDER" });
    expect(h.log).toEqual([]);
    expect(h.contexts).toEqual([]);
  });

  it("asks the gate nothing when the URL has too little time left", async () => {
    const h = harness({ sg1: "job1" });
    h.offer("sg1");
    h.state.expiresAt = new Date(NOW + MIN_SOURCE_URL_REMAINING_MS - 1);
    expect((await run(h)).outcomes[0]!.outcome).toEqual({ kind: "NOT_SENT", reason: "SOURCE_URL_STALE" });
    expect(h.log).toEqual([`sign:${KEY}`]);

    h.state.expiresAt = new Date(NOW + MIN_SOURCE_URL_REMAINING_MS);
    expect((await run(h)).outcomes[0]!.outcome).toMatchObject({ kind: "SENT" });
  });

  it("leaves the URL's margin inside the life preparation signs it for", () => {
    expect(MIN_SOURCE_URL_REMAINING_MS).toBeGreaterThan(0);
    expect(MIN_SOURCE_URL_REMAINING_MS).toBeLessThan(PREFLIGHT_SOURCE_URL_TTL_SECONDS * 1000);
  });
});

describe("a refused preparation", () => {
  it("ends an attempt refused for good, and sends nothing more of its job in the pass", async () => {
    const h = harness({ sg1: "job1", sg2: "job1", sg3: "job2" });
    h.offer("sg1", "sg2", "sg3");
    let reads = 0;
    // The first attempt's photo is asked to be deleted; then it is usable again,
    // so only the job rule keeps the second attempt from being sent.
    h.deps.preflight.assets.findById = async () =>
      ++reads <= 1 ? photo({ deletionRequestedAt: new Date(NOW) }) : h.state.photo;
    const report = await run(h);

    expect(report.outcomes.map((o) => [o.attemptId, o.outcome])).toEqual([
      ["sg1", { kind: "ENDED", reason: "ASSET_UNRECOVERABLE" }],
      ["sg2", { kind: "NOT_SENT", reason: "JOB_ENDING" }],
      ["sg3", { kind: "SENT", observed: "ACCEPTED", recorded: "APPLIED", safetyGuardWarning: false }],
    ]);
    expect(h.endings).toEqual([
      { organizationId: ORG, attemptId: "sg1", reason: "ASSET_UNRECOVERABLE", context: h.contexts[0] },
    ]);
    expect(h.log).toEqual(["end:sg1", `sign:${KEY}`, "gate:sg3", "send:sg3", "record:sg3"]);
    expect(report).toMatchObject({ sent: 1, ended: 1, failed: 0 });
  });

  it("leaves an attempt whose refusal may pass, and writes nothing", async () => {
    const h = harness({ sg1: "job1", sg2: "job1" });
    h.offer("sg1", "sg2");
    h.state.existsFails = true;
    const report = await run(h);
    expect(report.outcomes.map((o) => o.outcome)).toEqual([
      { kind: "NOT_PREPARED", reason: "STORAGE_UNAVAILABLE" },
      { kind: "NOT_PREPARED", reason: "STORAGE_UNAVAILABLE" },
    ]);
    expect(h.log).toEqual([]);
  });

  it("reports an ending that found the attempt moved, and goes on with its job", async () => {
    const h = harness({ sg1: "job1", sg2: "job1" });
    h.offer("sg1", "sg2");
    let reads = 0;
    h.deps.preflight.assets.findById = async () =>
      ++reads <= 1 ? photo({ deletionRequestedAt: new Date(NOW) }) : h.state.photo;
    h.state.ending = { kind: "NOT_QUEUED" };
    const report = await run(h);
    expect(report.outcomes.map((o) => o.outcome.kind)).toEqual(["MOVED", "SENT"]);
    expect(report.ended).toBe(0);
  });

  it("ends the job for the pass when the provider refuses an attempt for good", async () => {
    const h = harness({ sg1: "job1", sg2: "job1" });
    h.offer("sg1", "sg2");
    h.state.answer.set("sg1", { kind: "DEFINITIVELY_REJECTED", retryable: false, normalizedErrorCode: null });
    const report = await run(h);
    expect(report.outcomes.map((o) => o.outcome)).toEqual([
      { kind: "SENT", observed: "DEFINITIVELY_REJECTED", recorded: "APPLIED", safetyGuardWarning: false },
      { kind: "NOT_SENT", reason: "JOB_ENDING" },
    ]);
  });
});

describe("one bad attempt never stops the others", () => {
  it("makes a throw before the send FAILED, sends nothing for it, and goes on", async () => {
    const h = harness({ sg1: "job1", sg2: "job2" });
    h.offer("sg1", "sg2");
    h.state.gate.set("sg1", "THROW");
    const report = await run(h);
    expect(report.outcomes.map((o) => o.outcome.kind)).toEqual(["FAILED", "SENT"]);
    expect(report).toMatchObject({ sent: 1, failed: 1 });
    expect(h.log.filter((entry) => entry.startsWith("send:"))).toEqual(["send:sg2"]);
  });

  it("makes a photo read that throws FAILED, not a refusal that would end the attempt", async () => {
    const h = harness({ sg1: "job1" });
    h.offer("sg1");
    h.deps.preflight.assets.findById = () => Promise.reject(new Error("database gone"));
    expect((await run(h)).outcomes[0]!.outcome).toEqual({ kind: "FAILED" });
    expect(h.endings).toEqual([]);
    expect(h.log).toEqual([]);
  });

  it("makes an ending that throws FAILED", async () => {
    const h = harness({ sg1: "job1" });
    h.offer("sg1");
    h.deps.preflight.assets.findById = async () => photo({ deletionRequestedAt: new Date(NOW) });
    h.state.endThrows = true;
    expect((await run(h)).outcomes[0]!.outcome).toEqual({ kind: "FAILED" });
  });
});

describe("the window", () => {
  it("reads one bounded window after the cursor, and starts the next after its last attempt", async () => {
    const h = harness({ sg1: "job1", sg2: "job2" });
    h.offer("sg1", "sg2");
    const after = { createdAt: new Date(NOW - 120_000), id: "sg0" };
    const report = await new AttemptSubmissionRunner(h.deps).runOnce(2, after);
    expect(h.queries).toEqual([{ limit: 2, after }]);
    expect(report.next).toEqual({ createdAt: h.state.candidates[1]!.generation.createdAt, id: "sg2" });
  });

  it("starts the next pass from the oldest when the window was not full", async () => {
    const h = harness({ sg1: "job1" });
    h.offer("sg1");
    expect((await run(h, 2)).next).toBeNull();
    expect(h.queries).toEqual([{ limit: 2, after: null }]);
  });

  it("refuses a bound or a cursor it cannot use, before reading anything", async () => {
    const h = harness({});
    const runner = new AttemptSubmissionRunner(h.deps);
    for (const limit of [0, 101, 1.5]) {
      await expect(runner.runOnce(limit)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    }
    for (const after of [
      { createdAt: new Date(Number.NaN), id: "sg1" },
      { createdAt: new Date(NOW), id: "" },
    ]) {
      await expect(runner.runOnce(1, after)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    }
    expect(h.queries).toEqual([]);
  });
});
