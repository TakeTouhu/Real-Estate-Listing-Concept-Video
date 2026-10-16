import { createSubscriptionRepository, getPrismaClient } from "@app/database";
import { USAGE, parseProvisionArguments, runProvisionSubscription } from "../provision-subscription";

// Entry point only: everything it does is in `../provision-subscription.ts`,
// where it is tested. Exit codes: 0 done, 1 refused, 2 unusable arguments.
const parsed = parseProvisionArguments(process.argv.slice(2));
if (!parsed.ok) {
  console.error(parsed.error);
  console.error(USAGE);
  process.exit(2);
}

const prisma = getPrismaClient();
try {
  const result = await runProvisionSubscription(createSubscriptionRepository(prisma), parsed.value);
  if (result.exitCode === 0) console.log(result.message);
  else console.error(result.message);
  process.exitCode = result.exitCode;
} finally {
  await prisma.$disconnect();
}
