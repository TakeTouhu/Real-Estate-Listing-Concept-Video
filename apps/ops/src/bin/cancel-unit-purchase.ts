import { createUnitPurchaseCancellationRepository, getPrismaClient } from "@app/database";
import { USAGE, parseCancelArguments, runCancelUnitPurchase } from "../cancel-unit-purchase";

// Entry point only: everything it does is in `../cancel-unit-purchase.ts`,
// where it is tested. Exit codes: 0 shown or cancelled, 1 refused, 2 unusable arguments.
const parsed = parseCancelArguments(process.argv.slice(2));
if (!parsed.ok) {
  console.error(parsed.error);
  console.error(USAGE);
  process.exit(2);
}

const prisma = getPrismaClient();
try {
  const result = await runCancelUnitPurchase(createUnitPurchaseCancellationRepository(prisma), parsed.value);
  if (result.exitCode === 0) console.log(result.message);
  else console.error(result.message);
  process.exitCode = result.exitCode;
} finally {
  await prisma.$disconnect();
}
