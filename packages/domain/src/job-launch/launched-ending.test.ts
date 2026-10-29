import { describe, expect, it } from "vitest";
import { GENERATION_JOB_STATES, GENERATION_RESERVATION_STATES } from "../orchestration/types";
import { JOB_STATES_BEFORE_ASSEMBLY, decideLaunchedJobEnding, type LaunchedJobLockedRows } from "./launched-ending";

/** A deleted Property's launched job, its Unit held: every field the ending reads. */
const ENDABLE: LaunchedJobLockedRows = {
  jobState: "GENERATING",
  jobHoldsDeliverable: false,
  reservationState: "RESERVED",
  propertyDeleted: true,
};

const BEFORE_ASSEMBLY: readonly string[] = JOB_STATES_BEFORE_ASSEMBLY;

describe("the ending of a deleted Property's launched job", () => {
  it.each(["GENERATING", "SCENES_READY", "COMPOSITION_PENDING"])("ends one %s, from that state", (jobState) => {
    expect(decideLaunchedJobEnding({ ...ENDABLE, jobState })).toEqual({ kind: "END", from: jobState });
  });

  it("names exactly the three states before assembly", () => {
    expect(JOB_STATES_BEFORE_ASSEMBLY).toEqual(["GENERATING", "SCENES_READY", "COMPOSITION_PENDING"]);
    expect(Object.isFrozen(JOB_STATES_BEFORE_ASSEMBLY)).toBe(true);
  });

  it.each([...GENERATION_JOB_STATES.filter((state) => !BEFORE_ASSEMBLY.includes(state)), null])(
    "keeps a job %s, whatever else is true of it",
    (jobState) => {
      for (const others of [
        ENDABLE,
        { jobHoldsDeliverable: true, reservationState: "CONSUMED", propertyDeleted: false },
      ]) {
        expect(decideLaunchedJobEnding({ ...others, jobState })).toEqual({
          kind: "KEEP",
          reason: "NOT_BEFORE_ASSEMBLY",
        });
      }
    },
  );

  it("keeps a job that holds a delivered video, before reading its hold", () => {
    for (const reservationState of ["RESERVED", "CONSUMED"]) {
      expect(decideLaunchedJobEnding({ ...ENDABLE, jobHoldsDeliverable: true, reservationState })).toEqual({
        kind: "KEEP",
        reason: "HOLDS_DELIVERABLE",
      });
    }
  });

  it.each([...GENERATION_RESERVATION_STATES.filter((state) => state !== "RESERVED"), null])(
    "keeps a job whose hold is %s: only RESERVED is released",
    (reservationState) => {
      expect(decideLaunchedJobEnding({ ...ENDABLE, reservationState })).toEqual({
        kind: "KEEP",
        reason: "RESERVATION_NOT_HELD",
      });
    },
  );

  it("keeps a job whose Property stands, and reads the Property last", () => {
    expect(decideLaunchedJobEnding({ ...ENDABLE, propertyDeleted: false })).toEqual({
      kind: "KEEP",
      reason: "PROPERTY_STANDS",
    });
    expect(decideLaunchedJobEnding({ ...ENDABLE, propertyDeleted: false, reservationState: "CONSUMED" })).toEqual({
      kind: "KEEP",
      reason: "RESERVATION_NOT_HELD",
    });
  });
});
