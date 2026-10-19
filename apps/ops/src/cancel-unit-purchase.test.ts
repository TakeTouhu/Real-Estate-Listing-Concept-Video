import { describe, expect, it } from "vitest";
import type {
  CancellableUnitPurchase,
  CancelUnitPurchaseOutcome,
  CancelUnitPurchaseRequest,
  UnitPurchaseCancellation,
} from "@app/domain";
import {
  USAGE,
  describePurchase,
  parseCancelArguments,
  runCancelUnitPurchase,
  type CancelArguments,
} from "./cancel-unit-purchase";

/**
 * The operator command that cancels a mistaken Unit purchase (UP-5, ADR-0070):
 * every option but `--confirm` required, nothing written without `--confirm`,
 * and a plain account of what was withdrawn, kept and not invoiced.
 */

const VALID = ["--purchase", "upur_1", "--fault", "vtavision", "--operator", "Aoi Tanaka", "--reason", "Bought by mistake"];

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
  const parsed = parseCancelArguments(argv);
  if (parsed.ok) throw new Error("expected a refusal");
  return parsed.error;
}

const REQUEST: CancelUnitPurchaseRequest = {
  purchaseId: "upur_1",
  fault: "VTAVISION",
  operator: { name: "Aoi Tanaka", reason: "Bought by mistake" },
};

describe("reading the command line", () => {
  it("reads every option, trimmed, and only shows the purchase without --confirm", () => {
    expect(parseCancelArguments(replacing("--operator", "  Aoi Tanaka  "))).toEqual({
      ok: true,
      value: { request: REQUEST, confirm: false },
    });
  });

  it("cancels with --confirm", () => {
    expect(parseCancelArguments([...VALID, "--confirm"])).toEqual({ ok: true, value: { request: REQUEST, confirm: true } });
  });

  it("reads whose mistake it was, and nothing else for it", () => {
    expect(parseCancelArguments(replacing("--fault", " customer "))).toEqual({
      ok: true,
      value: { request: { ...REQUEST, fault: "CUSTOMER" }, confirm: false },
    });
    for (const other of ["ours", "VTAVISION", "Customer", "both"]) {
      expect(errorOf(replacing("--fault", other))).toBe("--fault must be vtavision or customer");
    }
  });

  it.each(["--purchase", "--fault", "--operator", "--reason"])("requires %s", (option) => {
    expect(errorOf(without(option))).toBe(`${option} is required`);
  });

  it.each(["--purchase", "--fault", "--operator", "--reason"])("refuses a blank %s", (option) => {
    expect(errorOf(replacing(option, "   "))).toBe(`${option} is required`);
  });

  it.each([
    ["--purchase", 100],
    ["--operator", 200],
    ["--reason", 500],
  ] as const)("refuses %s longer than %i characters, and accepts exactly that many", (option, limit) => {
    expect(errorOf(replacing(option, "x".repeat(limit + 1)))).toBe(`${option} is longer than ${limit} characters`);
    expect(parseCancelArguments(replacing(option, "x".repeat(limit))).ok).toBe(true);
  });

  it("refuses a value for --confirm, an unknown option or a stray argument", () => {
    expect(parseCancelArguments([...VALID, "--confirm=yes"]).ok).toBe(false);
    expect(errorOf([...VALID, "--organization", "org_1"])).toContain("--organization");
    expect(parseCancelArguments([...VALID, "extra"]).ok).toBe(false);
  });

  it("reports every problem at once", () => {
    expect(errorOf([])).toBe("--purchase is required\n--fault is required\n--operator is required\n--reason is required");
  });

  it("says in its usage whose mistake --fault names, and that nothing is cancelled without --confirm", () => {
    expect(USAGE).toContain("--fault <vtavision or customer: whose mistake it was>");
    expect(USAGE).toContain("[--confirm]   without it, nothing is cancelled: the purchase is only shown");
  });
});

