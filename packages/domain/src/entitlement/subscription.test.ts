import { describe, expect, it } from "vitest";
import type { OpenEntitlementPeriodInput, OpenEntitlementPeriodOutcome, UnitEntitlementPeriod } from "./ports";
import {
  addUtcMonthsClamped,
  provisionRefusal,
  renewalPeriodAt,
  renewalPeriodBounds,
  renewalPeriodIdentity,
  renewEntitlementPeriod,
  type OrganizationSubscription,
  type ProvisionSubscriptionInput,
} from "./subscription";

/**
 * The subscription's monthly periods and on-demand renewal (Phase 6B, ADR-0056).
 *
 * Every expected instant is written out literally. A test that recomputed it with
 * the production rule would agree with whatever the rule says.
 */

const iso = (value: string) => new Date(value);

describe("monthly period arithmetic", () => {
  it("keeps the anchor's day and time of day", () => {
    expect(addUtcMonthsClamped(iso("2026-11-15T09:30:00.000Z"), 1)).toEqual(iso("2026-12-15T09:30:00.000Z"));
    expect(addUtcMonthsClamped(iso("2026-11-15T09:30:00.000Z"), 0)).toEqual(iso("2026-11-15T09:30:00.000Z"));
  });

  it("rolls over the year", () => {
    expect(addUtcMonthsClamped(iso("2026-12-10T00:00:00.000Z"), 1)).toEqual(iso("2027-01-10T00:00:00.000Z"));
    expect(addUtcMonthsClamped(iso("2026-12-10T00:00:00.000Z"), 13)).toEqual(iso("2028-01-10T00:00:00.000Z"));
  });

  it("clamps to the month's last day without drifting", () => {
    const anchor = iso("2027-01-31T12:00:00.000Z");
    expect(addUtcMonthsClamped(anchor, 1)).toEqual(iso("2027-02-28T12:00:00.000Z"));
    expect(addUtcMonthsClamped(anchor, 2)).toEqual(iso("2027-03-31T12:00:00.000Z"));
    expect(addUtcMonthsClamped(anchor, 3)).toEqual(iso("2027-04-30T12:00:00.000Z"));
    expect(addUtcMonthsClamped(anchor, 13)).toEqual(iso("2028-02-29T12:00:00.000Z"));
  });

  it("clamps a leap-day anchor in a common year", () => {
    expect(addUtcMonthsClamped(iso("2028-02-29T00:00:00.000Z"), 12)).toEqual(iso("2029-02-28T00:00:00.000Z"));
    expect(addUtcMonthsClamped(iso("2028-02-29T00:00:00.000Z"), 48)).toEqual(iso("2032-02-29T00:00:00.000Z"));
  });

  it("makes every period end exactly where the next begins", () => {
    for (const anchor of ["2027-01-31T23:59:59.999Z", "2028-02-29T00:00:00.000Z", "2026-11-30T15:00:00.000Z"]) {
      for (let index = 0; index < 60; index += 1) {
        const period = renewalPeriodBounds(iso(anchor), index);
        expect(period.endsAt).toEqual(renewalPeriodBounds(iso(anchor), index + 1).startsAt);
        expect(period.endsAt.getTime()).toBeGreaterThan(period.startsAt.getTime());
      }
    }
  });
});

describe("the period containing an instant", () => {
  const anchor = iso("2027-01-31T12:00:00.000Z");

  it("is none before the anchor", () => {
    expect(renewalPeriodAt(anchor, iso("2027-01-31T11:59:59.999Z"))).toBeNull();
  });

  it("starts inclusively at the anchor", () => {
    expect(renewalPeriodAt(anchor, anchor)).toEqual({
      index: 0,
      startsAt: iso("2027-01-31T12:00:00.000Z"),
      endsAt: iso("2027-02-28T12:00:00.000Z"),
    });
  });

  it("ends exclusively: the boundary instant belongs to the next period", () => {
    expect(renewalPeriodAt(anchor, iso("2027-02-28T11:59:59.999Z"))?.index).toBe(0);
    expect(renewalPeriodAt(anchor, iso("2027-02-28T12:00:00.000Z"))).toEqual({
      index: 1,
      startsAt: iso("2027-02-28T12:00:00.000Z"),
      endsAt: iso("2027-03-31T12:00:00.000Z"),
    });
  });

  it("is the previous month's period early in a month", () => {
    expect(renewalPeriodAt(anchor, iso("2027-03-05T00:00:00.000Z"))?.index).toBe(1);
    expect(renewalPeriodAt(anchor, iso("2027-03-31T12:00:00.000Z"))?.index).toBe(2);
  });

  it("is found years later", () => {
    expect(renewalPeriodAt(anchor, iso("2029-07-01T00:00:00.000Z"))).toEqual({
      index: 29,
      startsAt: iso("2029-06-30T12:00:00.000Z"),
      endsAt: iso("2029-07-31T12:00:00.000Z"),
    });
  });
});

describe("renewal identity", () => {
  it("is deterministic per subscription and period", () => {
    const period = renewalPeriodBounds(iso("2027-01-31T12:00:00.000Z"), 2);
    expect(renewalPeriodIdentity({ id: "sub_1" }, period)).toEqual({
      id: "uep_sub_1_2",
      billingCycleKey: "2027-03-31T12:00:00.000Z",
      commercialReference: "subscription:sub_1:2",
    });
  });
});

