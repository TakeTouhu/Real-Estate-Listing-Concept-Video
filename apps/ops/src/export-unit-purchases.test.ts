import { describe, expect, it } from "vitest";
import type { InvoiceableUnitPurchase, UnitPurchaseExportRequest } from "@app/domain";
import {
  jstInstant,
  parseExportArguments,
  runExportUnitPurchases,
  textCell,
  unitPurchasesCsv,
  type ExportArguments,
} from "./export-unit-purchases";

/**
 * The operator command that lists invoice-paid purchases for invoicing (UP-4,
 * ADR-0069): every option required, a window of explicit instants that has
 * already ended, a new file each time, and CSV a spreadsheet reads as written.
 */

const VALID = [
  "--from",
  "2026-10-01T00:00:00+09:00",
  "--to",
  "2026-11-01T00:00:00+09:00",
  "--out",
  "october.csv",
  "--operator",
  "Aoi Tanaka",
  "--reason",
  "October invoices",
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
  const parsed = parseExportArguments(argv);
  if (parsed.ok) throw new Error("expected a refusal");
  return parsed.error;
}

const REQUEST: UnitPurchaseExportRequest = {
  from: new Date("2026-09-30T15:00:00.000Z"),
  to: new Date("2026-10-31T15:00:00.000Z"),
  operator: { name: "Aoi Tanaka", reason: "October invoices" },
};

describe("reading the command line", () => {
  it("reads every option, trimmed, and the window as the instants it names", () => {
    expect(parseExportArguments(replacing("--operator", "  Aoi Tanaka  "))).toEqual({
      ok: true,
      value: { request: REQUEST, out: "october.csv" },
    });
  });

  it.each(["--from", "--to", "--out", "--operator", "--reason"])("requires %s", (option) => {
    expect(errorOf(without(option))).toContain(option);
  });

  it.each(["--out", "--operator", "--reason"])("refuses a blank %s", (option) => {
    expect(errorOf(replacing(option, "   "))).toBe(`${option} is required`);
  });

  it.each([
    ["--out", 500],
    ["--operator", 200],
    ["--reason", 500],
  ] as const)("refuses %s longer than %i characters, and accepts exactly that many", (option, limit) => {
    expect(errorOf(replacing(option, "x".repeat(limit + 1)))).toBe(`${option} is longer than ${limit} characters`);
    expect(parseExportArguments(replacing(option, "x".repeat(limit))).ok).toBe(true);
  });

  it.each(["--from", "--to"])("refuses %s without a time zone", (option) => {
    expect(errorOf(replacing(option, "2026-10-01T00:00:00"))).toBe(
      `${option} must be an ISO 8601 instant with a time zone, e.g. 2026-10-01T00:00:00+09:00`,
    );
  });

  it.each([
    ["2026-11-01T00:00:00+09:00", "an empty window"],
    ["2026-11-01T00:00:01+09:00", "a window that ends before it starts"],
  ])("refuses --from %s: %s", (from) => {
    expect(errorOf(replacing("--from", from))).toBe("--from must be before --to");
  });

  it("accepts a window of one millisecond", () => {
    const parsed = parseExportArguments(replacing("--from", "2026-10-31T23:59:59.999+09:00"));
    expect(parsed.ok && parsed.value.request.from.toISOString()).toBe("2026-10-31T14:59:59.999Z");
  });

  it("refuses an unknown option or a stray argument", () => {
    expect(errorOf([...VALID, "--organization", "org_1"])).toContain("--organization");
    expect(parseExportArguments([...VALID, "extra"]).ok).toBe(false);
  });

  it("reports every problem at once", () => {
    const error = errorOf(["--from", "soon"]);
    for (const option of ["--from", "--to", "--out", "--operator", "--reason"]) expect(error).toContain(option);
  });
});

