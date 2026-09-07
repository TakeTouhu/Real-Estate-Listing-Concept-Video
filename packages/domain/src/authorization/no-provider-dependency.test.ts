import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { epochMillisFromDate, yen } from "../pricing/units";
import { sanitizeTransitionMetadata } from "../orchestration/transition-metadata";
import { createFixedAuthorizationClock } from "./clock";
import { createPaidSubmissionAuthorizationService } from "./paid-submission-service";
import { createUnavailableBillingCycleRevenueReader } from "./revenue";
import type { PaidSubmissionAuthorizationRepository } from "./ports";

/**
 * The gate cannot call a provider, proven rather than asserted in a comment.
 *
 * Two independent checks, because either alone is escapable. The static one
 * reads the module's own source and fails on any transport import or global; the
 * runtime one drives a complete authorization with `fetch` and friends replaced
 * by throwing stubs, so a call through any path at all fails the test rather
 * than silently succeeding on a machine with a network.
 */

const HERE = join(__dirname);

/** Every source file of the authorization module, excluding its tests. */
function authorizationSources(): { name: string; text: string }[] {
  return readdirSync(HERE)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .map((name) => ({ name, text: readFileSync(join(HERE, name), "utf8") }));
}

describe("the authorization module has no provider or network dependency", () => {
  it("imports no provider package and no transport", () => {
    // `@app/video-providers` would invert the dependency direction and put a
    // concrete adapter in the layer that decides whether money may be spent.
    const forbidden = [
      "@app/video-providers",
      "node:http",
      "node:https",
      "undici",
      "axios",
      "node-fetch",
      "@app/storage",
    ];
    for (const { name, text } of authorizationSources()) {
      for (const pattern of forbidden) {
        expect(`${name}: ${text.includes(`"${pattern}"`)}`).toBe(`${name}: false`);
      }
    }
  });

  it("names no provider transport call anywhere in its source", () => {
    // Comments describing what the phase does *not* do are allowed and
    // deliberate, so the check is for call syntax rather than the bare word.
    const forbiddenCalls = [
      "fetch(",
      "createGeneration(",
      "XMLHttpRequest",
      "new WebSocket",
      "http.request",
      "https.request",
    ];
    for (const { name, text } of authorizationSources()) {
      for (const call of forbiddenCalls) {
        expect(`${name}: ${text.includes(call)}`).toBe(`${name}: false`);
      }
    }
  });

  it("completes an authorization with every network global sabotaged", async () => {
    const globals = globalThis as unknown as Record<string, unknown>;
    const saved = {
      fetch: globals.fetch,
      XMLHttpRequest: globals.XMLHttpRequest,
      WebSocket: globals.WebSocket,
    };
    const explode = () => {
      throw new Error("the paid submission gate must not perform network I/O");
    };
    globals.fetch = explode;
    globals.XMLHttpRequest = explode;
    globals.WebSocket = explode;

    try {
      let armCalls = 0;
      const authorization: PaidSubmissionAuthorizationRepository = {
        async withCostAdmission(_input, run) {
          return run({
            async loadFacts() {
              return {
                attempt: {
                  attemptId: "sgen_no_net",
                  orchestrationState: "QUEUED",
                  submissionCertainty: "PRE_SUBMISSION",
                  stateVersion: 0,
                  generationJobId: "genjob_no_net",
                  qualityTier: "NORMAL",
                  providerName: "fal",
                  providerModelId: "minimax/h3-max/image-to-video",
                  requestModelKey: "minimax-h3-max",
                  requestNativeGenerationResolution: "768P",
                  requestTargetOutputResolution: "720p",
                  requestDurationSeconds: 5,
                  pricingContractKey: "fal:minimax-h3-max:2026-09-02.1",
                  requestKind: "INITIAL",
                  requestUserRegenerationOrdinal: null,
                },
                job: {
                  id: "genjob_no_net",
                  qualityTier: "NORMAL",
                  requiredVideoUnits: 1,
                  requiredHighQualityUnits: 0,
                },
                reservation: {
                  generationJobId: "genjob_no_net",
                  state: "RESERVED",
                  reservedTotalVideoUnits: 1,
                  reservedHighQualityUnits: 0,
                },
                pricing: {
                  snapshotBoundToAttempt: true,
                  bindingValid: true,
                  contract: null,
                  identityGenerationMode: "image-to-video",
                  identityAudioMode: "none",
                  integrityFailure: null,
                  plannedCostYen: yen(100),
                  fxFailure: null,
                  pricingSnapshotId: "gps_no_net",
                },
                exposure: {
                  knownActualCostYen: yen(0),
                  settledEstimatedCostYen: yen(0),
                  uncertainCostYen: yen(0),
                  inFlightCostYen: yen(0),
                  nextProjectedCostYen: yen(100),
                },
                exposureVerified: true,
                billingCycleKey: "2026-09",
              };
            },
            async arm() {
              armCalls += 1;
              return { kind: "ARMED", stateVersion: 1 };
            },
          });
        },
      };

      const service = createPaidSubmissionAuthorizationService({
        authorization,
        billingCycleRevenue: createUnavailableBillingCycleRevenueReader(),
        clock: createFixedAuthorizationClock(
          epochMillisFromDate(new Date("2026-09-10T00:00:00.000Z")),
        ),
      });

      const outcome = await service.authorize({
        organizationId: "org_no_net",
        attemptId: "sgen_no_net",
        context: {
          actorType: "SYSTEM",
          actorUserId: null,
          correlationId: "corr_no_net",
          causationId: null,
          reasonCode: null,
          eventType: "TEST",
          metadata: sanitizeTransitionMetadata({}),
        },
      });

      // The default revenue readers report "unknown", so this refuses — which
      // is itself the point: the dormant gate authorizes nothing today, and it
      // reached that answer without touching the network.
      expect(outcome.kind).toBe("PRICING_INELIGIBLE");
      expect(armCalls).toBe(0);
    } finally {
      globals.fetch = saved.fetch;
      globals.XMLHttpRequest = saved.XMLHttpRequest;
      globals.WebSocket = saved.WebSocket;
    }
  });

  it("reports no authoritative revenue rather than assuming a plan", async () => {
    // Assuming Standard would hard-pause an Enterprise customer at a quarter of
    // their real threshold; deriving a plan from seat count or usage would
    // invent a commercial fact from operational data.
    await expect(
      createUnavailableBillingCycleRevenueReader().revenueYen({
        organizationId: "org",
        billingCycleKey: "2026-09",
      }),
    ).resolves.toBeNull();
  });

  it("reads wall time only through the injected clock", () => {
    // `Date.now()` scattered through domain logic makes a decision untestable
    // and lets two parts of it disagree about when "now" is. The one legitimate
    // reader is the system clock factory.
    for (const { name, text } of authorizationSources()) {
      if (name === "clock.ts") continue;
      expect(`${name}: ${text.includes("Date.now(")}`).toBe(`${name}: false`);
      expect(`${name}: ${text.includes("new Date(")}`).toBe(`${name}: false`);
    }
  });
});