const PURCHASE: CancellableUnitPurchase = {
  purchaseId: "upur_1",
  organizationId: "org_1",
  organizationName: "株式会社神田",
  quality: "NORMAL",
  units: 10,
  priceYenExTax: 35_900,
  invoicePaid: true,
  contractReference: "VT-2026-001",
  approvedAt: new Date("2026-10-19T01:56:07.000Z"),
  expiresAt: new Date("2026-10-31T15:00:00.000Z"),
  usage: { consumed: 3, inFlight: 1, unused: 6 },
  cancellation: null,
  readAt: new Date("2026-10-20T00:30:00.000Z"),
};

const CANCELLATION: UnitPurchaseCancellation = {
  fault: "VTAVISION",
  operatorName: "Aoi Tanaka",
  reason: "Bought by mistake",
  cancelledAt: new Date("2026-10-20T00:30:00.000Z"),
};

const DESCRIBED = [
  'Purchase upur_1 by organization org_1 ("株式会社神田"):',
  '  Normal 10 Units, ¥35,900 excluding tax, contract "VT-2026-001"',
  "  approved 2026-10-19T10:56:07+09:00, expires 2026-11-01T00:00:00+09:00",
  "  used: 3 delivered, 1 still generating; unused: 6",
].join("\n");

describe("describing the purchase", () => {
  it("names it, its package, price, contract, dates and usage", () => {
    expect(describePurchase(PURCHASE)).toBe(DESCRIBED);
  });

  it("prints names its members typed with control characters escaped", () => {
    const hostile = { ...PURCHASE, organizationName: 'A\u001b[2J"B', contractReference: "C\r\nD", quality: "HIGH_QUALITY" as const };
    const text = describePurchase(hostile);
    expect(text.includes("\u001b") || text.includes("\r")).toBe(false);
    expect(text).toContain('("A\\u001b[2J\\"B")');
    expect(text).toContain('HQ 10 Units, ¥35,900 excluding tax, contract "C\\r\\nD"');
  });
});

function harness(found: CancellableUnitPurchase | null, outcome: CancelUnitPurchaseOutcome) {
  const finds: string[] = [];
  const cancels: CancelUnitPurchaseRequest[] = [];
  return {
    finds,
    cancels,
    repository: {
      find: async (purchaseId: string) => {
        finds.push(purchaseId);
        return found;
      },
      cancel: async (request: CancelUnitPurchaseRequest) => {
        cancels.push(request);
        return outcome;
      },
    },
  };
}

const SHOW: CancelArguments = { request: REQUEST, confirm: false };
const CONFIRM: CancelArguments = { request: REQUEST, confirm: true };
const CANCELLED = { ...PURCHASE, cancellation: CANCELLATION };

describe("without --confirm", () => {
  it("shows the purchase and what cancelling it would do, and cancels nothing", async () => {
    const { finds, cancels, repository } = harness(PURCHASE, { kind: "NOT_FOUND" });
    expect(await runCancelUnitPurchase(repository, SHOW)).toEqual({
      exitCode: 0,
      message: [
        DESCRIBED,
        "As VTaVision's mistake, cancelling it withdraws its 6 unused Units now, and any that a running " +
          "generation fails to use; the 3 delivered stay used. The whole purchase is then not invoiced, " +
          "used Units included. It cannot be undone.",
        "Nothing was cancelled. To cancel it, run the same command again with --confirm.",
      ].join("\n"),
    });
    expect(finds).toEqual(["upur_1"]);
    expect(cancels).toEqual([]);
  });

  it("refuses a purchase that does not exist", async () => {
    const { cancels, repository } = harness(null, { kind: "NOT_FOUND" });
    expect(await runCancelUnitPurchase(repository, SHOW)).toEqual({
      exitCode: 1,
      message: "Refused: there is no purchase upur_1. Nothing was cancelled.",
    });
    expect(cancels).toEqual([]);
  });

  it("says when it was already cancelled, and by whom", async () => {
    const { cancels, repository } = harness(CANCELLED, { kind: "NOT_FOUND" });
    expect(await runCancelUnitPurchase(repository, SHOW)).toEqual({
      exitCode: 0,
      message: `${DESCRIBED}\nIt was already cancelled on 2026-10-20T09:30:00+09:00 by Aoi Tanaka, as VTaVision's mistake. Nothing was written.`,
    });
    expect(cancels).toEqual([]);
  });

  it("refuses a card-paid purchase", async () => {
    const { cancels, repository } = harness({ ...PURCHASE, invoicePaid: false }, { kind: "NOT_FOUND" });
    expect(await runCancelUnitPurchase(repository, SHOW)).toEqual({
      exitCode: 1,
      message:
        `${DESCRIBED}\n` +
        "Refused: its payment processor charged it, so it is refunded there, not cancelled here. Nothing was cancelled.",
    });
    expect(cancels).toEqual([]);
  });
});

