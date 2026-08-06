import { describe, expect, it } from "vitest";
import { AppError } from "@app/shared";
import type { RoomType } from "../analysis/types";
import type { EligibleInput } from "./eligibility";
import { orderScenes } from "./ordering";

function input(
  assetId: string,
  roomType: RoomType | null,
  suggestedOrder: number | null = null,
  orderOverride: number | null = null,
): EligibleInput {
  return { assetId, analysisRevision: 1, roomType, orderOverride, suggestedOrder };
}

/** A photo carrying a reviewer's explicit sort priority. */
function pinned(
  assetId: string,
  orderOverride: number,
  roomType: RoomType | null = "KITCHEN",
  suggestedOrder: number | null = null,
): EligibleInput {
  return input(assetId, roomType, suggestedOrder, orderOverride);
}

/** The documented sequence, completed — the order the enum should come out in. */
const SEQUENCE: readonly RoomType[] = [
  "EXTERIOR",
  "ENTRANCE",
  "HALLWAY",
  "LIVING_ROOM",
  "DINING_ROOM",
  "KITCHEN",
  "BEDROOM",
  "CHILD_ROOM",
  "STUDY",
  "BATHROOM",
  "WASHROOM",
  "TOILET",
  "STORAGE",
  "BALCONY",
  "OTHER",
];

describe("walkthrough sequence", () => {
  it("orders the full room set exactly as documented", () => {
    // Shuffled deterministically: reversed, so nothing can pass by accident.
    const shuffled = [...SEQUENCE].reverse().map((room, i) => input(`ast_${i}`, room));
    expect(orderScenes(shuffled).map((s) => s.roomType)).toEqual(SEQUENCE);
  });

  it("places CHILD_ROOM immediately after BEDROOM, and STUDY after CHILD_ROOM", () => {
    const ordered = orderScenes([
      input("ast_study", "STUDY"),
      input("ast_child", "CHILD_ROOM"),
      input("ast_bed", "BEDROOM"),
    ]);
    expect(ordered.map((s) => s.roomType)).toEqual(["BEDROOM", "CHILD_ROOM", "STUDY"]);
  });

  it("keeps the wet areas in the enum's own order", () => {
    const ordered = orderScenes([
      input("ast_toilet", "TOILET"),
      input("ast_wash", "WASHROOM"),
      input("ast_bath", "BATHROOM"),
    ]);
    expect(ordered.map((s) => s.roomType)).toEqual(["BATHROOM", "WASHROOM", "TOILET"]);
  });

  it("sorts OTHER and an unclassified photo last, after every ranked room", () => {
    const ordered = orderScenes([
      input("ast_other", "OTHER"),
      input("ast_null", null),
      input("ast_balcony", "BALCONY"),
      input("ast_exterior", "EXTERIOR"),
    ]);
    expect(ordered.map((s) => s.assetId)).toEqual([
      "ast_exterior",
      "ast_balcony",
      "ast_other",
      "ast_null",
    ]);
  });

  it("simply omits rooms that have no photo — it never fabricates one", () => {
    const ordered = orderScenes([input("ast_a", "KITCHEN"), input("ast_b", "BALCONY")]);
    expect(ordered.map((s) => s.roomType)).toEqual(["KITCHEN", "BALCONY"]);
    expect(ordered).toHaveLength(2);
  });
});