describe("writing the CSV", () => {
  it.each([
    ["2026-10-19T01:56:07.123Z", "2026-10-19T10:56:07+09:00"],
    ["2026-10-31T15:00:00.000Z", "2026-11-01T00:00:00+09:00"],
    ["2026-12-31T14:59:59.000Z", "2026-12-31T23:59:59+09:00"],
  ])("writes %s in Japan time as %s", (instant, written) => {
    expect(jstInstant(new Date(instant))).toBe(written);
  });

  it.each([
    ["Studio Kanda", '"Studio Kanda"'],
    ['Say "hi", then go', '"Say ""hi"", then go"'],
    ["two\r\nlines", '"two\r\nlines"'],
    ["株式会社神田", '"株式会社神田"'],
    ["=HYPERLINK(\"x\")", '"\'=HYPERLINK(""x"")"'],
    ["+81", "\"'+81\""],
    ["-1", "\"'-1\""],
    ["@SUM(A1)", "\"'@SUM(A1)\""],
    ["\tcmd", "\"'\tcmd\""],
    ["\rcmd", "\"'\rcmd\""],
    ["a=b", '"a=b"'],
    ["", '""'],
  ])("writes the text %j as %s", (value, cell) => {
    expect(textCell(value)).toBe(cell);
  });

  const purchase = (overrides: Partial<InvoiceableUnitPurchase> = {}): InvoiceableUnitPurchase => ({
    purchaseId: "upur_1",
    organizationId: "org_1",
    organizationName: "株式会社神田",
    contractReference: "VT-2026-001",
    quality: "NORMAL",
    units: 10,
    priceYenExTax: 35_900,
    approvedAt: new Date("2026-10-19T01:56:07.000Z"),
    expiresAt: new Date("2026-10-31T15:00:00.000Z"),
    ...overrides,
  });

  const HEADER = [
    "organization_id",
    "organization_name",
    "contract_reference",
    "purchase_id",
    "approved_at",
    "quality",
    "units",
    "price_yen_ex_tax",
    "expires_at",
  ].join(",");

  it("writes a byte order mark, a header and one CRLF-ended row per purchase, in the order given", () => {
    const hq = purchase({ purchaseId: "upur_2", organizationName: "=cmd", quality: "HIGH_QUALITY", units: 2 });
    const csv = unitPurchasesCsv([purchase(), hq]);
    expect(csv).toBe(
      "\uFEFF" +
        `${HEADER}\r\n` +
        '"org_1","株式会社神田","VT-2026-001","upur_1","2026-10-19T10:56:07+09:00","Normal",10,35900,' +
        '"2026-11-01T00:00:00+09:00"\r\n' +
        '"org_1","\'=cmd","VT-2026-001","upur_2","2026-10-19T10:56:07+09:00","HQ",2,35900,' +
        '"2026-11-01T00:00:00+09:00"\r\n',
    );
  });

  it("writes the header alone when nothing was bought", () => {
    expect(unitPurchasesCsv([])).toBe(`\uFEFF${HEADER}\r\n`);
  });
});

function harness(purchases: readonly InvoiceableUnitPurchase[], existing: readonly string[] = []) {
  const requests: UnitPurchaseExportRequest[] = [];
  const written = new Map<string, string>();
  return {
    requests,
    written,
    repository: {
      exportForInvoicing: async (request: UnitPurchaseExportRequest) => {
        requests.push(request);
        return purchases;
      },
    },
    files: {
      exists: async (path: string) => existing.includes(path) || written.has(path),
      writeNew: async (path: string, contents: string) => {
        if (existing.includes(path) || written.has(path)) throw new Error(`EEXIST: ${path}`);
        written.set(path, contents);
      },
    },
  };
}

const ARGUMENTS: ExportArguments = { request: REQUEST, out: "october.csv" };
const AFTER = new Date("2026-11-01T00:00:00.000Z");

