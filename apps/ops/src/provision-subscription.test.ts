import { describe, expect, it } from "vitest";
import type {
  OrganizationSubscription,
  ProvisionSubscriptionInput,
  ProvisionSubscriptionOutcome,
  SalesContractProvisioning,
} from "@app/domain";
import { parseProvisionArguments, runProvisionSubscription } from "./provision-subscription";

/**
 * The operator command that gives an organization its contract's plan (UP-1,
 * ADR-0066 Decisions 1 and 2): every option required, the start an explicit
 * instant, and each outcome said plainly with the right exit code.
 */

const VALID = [
  "--organization",
  "org_1",
  "--plan",
  "premium",
  "--starts",
  "2026-11-01T00:00:00+09:00",
  "--contract",
  "VT-2026-001",
  "--operator",
  "Aoi Tanaka",
  "--reason",
  "Signed order 12",
];

function without(option: string): string[] {
  const index = VALID.indexOf(option);
  return [...VALID.slice(0, index), ...VALID.slice(index + 2)];
}

function replacing(option: string, value: string): string[] {
  const args = [...VALID];
  args[args.indexOf(option) + 1] = value;
  return args;
}

function errorOf(argv: readonly string[]): string {
  const parsed = parseProvisionArguments(argv);
  if (parsed.ok) throw new Error("expected a refusal");
  return parsed.error;
}

describe("reading the command line", () => {
  it("reads every option, trimmed, and the start as the instant it names", () => {
    expect(parseProvisionArguments(replacing("--operator", "  Aoi Tanaka  "))).toEqual({
      ok: true,
      value: {
        organizationId: "org_1",
        planKey: "premium",
        startsAt: new Date("2026-10-31T15:00:00.000Z"),
        contractReference: "VT-2026-001",
        operator: { name: "Aoi Tanaka", reason: "Signed order 12" },
      },
    });
  });

  it.each(["standard", "premium", "enterprise"])("accepts the %s plan", (plan) => {
    const parsed = parseProvisionArguments(replacing("--plan", plan));
    expect(parsed.ok && parsed.value.planKey).toBe(plan);
  });

  it.each(["--organization", "--plan", "--starts", "--contract", "--operator", "--reason"])(
    "requires %s",
    (option) => {
      expect(errorOf(without(option))).toContain(option);
    },
  );

  it.each(["--organization", "--contract", "--operator", "--reason"])("refuses a blank %s", (option) => {
    expect(errorOf(replacing(option, "   "))).toBe(`${option} is required`);
  });

  it.each([
    ["--organization", 100],
    ["--contract", 200],
    ["--operator", 200],
    ["--reason", 500],
  ] as const)("refuses %s longer than %i characters, and accepts exactly that many", (option, limit) => {
    expect(errorOf(replacing(option, "x".repeat(limit + 1)))).toBe(
      `${option} is longer than ${limit} characters`,
    );
    expect(parseProvisionArguments(replacing(option, "x".repeat(limit))).ok).toBe(true);
  });

  it.each(["free", "Premium", "", "self-service"])("refuses the plan %j", (plan) => {
    expect(errorOf(replacing("--plan", plan))).toBe("--plan must be standard, premium or enterprise");
  });

  it.each([
    "2026-11-01",
    "2026-11-01T00:00:00",
    "next month",
    "2026-13-01T00:00:00Z",
    "2026-00-01T00:00:00Z",
    "2026-11-01T00:00:00 JST",
    "2026-02-29T00:00:00Z",
    "2026-02-30T00:00:00Z",
    "2026-04-31T00:00:00+09:00",
    "2026-11-00T00:00:00Z",
    "2026-11-01T24:00:00Z",
    "2026-11-01T23:60:00Z",
    "2026-11-01T23:59:60Z",
    "2026-11-01T00:00:00+24:00",
    "2026-11-01T00:00:00+09:60",
  ])(
    "refuses the start %j, which is not an instant with a time zone",
    (starts) => {
      expect(errorOf(replacing("--starts", starts))).toContain("--starts must be an ISO 8601 instant with a time zone");
    },
  );

  it.each([
    ["2026-11-01T00:00Z", "2026-11-01T00:00:00.000Z"],
    ["2026-11-01T00:00:00.000Z", "2026-11-01T00:00:00.000Z"],
    ["2026-11-01T09:00:00+09:00", "2026-11-01T00:00:00.000Z"],
    ["2028-02-29T23:59:59-05:30", "2028-03-01T05:29:59.000Z"],
    ["2026-12-31T23:59:59.999Z", "2026-12-31T23:59:59.999Z"],
  ])("accepts the start %j as %s", (starts, instant) => {
    const parsed = parseProvisionArguments(replacing("--starts", starts));
    expect(parsed.ok && parsed.value.startsAt.toISOString()).toBe(instant);
  });

  it("refuses an unknown option or a stray argument", () => {
    expect(errorOf([...VALID, "--channel", "SELF_SERVICE"])).toContain("--channel");
    expect(parseProvisionArguments([...VALID, "extra"]).ok).toBe(false);
  });

  it("reports every problem at once", () => {
    const error = errorOf(["--plan", "free"]);
    for (const option of ["--organization", "--contract", "--operator", "--reason", "--plan", "--starts"]) {
      expect(error).toContain(option);
    }
  });
});