describe("provisioning validation", () => {
  const valid: ProvisionSubscriptionInput = {
    id: "sub_1",
    organizationId: "org_1",
    planKey: "premium",
    channel: "SELF_SERVICE",
    anchorAt: iso("2027-01-31T12:00:00.000Z"),
    commercialReference: "contract-1",
    actorUserId: null,
  };

  it("accepts Standard and Premium on either channel, and Enterprise sales-assisted", () => {
    expect(provisionRefusal(valid)).toBeNull();
    expect(provisionRefusal({ ...valid, planKey: "standard", channel: "SALES_ASSISTED" })).toBeNull();
    expect(provisionRefusal({ ...valid, planKey: "enterprise", channel: "SALES_ASSISTED" })).toBeNull();
  });

  it("refuses Enterprise on the self-service channel", () => {
    expect(provisionRefusal({ ...valid, planKey: "enterprise" })).toBe("CHANNEL_NOT_OFFERED");
  });

  it("refuses a subscription with no commercial record, identity or anchor", () => {
    expect(provisionRefusal({ ...valid, commercialReference: "" })).toBe("INVALID_SUBSCRIPTION");
    expect(provisionRefusal({ ...valid, id: "" })).toBe("INVALID_SUBSCRIPTION");
    expect(provisionRefusal({ ...valid, organizationId: "" })).toBe("INVALID_SUBSCRIPTION");
    expect(provisionRefusal({ ...valid, anchorAt: new Date(Number.NaN) })).toBe("INVALID_SUBSCRIPTION");
  });
});

describe("renewal", () => {
  const subscription: OrganizationSubscription = {
    id: "sub_1",
    organizationId: "org_1",
    planKey: "standard",
    channel: "SALES_ASSISTED",
    anchorAt: iso("2027-01-31T12:00:00.000Z"),
    commercialReference: "contract-1",
    createdAt: iso("2027-01-20T00:00:00.000Z"),
  };

  function harness(answer: (input: OpenEntitlementPeriodInput) => OpenEntitlementPeriodOutcome) {
    const asked: string[] = [];
    const opened: OpenEntitlementPeriodInput[] = [];
    const dependencies = {
      subscriptions: {
        findByOrganization: (organizationId: string) => {
          asked.push(organizationId);
          return Promise.resolve(organizationId === subscription.organizationId ? subscription : null);
        },
      },
      ledger: {
        openPeriod: (input: OpenEntitlementPeriodInput) => {
          opened.push(input);
          return Promise.resolve(answer(input));
        },
      },
    };
    return { dependencies, asked, opened };
  }

  function periodFor(input: OpenEntitlementPeriodInput): UnitEntitlementPeriod {
    return {
      id: input.id,
      organizationId: input.organizationId,
      billingCycleKey: input.billingCycleKey,
      planKey: input.planKey,
      baseUnits: 15,
      includedHighQualityUnits: 1,
      highQualityAddOnAvailable: false,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      commercialReference: input.commercialReference,
      createdAt: iso("2027-03-05T00:00:00.000Z"),
    };
  }

  it("opens the period containing the instant, on the subscription's plan, with no actor", async () => {
    const { dependencies, opened } = harness((input) => ({ kind: "OPENED", period: periodFor(input) }));
    const outcome = await renewEntitlementPeriod(dependencies, "org_1", iso("2027-03-05T00:00:00.000Z"));
    expect(outcome.kind).toBe("OPENED");
    expect(opened).toEqual([
      {
        id: "uep_sub_1_1",
        organizationId: "org_1",
        planKey: "standard",
        billingCycleKey: "2027-02-28T12:00:00.000Z",
        startsAt: iso("2027-02-28T12:00:00.000Z"),
        endsAt: iso("2027-03-31T12:00:00.000Z"),
        commercialReference: "subscription:sub_1:1",
        actorUserId: null,
      },
    ]);
  });

  it("passes a replay through as already open", async () => {
    const { dependencies } = harness((input) => ({ kind: "ALREADY_OPEN", period: periodFor(input) }));
    const outcome = await renewEntitlementPeriod(dependencies, "org_1", iso("2027-03-05T00:00:00.000Z"));
    expect(outcome.kind).toBe("ALREADY_OPEN");
  });

  it("answers an organization with no subscription without touching the ledger", async () => {
    const { dependencies, asked, opened } = harness(() => {
      throw new Error("must not open");
    });
    expect(await renewEntitlementPeriod(dependencies, "org_2", iso("2027-03-05T00:00:00.000Z"))).toEqual({
      kind: "NO_SUBSCRIPTION",
    });
    expect(asked).toEqual(["org_2"]);
    expect(opened).toEqual([]);
  });

  it("opens nothing before the anchor", async () => {
    const { dependencies, opened } = harness(() => {
      throw new Error("must not open");
    });
    expect(await renewEntitlementPeriod(dependencies, "org_1", iso("2027-01-31T11:59:59.999Z"))).toEqual({
      kind: "NOT_STARTED",
    });
    expect(opened).toEqual([]);
  });

  it("surfaces a colliding period instead of choosing one", async () => {
    for (const kind of ["CONFLICT", "OVERLAPS_EXISTING_PERIOD"] as const) {
      const { dependencies } = harness(() => ({ kind }));
      expect(await renewEntitlementPeriod(dependencies, "org_1", iso("2027-03-05T00:00:00.000Z"))).toEqual({
        kind: "PERIOD_CONFLICT",
      });
    }
  });

  it("treats a refused derived period as a defect", async () => {
    const { dependencies } = harness(() => ({ kind: "INVALID_PERIOD" }));
    await expect(renewEntitlementPeriod(dependencies, "org_1", iso("2027-03-05T00:00:00.000Z"))).rejects.toThrow(
      /refused as invalid/,
    );
  });

  it("refuses an invalid instant before reading anything", async () => {
    const { dependencies, asked } = harness(() => ({ kind: "INVALID_PERIOD" }));
    await expect(renewEntitlementPeriod(dependencies, "org_1", new Date(Number.NaN))).rejects.toThrow(
      /valid instant/,
    );
    expect(asked).toEqual([]);
  });
});
