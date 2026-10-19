import { access, writeFile } from "node:fs/promises";
import { createUnitPurchaseInvoicingRepository, getPrismaClient } from "@app/database";
import { USAGE, parseExportArguments, runExportUnitPurchases } from "../export-unit-purchases";

// Entry point only: everything it does is in `../export-unit-purchases.ts`,
// where it is tested. Exit codes: 0 written, 1 refused, 2 unusable arguments.
const parsed = parseExportArguments(process.argv.slice(2));
if (!parsed.ok) {
  console.error(parsed.error);
  console.error(USAGE);
  process.exit(2);
}

const files = {
  exists: (path: string) => access(path).then(() => true, () => false),
  writeNew: (path: string, contents: string) => writeFile(path, contents, { flag: "wx", mode: 0o600 }),
};

const prisma = getPrismaClient();
try {
  const repository = createUnitPurchaseInvoicingRepository(prisma);
  const result = await runExportUnitPurchases(repository, files, parsed.value);
  if (result.exitCode === 0) console.log(result.message);
  else console.error(result.message);
  process.exitCode = result.exitCode;
} finally {
  await prisma.$disconnect();
}