describe("tie-breaking within one room type", () => {
  it("orders by suggestedOrder ascending", () => {
    const ordered = orderScenes([
      input("ast_c", "BEDROOM", 3),
      input("ast_a", "BEDROOM", 1),
      input("ast_b", "BEDROOM", 2),
    ]);
    expect(ordered.map((s) => s.assetId)).toEqual(["ast_a", "ast_b", "ast_c"]);
  });

  it("sorts a null suggestedOrder after every stated one", () => {
    const ordered = orderScenes([
      input("ast_none", "KITCHEN", null),
      input("ast_high", "KITCHEN", 99),
    ]);
    expect(ordered.map((s) => s.assetId)).toEqual(["ast_high", "ast_none"]);
  });

  it("falls back to assetId when suggestedOrder ties, including two nulls", () => {
    const ordered = orderScenes([
      input("ast_z", "KITCHEN", 5),
      input("ast_a", "KITCHEN", 5),
      input("ast_m", "KITCHEN", null),
      input("ast_b", "KITCHEN", null),
    ]);
    expect(ordered.map((s) => s.assetId)).toEqual(["ast_a", "ast_z", "ast_b", "ast_m"]);
  });

  it("gives the identical result whatever order the inputs arrive in", () => {
    const set = [
      input("ast_b", "KITCHEN", 2),
      input("ast_a", "EXTERIOR", null),
      input("ast_c", "KITCHEN", 1),
      input("ast_d", null, 4),
    ];
    const forwards = orderScenes(set);
    const backwards = orderScenes([...set].reverse());
    expect(backwards).toEqual(forwards);
  });
});

describe("the output is a permutation of the input", () => {
  const set = [
    input("ast_a", "KITCHEN", 2),
    input("ast_b", "EXTERIOR", 1),
    input("ast_c", null, null),
  ];

  it("adds nothing, drops nothing, and repeats nothing", () => {
    const ordered = orderScenes(set);
    expect(ordered).toHaveLength(set.length);
    expect([...ordered].map((s) => s.assetId).sort()).toEqual(["ast_a", "ast_b", "ast_c"]);
    expect(new Set(ordered.map((s) => s.assetId)).size).toBe(ordered.length);
  });

  it("carries every input object through unchanged", () => {
    expect([...orderScenes(set)].sort((a, b) => (a.assetId < b.assetId ? -1 : 1))).toEqual(set);
  });

  it("does not mutate the caller's array", () => {
    const original = [...set];
    orderScenes(set);
    expect(set).toEqual(original);
  });

  it("returns an empty result for an empty input", () => {
    expect(orderScenes([])).toEqual([]);
  });
});

describe("duplicate asset ids", () => {
  it("refuses two inputs claiming the same asset", () => {
    // Neither deduplicated nor resolved: a repeated asset means the caller built
    // the set wrongly, and quietly keeping one would change the scene count.
    const call = () =>
      orderScenes([input("ast_a", "KITCHEN"), input("ast_a", "BEDROOM", 2)]);
    expect(call).toThrow(AppError);
    expect(call).toThrow(/same asset appears twice/i);
  });

  it("names the offending asset without inventing a resolution", () => {
    try {
      orderScenes([input("ast_dup", "KITCHEN"), input("ast_dup", "KITCHEN")]);
      expect.unreachable("expected a duplicate-asset failure");
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe("VALIDATION_FAILED");
      expect((error as AppError).details).toEqual({ assetId: "ast_dup" });
    }
  });

  it("accepts distinct assets that share every other field", () => {
    const ordered = orderScenes([input("ast_a", "KITCHEN", 1), input("ast_b", "KITCHEN", 1)]);
    expect(ordered.map((s) => s.assetId)).toEqual(["ast_a", "ast_b"]);
  });
});

