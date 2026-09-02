import { describe, expect, it } from "vitest";
import { FakeVideoProvider } from "./fake-provider";
import type { ProviderGenerationInput } from "../types";

const input: ProviderGenerationInput = {
  modelId: "wavespeed-ai/open-video/image-to-video",
  sourceImageUrl: "https://storage.internal/o/org/img?token=x",
  prompt: "bright natural interior",
  durationSeconds: 6,
  aspectRatio: "16:9",
  nativeGenerationResolution: "1080p",
  requestHash: "abc123",
};

describe("FakeVideoProvider", () => {
  const now = () => new Date("2026-01-01T00:00:00.000Z");
  const provider = new FakeVideoProvider({ now });

  /** Unwrap an ACCEPTED outcome, failing loudly on any other arm. */
  async function acceptedRef(p: FakeVideoProvider) {
    const outcome = await p.createGeneration(input);
    if (outcome.kind !== "ACCEPTED") throw new Error(`expected ACCEPTED, got ${outcome.kind}`);
    return outcome.ref;
  }

  it("is deterministic and performs no network I/O", async () => {
    const a = await provider.createGeneration(input);
    const b = await provider.createGeneration(input);
    expect(a).toEqual(b);
    expect(a.kind).toBe("ACCEPTED");
    if (a.kind !== "ACCEPTED") throw new Error("expected ACCEPTED");
    expect(a.ref.predictionId).toBe("fake_abc123");
    expect(a.ref.provider).toBe("fake");
  });

  it("reports SUCCEEDED with a temporary output url and expiry", async () => {
    const ref = await acceptedRef(provider);
    const status = await provider.getStatus(ref);
    expect(status.state).toBe("SUCCEEDED");
    expect(status.progressPercent).toBe(100);
    expect(status.temporaryOutputUrl).toContain("fake_abc123");
    expect(status.temporaryOutputExpiresAt).toBe("2026-01-01T01:00:00.000Z");
  });

  it("estimates cost from duration and pricing", async () => {
    const cost = await provider.estimateCost(input);
    expect(cost).toEqual({ amountMinor: 30, currency: "USD" });
  });

  it("cancel resolves without error", async () => {
    const ref = await acceptedRef(provider);
    await expect(provider.cancelGeneration(ref)).resolves.toBeUndefined();
  });
});

/**
 * The fake's submission outcomes.
 *
 * `SUBMISSION_UNKNOWN` is the state a worker is most likely to mishandle and
 * the hardest to reach against a real provider — a timeout has to be provoked
 * at exactly the wrong moment. Making all three reachable offline and
 * deterministically is what lets the handling be tested at all.
 */
describe("FakeVideoProvider submission outcomes", () => {
  const now = () => new Date("2026-01-01T00:00:00.000Z");

  it("returns ACCEPTED by default", async () => {
    const outcome = await new FakeVideoProvider({ now }).createGeneration(input);
    expect(outcome.kind).toBe("ACCEPTED");
  });

  it("returns DEFINITIVELY_REJECTED on request", async () => {
    const outcome = await new FakeVideoProvider({
      now,
      submissionOutcome: "DEFINITIVELY_REJECTED",
    }).createGeneration(input);

    expect(outcome.kind).toBe("DEFINITIVELY_REJECTED");
    if (outcome.kind === "ACCEPTED") throw new Error("expected a failure outcome");
    expect(outcome.error.retryable).toBe(false);
  });

  it("returns SUBMISSION_UNKNOWN on request, with a retryable error", async () => {
    // The combination that must never be read as permission to re-POST.
    const outcome = await new FakeVideoProvider({
      now,
      submissionOutcome: "SUBMISSION_UNKNOWN",
    }).createGeneration(input);

    expect(outcome.kind).toBe("SUBMISSION_UNKNOWN");
    if (outcome.kind === "ACCEPTED") throw new Error("expected a failure outcome");
    expect(outcome.error.retryable).toBe(true);
  });

  it("keeps every outcome deterministic and offline", async () => {
    for (const kind of ["ACCEPTED", "DEFINITIVELY_REJECTED", "SUBMISSION_UNKNOWN"] as const) {
      const p = new FakeVideoProvider({ now, submissionOutcome: kind });
      expect(await p.createGeneration(input)).toEqual(await p.createGeneration(input));
    }
  });

  it("uses fixed application-owned error text, never caller input", async () => {
    // The fake is where a "the message is probably fine" habit would form, and
    // its ProviderError is the same type the domain persists (ADR-0031).
    const p = new FakeVideoProvider({ now, submissionOutcome: "SUBMISSION_UNKNOWN" });
    const outcome = await p.createGeneration({
      ...input,
      prompt: "LEAK-ME",
      sourceImageUrl: "https://storage.internal/o/org/img?token=SIGNED",
    });

    const serialized = JSON.stringify(outcome);
    expect(serialized).not.toContain("LEAK-ME");
    expect(serialized).not.toContain("SIGNED");
    expect(serialized).not.toContain("storage.internal");
  });
});