const INPUT: SalesContractProvisioning = {
  organizationId: "org_1",
  planKey: "premium",
  startsAt: new Date("2026-10-31T15:00:00.000Z"),
  contractReference: "VT-2026-001",
  operator: { name: "Aoi Tanaka", reason: "Signed order 12" },
};

function repository(outcome: ProvisionSubscriptionOutcome, existing: OrganizationSubscription | null = null) {
  const provisioned: ProvisionSubscriptionInput[] = [];
  return {
    provisioned,
    subscriptions: {
      provision: async (input: ProvisionSubscriptionInput) => {
        provisioned.push(input);
        return outcome;
      },
      findByOrganization: async () => existing,
    },
  };
}

const SUBSCRIPTION: OrganizationSubscription = {
  id: "sub_org_1",
  organizationId: "org_1",
  planKey: "premium",
  channel: "SALES_ASSISTED",
  anchorAt: INPUT.startsAt,
  commercialReference: "VT-2026-001",
  createdAt: new Date("2026-10-16T00:00:00.000Z"),
};

describe("running it", () => {
  it("provisions a sales-assisted subscription and says so, naming the operator", async () => {
    const { provisioned, subscriptions } = repository({ kind: "PROVISIONED", subscription: SUBSCRIPTION });
    expect(await runProvisionSubscription(subscriptions, INPUT)).toEqual({
      exitCode: 0,
      message:
        "Provisioned organization org_1: Premium, invoice-paid, from 2026-10-31T15:00:00.000Z, contract VT-2026-001. Audited with operator Aoi Tanaka.",
    });
    expect(provisioned).toEqual([
      {
        id: "sub_org_1",
        organizationId: "org_1",
        planKey: "premium",
        channel: "SALES_ASSISTED",
        anchorAt: INPUT.startsAt,
        commercialReference: "VT-2026-001",
        actorUserId: null,
        operator: { name: "Aoi Tanaka", reason: "Signed order 12" },
      },
    ]);
  });

  it("treats running it again with the same contract as done, writing nothing", async () => {
    const { subscriptions } = repository({ kind: "ALREADY_PROVISIONED", subscription: SUBSCRIPTION });
    expect(await runProvisionSubscription(subscriptions, INPUT)).toEqual({
      exitCode: 0,
      message:
        "Organization org_1 already has exactly this plan (Premium, invoice-paid, from 2026-10-31T15:00:00.000Z, contract VT-2026-001). Nothing was written.",
    });
  });

  it("refuses an organization that already has a different plan, and shows it", async () => {
    const { subscriptions } = repository(
      { kind: "CONFLICT" },
      { ...SUBSCRIPTION, planKey: "standard", commercialReference: "VT-2025-009" },
    );
    expect(await runProvisionSubscription(subscriptions, INPUT)).toEqual({
      exitCode: 1,
      message:
        "Refused: organization org_1 already has Standard, invoice-paid, from 2026-10-31T15:00:00.000Z, reference VT-2025-009. This command does not change a plan. Nothing was written.",
    });
  });

  it("names a card-paid plan as such when refusing", async () => {
    const { subscriptions } = repository(
      { kind: "CONFLICT" },
      { ...SUBSCRIPTION, channel: "SELF_SERVICE", commercialReference: "stripe-sub-1" },
    );
    expect((await runProvisionSubscription(subscriptions, INPUT)).message).toContain(
      "already has Premium, card-paid, from 2026-10-31T15:00:00.000Z, reference stripe-sub-1.",
    );
  });

  it("refuses a conflict it cannot describe without guessing", async () => {
    const { subscriptions } = repository({ kind: "CONFLICT" }, null);
    const result = await runProvisionSubscription(subscriptions, INPUT);
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("already has a different subscription");
  });

  it("refuses an organization that does not exist", async () => {
    const { subscriptions } = repository({ kind: "ORGANIZATION_NOT_FOUND" });
    expect(await runProvisionSubscription(subscriptions, INPUT)).toEqual({
      exitCode: 1,
      message: "Refused: there is no organization org_1. Nothing was written.",
    });
  });

  it.each(["INVALID_SUBSCRIPTION", "CHANNEL_NOT_OFFERED"] as const)("refuses %s", async (kind) => {
    const { subscriptions } = repository({ kind });
    expect(await runProvisionSubscription(subscriptions, INPUT)).toEqual({
      exitCode: 1,
      message: `Refused as invalid (${kind}). Nothing was written.`,
    });
  });
});