describe("human order priority", () => {
  it("wins an exact tie against an automatic room rank of the same number", () => {
    // EXTERIOR ranks 1 automatically; the reviewer typed 1 meaning "lead with
    // this". On a numeric tie the stated intent wins.
    const ordered = orderScenes([input("ast_ext", "EXTERIOR"), pinned("ast_pin", 1, "TOILET")]);
    expect(ordered.map((i) => i.assetId)).toEqual(["ast_pin", "ast_ext"]);
  });

  it("moves a photo earlier when the priority beats the automatic rank", () => {
    // LIVING_ROOM ranks 4; priority 2 is lower, so the pinned photo leads.
    const ordered = orderScenes([input("ast_liv", "LIVING_ROOM"), pinned("ast_pin", 2, "BALCONY")]);
    expect(ordered.map((i) => i.assetId)).toEqual(["ast_pin", "ast_liv"]);
  });

  it("leaves a lower automatic rank ahead of a larger priority", () => {
    // The rule is a global numeric priority, not "corrected photos first".
    const ordered = orderScenes([pinned("ast_pin", 8, "BALCONY"), input("ast_ext", "EXTERIOR")]);
    expect(ordered.map((i) => i.assetId)).toEqual(["ast_ext", "ast_pin"]);
  });

  it("slots a priority into the automatic sequence rather than above it", () => {
    const ordered = orderScenes([
      input("ast_ent", "ENTRANCE"), // rank 2
      input("ast_liv", "LIVING_ROOM"), // rank 4
      pinned("ast_pin", 3, "TOILET"), // priority 3, between them
    ]);
    expect(ordered.map((i) => i.assetId)).toEqual(["ast_ent", "ast_pin", "ast_liv"]);
  });

  it("breaks equal priorities by room, then suggestedOrder, then assetId", () => {
    const ordered = orderScenes([
      pinned("ast_c", 3, "KITCHEN"), // room rank 6
      pinned("ast_a", 3, "ENTRANCE"), // room rank 2
      pinned("ast_b", 3, "ENTRANCE", 1),
    ]);
    // Both ENTRANCE photos precede the kitchen; between them the one with a
    // stated suggestedOrder precedes the one without (nulls last).
    expect(ordered.map((i) => i.assetId)).toEqual(["ast_b", "ast_a", "ast_c"]);
  });

  it("falls through to assetId when priority, room, and suggestedOrder all tie", () => {
    const ordered = orderScenes([pinned("ast_z", 5), pinned("ast_a", 5), pinned("ast_m", 5)]);
    expect(ordered.map((i) => i.assetId)).toEqual(["ast_a", "ast_m", "ast_z"]);
  });

  it("does not clamp a priority above the unclassified fallback rank", () => {
    // FALLBACK_RANK is 99. A priority of 150 is the reviewer's stated intent,
    // and normalizing it would silently overrule them.
    const ordered = orderScenes([pinned("ast_pin", 150, "KITCHEN"), input("ast_unknown", null)]);
    expect(ordered.map((i) => i.assetId)).toEqual(["ast_unknown", "ast_pin"]);
  });

  it("accepts duplicate priorities while still refusing a duplicate assetId", () => {
    expect(() => orderScenes([pinned("ast_a", 2), pinned("ast_b", 2)])).not.toThrow();
    expect(() => orderScenes([pinned("ast_a", 2), pinned("ast_a", 5)])).toThrow(AppError);
  });

  it("is independent of the order the inputs arrive in", () => {
    const set = [
      pinned("ast_p1", 2, "TOILET"),
      input("ast_ext", "EXTERIOR"),
      pinned("ast_p2", 2, "ENTRANCE"),
      input("ast_kit", "KITCHEN"),
      input("ast_none", null),
    ];
    const expected = orderScenes(set).map((i) => i.assetId);
    const shuffled = [set[3]!, set[0]!, set[4]!, set[2]!, set[1]!];
    expect(orderScenes(shuffled).map((i) => i.assetId)).toEqual(expected);
  });
});

describe("corrected room type", () => {
  it("ranks by the effective room the projection supplied", () => {
    // The analyzer said BATHROOM (rank 10); the reviewer corrected it to
    // LIVING_ROOM (rank 4), and the projection already resolved that — ordering
    // simply sees LIVING_ROOM.
    const ordered = orderScenes([input("ast_kit", "KITCHEN"), input("ast_fixed", "LIVING_ROOM")]);
    expect(ordered.map((i) => i.assetId)).toEqual(["ast_fixed", "ast_kit"]);
  });

  it("leaves ordering unchanged when no input carries a priority", () => {
    // The Phase 3C behaviour, restated: with every orderOverride null the
    // primary key is the room rank and nothing about the sequence moves.
    const ordered = orderScenes(SEQUENCE.map((room, i) => input(`ast_${i}`, room)).reverse());
    expect(ordered.map((i) => i.roomType)).toEqual([...SEQUENCE]);
  });
});
