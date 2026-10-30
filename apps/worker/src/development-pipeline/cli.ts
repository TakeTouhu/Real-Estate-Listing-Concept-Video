import { getPrismaClient } from "@app/database";
import { AppError, loadServerEnv, type ServerEnv } from "@app/shared";
import { assembleDevelopmentPipeline, type DevelopmentPipeline } from "./assembly";
import {
  USAGE,
  formatPipelineCycle,
  formatPipelineReport,
  parsePipelineArguments,
  pipelineExitCode,
  refuseForeignAttempts,
  refuseRemoteDatabase,
  runDevelopmentPipeline,
} from "./command";

// Entry point only: everything it does is in `./command.ts` and `./assembly.ts`,
// where it is tested. Exit codes: 0 nothing more to do now, 1 stopped or
// something failed, 2 refused before any step ran.
const parsed = parsePipelineArguments(process.argv.slice(2));
if (!parsed.ok) {
  console.error(parsed.error);
  console.error(USAGE);
  process.exit(2);
}

const prisma = getPrismaClient();

/** The steps, or `null` once the refusal has been printed. */
async function prepare(providerFolder: string): Promise<DevelopmentPipeline | null> {
  let env: ServerEnv;
  try {
    env = loadServerEnv();
  } catch (error) {
    // It names each variable and what is wrong with it; no secret's value is repeated.
    console.error(error instanceof Error ? error.message : "Invalid server environment configuration");
    return null;
  }
  try {
    // The address first, then the assembly's refusals, so production never reaches the database.
    refuseRemoteDatabase(env.DATABASE_URL);
    const steps = assembleDevelopmentPipeline(env, { providerFolder }, { prisma });
    await refuseForeignAttempts(prisma);
    return steps;
  } catch (error) {
    // A database or file system error's text may name a host or a user: only its kind is said.
    console.error(
      error instanceof AppError
        ? error.message
        : `The development pipeline could not start (${error instanceof Error ? error.name : "unknown error"})`,
    );
    return null;
  }
}

try {
  const steps = await prepare(parsed.value.providerFolder);
  if (steps === null) {
    process.exitCode = 2;
  } else {
    const report = await runDevelopmentPipeline(steps, parsed.value, (cycle, counts) =>
      console.log(formatPipelineCycle(cycle, counts)),
    );
    console.log(formatPipelineReport(report));
    process.exitCode = pipelineExitCode(report);
  }
} finally {
  await prisma.$disconnect().catch(() => undefined);
}