describe("with --confirm", () => {
  it("cancels it and says what was withdrawn, kept and still running", async () => {
    const { finds, cancels, repository } = harness(null, { kind: "CANCELLED", purchase: CANCELLED });
    expect(await runCancelUnitPurchase(repository, CONFIRM)).toEqual({
      exitCode: 0,
      message: [
        DESCRIBED,
        "Cancelled as VTaVision's mistake: 6 unused Units withdrawn, 3 delivered kept, 1 still generating " +
          "left to finish. It will not be invoiced. Audited with operator Aoi Tanaka.",
        "If it was already invoiced, refund or offset it by hand: a later export marks it cancelled " +
          "and invoices nothing for it.",
      ].join("\n"),
    });
    expect(cancels).toEqual([REQUEST]);
    expect(finds).toEqual([]);
  });

  it("answers a cancellation made before as done, writing nothing", async () => {
    const { repository } = harness(null, { kind: "ALREADY_CANCELLED", purchase: CANCELLED });
    expect(await runCancelUnitPurchase(repository, CONFIRM)).toEqual({
      exitCode: 0,
      message: `${DESCRIBED}\nIt was already cancelled on 2026-10-20T09:30:00+09:00 by Aoi Tanaka, as VTaVision's mistake. Nothing was written.`,
    });
  });

  it("refuses a purchase that does not exist", async () => {
    const { repository } = harness(null, { kind: "NOT_FOUND" });
    expect(await runCancelUnitPurchase(repository, CONFIRM)).toEqual({
      exitCode: 1,
      message: "Refused: there is no purchase upur_1. Nothing was cancelled.",
    });
  });

  it("refuses a card-paid purchase", async () => {
    const card = { ...PURCHASE, invoicePaid: false };
    const { repository } = harness(null, { kind: "CARD_PAID", purchase: card });
    expect(await runCancelUnitPurchase(repository, CONFIRM)).toMatchObject({
      exitCode: 1,
      message: expect.stringContaining("Refused: its payment processor charged it"),
    });
  });
});

/** The customer's mistake: refunded only within 10 hours of approval, with none of its Units used. */
const CUSTOMER: CancelUnitPurchaseRequest = { ...REQUEST, fault: "CUSTOMER" };
/** Read exactly 10 hours after its approval, nothing used: the last instant it can be refunded. */
const FRESH: CancellableUnitPurchase = {
  ...PURCHASE,
  usage: { consumed: 0, inFlight: 0, unused: 10 },
  readAt: new Date("2026-10-19T11:56:07.000Z"),
};
const FRESH_DESCRIBED = DESCRIBED.replace(
  "used: 3 delivered, 1 still generating; unused: 6",
  "used: 0 delivered, 0 still generating; unused: 10",
);

