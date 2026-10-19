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

const VALID = ["--purchase", "upur_1", "--operator", "Aoi Tanaka", "--reason", "Bought by mistake"];

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

  it.each(["--purchase", "--operator", "--reason"])("requires %s", (option) => {
    expect(errorOf(without(option))).toBe(`${option} is required`);
  });

  it.each(["--purchase", "--operator", "--reason"])("refuses a blank %s", (option) => {
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
    expect(errorOf([])).toBe("--purchase is required\n--operator is required\n--reason is required");
  });

  it("says in its usage that nothing is cancelled without --confirm", () => {
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
};

const CANCELLATION: UnitPurchaseCancellation = {
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
        "Cancelling it withdraws its 6 unused Units now, and any that a running generation fails to use; " +
          "the 3 delivered stay used. The whole purchase is then not invoiced, used Units included. " +
          "It cannot be undone.",
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
      message: `${DESCRIBED}\nIt was already cancelled on 2026-10-20T09:30:00+09:00 by Aoi Tanaka. Nothing was written.`,
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
        "Cancelled: 6 unused Units withdrawn, 3 delivered kept, 1 still generating left to finish. " +
          "It will not be invoiced. Audited with operator Aoi Tanaka.",
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
      message: `${DESCRIBED}\nIt was already cancelled on 2026-10-20T09:30:00+09:00 by Aoi Tanaka. Nothing was written.`,
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