const listed = (purchaseId: string, organizationId: string, priceYenExTax: number): InvoiceableUnitPurchase => ({
  purchaseId,
  organizationId,
  organizationName: organizationId,
  contractReference: "VT-1",
  quality: "NORMAL",
  units: 10,
  priceYenExTax,
  approvedAt: new Date("2026-10-19T01:56:07.000Z"),
  expiresAt: new Date("2026-10-31T15:00:00.000Z"),
});

describe("running it", () => {
  it("lists the window's purchases into the new file and says what it wrote", async () => {
    const purchases = [
      listed("upur_1", "org_1", 35_900),
      listed("upur_2", "org_1", 9_000),
      listed("upur_3", "org_2", 19_900),
    ];
    const { requests, written, repository, files } = harness(purchases);
    expect(await runExportUnitPurchases(repository, files, ARGUMENTS, AFTER)).toEqual({
      exitCode: 0,
      message:
        "Wrote 3 purchases for 2 organizations approved from 2026-10-01T00:00:00+09:00 to 2026-11-01T00:00:00+09:00 " +
        "to october.csv: ¥64,800 excluding tax in total. Each organization is audited with operator Aoi Tanaka.",
    });
    expect(requests).toEqual([REQUEST]);
    expect([...written]).toEqual([["october.csv", unitPurchasesCsv(purchases)]]);
  });

  it("counts one purchase for one organization in the singular", async () => {
    const { repository, files } = harness([listed("upur_1", "org_1", 35_900)]);
    expect((await runExportUnitPurchases(repository, files, ARGUMENTS, AFTER)).message).toContain(
      "Wrote 1 purchase for 1 organization approved from",
    );
  });

  it("writes the header alone when nothing was bought, and says so", async () => {
    const { written, repository, files } = harness([]);
    expect(await runExportUnitPurchases(repository, files, ARGUMENTS, AFTER)).toEqual({
      exitCode: 0,
      message:
        "No invoice-paid purchases were approved from 2026-10-01T00:00:00+09:00 to 2026-11-01T00:00:00+09:00. " +
        "Wrote october.csv with no rows.",
    });
    expect(written.get("october.csv")).toBe(unitPurchasesCsv([]));
  });

  it("runs once the window has ended, its end excluded", async () => {
    const { requests, repository, files } = harness([]);
    expect((await runExportUnitPurchases(repository, files, ARGUMENTS, REQUEST.to)).exitCode).toBe(0);
    expect(requests).toHaveLength(1);
  });

  it("refuses a window that has not ended, listing and auditing nothing", async () => {
    const { requests, written, repository, files } = harness([listed("upur_1", "org_1", 35_900)]);
    const before = new Date(REQUEST.to.getTime() - 1);
    expect(await runExportUnitPurchases(repository, files, ARGUMENTS, before)).toEqual({
      exitCode: 1,
      message:
        "Refused: --to is in the future, so purchases still to be approved before it would be left out. " +
        "Nothing was listed or audited.",
    });
    expect(requests).toEqual([]);
    expect(written.size).toBe(0);
  });

  it("refuses a file that already exists before listing or auditing anything", async () => {
    const { requests, repository, files } = harness([listed("upur_1", "org_1", 35_900)], ["october.csv"]);
    expect(await runExportUnitPurchases(repository, files, ARGUMENTS, AFTER)).toEqual({
      exitCode: 1,
      message: "Refused: october.csv already exists. Nothing was listed or audited.",
    });
    expect(requests).toEqual([]);
  });

  it("fails loudly if the file appears while listing, overwriting nothing", async () => {
    const { repository, files } = harness([listed("upur_1", "org_1", 35_900)]);
    const racing = {
      ...files,
      writeNew: async (path: string) => {
        throw new Error(`EEXIST: ${path}`);
      },
    };
    await expect(runExportUnitPurchases(repository, racing, ARGUMENTS, AFTER)).rejects.toThrow("EEXIST: october.csv");
  });
});