describe("the customer's mistake", () => {
  it("shows that it can be refunded until 10 hours after its approval, and cancels nothing", async () => {
    const { cancels, repository } = harness(FRESH, { kind: "NOT_FOUND" });
    expect(await runCancelUnitPurchase(repository, { request: CUSTOMER, confirm: false })).toEqual({
      exitCode: 0,
      message: [
        FRESH_DESCRIBED,
        "As the customer's mistake, cancelling it withdraws all 10 of its Units now, none of them used, and " +
          "the purchase is not invoiced. This is possible until 2026-10-19T20:56:07+09:00, 10 hours after " +
          "its approval, while none of its Units is used. It cannot be undone.",
        "Nothing was cancelled. To cancel it, run the same command again with --confirm.",
      ].join("\n"),
    });
    expect(cancels).toEqual([]);
  });

  it("refuses it more than 10 hours after its approval: it stays invoiced and usable", async () => {
    const late = { ...FRESH, readAt: new Date("2026-10-19T11:56:07.001Z") };
    const { cancels, repository } = harness(late, { kind: "NOT_FOUND" });
    expect(await runCancelUnitPurchase(repository, { request: CUSTOMER, confirm: false })).toEqual({
      exitCode: 1,
      message:
        `${FRESH_DESCRIBED}\n` +
        "Refused: it was approved more than 10 hours ago (the customer's mistake can be refunded until " +
        "2026-10-19T20:56:07+09:00). It stays invoiced and its Units stay usable. Nothing was cancelled.",
    });
    expect(cancels).toEqual([]);
  });

  it.each([
    ["delivered", { consumed: 1, inFlight: 0, unused: 9 }, "1 of its Units are delivered and 0 still generating"],
    ["still generating", { consumed: 0, inFlight: 1, unused: 9 }, "0 of its Units are delivered and 1 still generating"],
  ] as const)("refuses it once a Unit is %s, within the 10 hours", async (_, usage, why) => {
    const used = { ...FRESH, usage };
    const { cancels, repository } = harness(used, { kind: "NOT_FOUND" });
    const result = await runCancelUnitPurchase(repository, { request: CUSTOMER, confirm: false });
    expect(result).toMatchObject({ exitCode: 1 });
    expect(result.message.split("\n").at(-1)).toBe(
      `Refused: ${why}, and the customer's mistake is refunded only while none is used. ` +
        "It stays invoiced and its Units stay usable. Nothing was cancelled.",
    );
    expect(cancels).toEqual([]);
  });

  it("refuses with --confirm what the cancelling transaction refused", async () => {
    for (const kind of ["REFUND_WINDOW_PASSED", "UNITS_USED"] as const) {
      const { cancels, repository } = harness(null, { kind, purchase: FRESH });
      const result = await runCancelUnitPurchase(repository, { request: CUSTOMER, confirm: true });
      expect(result).toMatchObject({ exitCode: 1, message: expect.stringContaining("It stays invoiced") });
      expect(cancels).toEqual([CUSTOMER]);
    }
  });

  it("cancels it with --confirm and says it was the customer's mistake", async () => {
    const cancelled = { ...FRESH, cancellation: { ...CANCELLATION, fault: "CUSTOMER" as const } };
    const { repository } = harness(null, { kind: "CANCELLED", purchase: cancelled });
    const result = await runCancelUnitPurchase(repository, { request: CUSTOMER, confirm: true });
    expect(result.exitCode).toBe(0);
    expect(result.message.split("\n")[4]).toBe(
      "Cancelled as the customer's mistake: 10 unused Units withdrawn, 0 delivered kept, 0 still generating " +
        "left to finish. It will not be invoiced. Audited with operator Aoi Tanaka.",
    );
  });

  it("says a cancellation made before was the customer's mistake", async () => {
    const cancelled = { ...FRESH, cancellation: { ...CANCELLATION, fault: "CUSTOMER" as const } };
    const { repository } = harness(cancelled, { kind: "NOT_FOUND" });
    expect((await runCancelUnitPurchase(repository, SHOW)).message).toContain(
      "by Aoi Tanaka, as the customer's mistake. Nothing was written.",
    );
  });
});

describe("VTaVision's mistake", () => {
  it("is cancelled however long ago it was approved and however much of it is used", async () => {
    const { repository } = harness(PURCHASE, { kind: "NOT_FOUND" });
    expect(await runCancelUnitPurchase(repository, SHOW)).toMatchObject({ exitCode: 0 });
    expect(PURCHASE.readAt.getTime() - PURCHASE.approvedAt.getTime()).toBeGreaterThan(10 * 3_600_000);
  });
});
