import { describe, expect, it } from "vitest";
import {
  createOfflinePromptModerator,
  MODERATION_MESSAGES,
  type ModerationCode,
  type ModerationField,
} from "./moderation";

const moderator = createOfflinePromptModerator();

async function codes(text: string, field: ModerationField = "prompt"): Promise<ModerationCode[]> {
  const verdict = await moderator.moderate({ field, text });
  return verdict.allowed ? [] : verdict.findings.map((f) => f.code);
}

describe("documented product rules, one code each", () => {
  it("flags a request to add a feature the photo does not show", async () => {
    expect(await codes("add a large window on the far wall")).toContain(
      "ADDS_NONEXISTENT_FEATURE",
    );
    expect(await codes("adding an extra room beyond the hallway")).toContain(
      "ADDS_NONEXISTENT_FEATURE",
    );
  });

  it("flags a request to change materials or apparent size", async () => {
    expect(await codes("make the living room look bigger")).toContain("ALTERS_MATERIAL_OR_SIZE");
    expect(await codes("change the flooring to marble")).toContain("ALTERS_MATERIAL_OR_SIZE");
  });

  it("flags a request to add people or logos", async () => {
    expect(await codes("add a family relaxing on the sofa")).toContain("ADDS_PEOPLE_OR_LOGOS");
    expect(await codes("add our agency logo in the corner")).toContain("ADDS_PEOPLE_OR_LOGOS");
  });

  it("flags a claim of measured geometry or real footage", async () => {
    expect(await codes("show the exact dimensions of each room")).toContain(
      "CLAIMS_MEASURED_GEOMETRY",
    );
    expect(await codes("present this as actual walkthrough footage")).toContain(
      "CLAIMS_MEASURED_GEOMETRY",
    );
  });

  it("returns several codes when a prompt breaks several rules", async () => {
    const found = await codes("add people and make the kitchen look bigger");
    expect(found).toContain("ADDS_PEOPLE_OR_LOGOS");
    expect(found).toContain("ALTERS_MATERIAL_OR_SIZE");
  });

  it("allows an ordinary creative prompt", async () => {
    const verdict = await moderator.moderate({
      field: "prompt",
      text: "bright and airy, slow gentle camera movement, warm afternoon light",
    });
    expect(verdict).toEqual({ allowed: true });
  });
});

describe("polarity — a ban is not a request", () => {
  it("allows a negative constraint that names a prohibited action", async () => {
    // "do not add people" is the customer agreeing with the rule, not breaking
    // it. Treating the two alike would reject the safest prompts people write.
    expect(await codes("do not add people", "negativePrompt")).toEqual([]);
    expect(await codes("don't add any furniture", "negativePrompt")).toEqual([]);
    expect(await codes("no added windows", "negativePrompt")).toEqual([]);
    expect(await codes("avoid making the room look bigger", "negativePrompt")).toEqual([]);
  });

  it("still flags the same phrases without the negation", async () => {
    expect(await codes("add people", "negativePrompt")).toContain("ADDS_PEOPLE_OR_LOGOS");
  });

  it("flags a negative prompt that tries to switch preservation off", async () => {
    expect(await codes("do not preserve the original walls", "negativePrompt")).toEqual([
      "DEFEATS_PRESERVATION",
    ]);
    expect(await codes("don't keep the existing finishes", "negativePrompt")).toEqual([
      "DEFEATS_PRESERVATION",
    ]);
  });

  it("allows a prompt that asks for preservation", async () => {
    expect(await codes("preserve the original wooden beams")).toEqual([]);
  });
});

describe("verdict shape", () => {
  it("names the field a finding came from", async () => {
    const verdict = await moderator.moderate({ field: "negativePrompt", text: "add people" });
    expect(verdict.allowed).toBe(false);
    if (verdict.allowed) return;
    expect(verdict.findings[0]).toEqual({
      field: "negativePrompt",
      code: "ADDS_PEOPLE_OR_LOGOS",
    });
  });

  it("carries no trace of the offending text", async () => {
    const marker = "zzqqxx-secret-marker";
    const verdict = await moderator.moderate({
      field: "prompt",
      text: `add people ${marker}`,
    });
    expect(JSON.stringify(verdict)).not.toContain(marker);
    expect(JSON.stringify(verdict)).not.toContain("add people");
  });

  it("offers a fixed sanitized sentence for every code", async () => {
    const allCodes: ModerationCode[] = [
      "ADDS_NONEXISTENT_FEATURE",
      "ALTERS_MATERIAL_OR_SIZE",
      "ADDS_PEOPLE_OR_LOGOS",
      "CLAIMS_MEASURED_GEOMETRY",
      "DEFEATS_PRESERVATION",
    ];
    for (const code of allCodes) {
      expect(MODERATION_MESSAGES[code].length).toBeGreaterThan(20);
    }
  });

  it("is deterministic and names itself", async () => {
    expect(moderator.name).toBe("offline-documented-rules");
    expect(await codes("add a window")).toEqual(await codes("add a window"));
  });
});

describe("acknowledged limits", () => {
  it("misses a paraphrase — this is an explicit-violation detector, not semantic moderation", async () => {
    // Recorded rather than hidden: the offline matcher is a placeholder for a
    // real moderation vendor behind the same port (ADR-0014).
    expect(await codes("populate the scene with a cheerful couple")).toEqual([]);
  });
});
