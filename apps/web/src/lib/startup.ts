import type { ServerEnv } from "@app/shared";
import { chooseWebAdapters, type WebAdapterChoice } from "./adapters";
import { getServerEnv } from "./env";

/**
 * The adapters that refuse production when built (ADR-0008, ADR-0085,
 * ADR-0126): a production start that chose one would fail at the first request
 * needing it, so it is refused at start instead (RD-2, ADR-0151). The offline
 * analysis and prompt moderation are not among them (ADR-0150 Decision 3).
 */
const DEVELOPMENT_ADAPTERS = {
  storage: ["shared-folder", "memory"],
  malwareScanner: ["passthrough"],
  email: ["outbox"],
} as const satisfies { readonly [P in keyof WebAdapterChoice]?: readonly WebAdapterChoice[P][] };

const PORT_NAMES = {
  storage: "object storage",
  malwareScanner: "malware scanning",
  email: "email",
} as const satisfies Record<keyof typeof DEVELOPMENT_ADAPTERS, string>;

/**
 * The settings a production start needs beyond what the environment schema
 * requires everywhere: the database, the key that seals MFA secrets (ADR-0065;
 * the product owner's default for production, 2026-11-16), and the address
 * every emailed link starts with (ADR-0129). The worker shares the schema and
 * needs none of them, so the schema keeps them optional.
 */
const PRODUCTION_SETTINGS = ["DATABASE_URL", "MFA_SECRET_KEY", "APP_BASE_URL"] as const;

/**
 * Why a production start of the web app is refused, one line each, or none
 * when it may start. Names ports, adapters and settings, never a value.
 */
export function productionStartProblems(env: ServerEnv): readonly string[] {
  const choice = chooseWebAdapters(env);
  const problems: string[] = [];
  for (const port of Object.keys(DEVELOPMENT_ADAPTERS) as (keyof typeof DEVELOPMENT_ADAPTERS)[]) {
    const adapters: readonly string[] = DEVELOPMENT_ADAPTERS[port];
    if (adapters.includes(choice[port])) {
      problems.push(`${PORT_NAMES[port]}: the development adapter "${choice[port]}" refuses production`);
    }
  }
  if (choice.email === "none") {
    problems.push("email: none is configured, so sign-up cannot send its verification link");
  }
  for (const name of PRODUCTION_SETTINGS) {
    if (env[name] === undefined) problems.push(`${name} is not set`);
  }
  return problems;
}

/** How a start that is refused is reported and ended. */
export interface WebStart {
  readonly report: (message: string) => void;
  readonly exit: (code: number) => void;
}

const processStart: WebStart = {
  report: (message) => console.error(message),
  exit: (code) => process.exit(code),
};

/**
 * Checked once as the web app's server starts (`src/instrumentation.ts`). A
 * production start with an invalid environment, a development adapter or a
 * missing setting reports why and ends the process: left running, Next.js
 * answers every request with an error instead. Nothing is checked outside
 * production, where `next dev` and the browser test choose development
 * adapters on purpose.
 */
export function checkWebStart(loadEnv: () => ServerEnv = getServerEnv, start: WebStart = processStart): void {
  if (process.env.NODE_ENV !== "production") return;
  let problems: readonly string[];
  try {
    problems = productionStartProblems(loadEnv());
  } catch (error) {
    // The schema's message lists each variable and what is wrong, never a value.
    const why = error instanceof Error ? error.message : "Its environment could not be read.";
    start.report(`The web app cannot start in production. ${why}`);
    start.exit(1);
    return;
  }
  if (problems.length === 0) return;
  start.report(`The web app cannot start in production:\n${problems.map((problem) => `  - ${problem}`).join("\n")}`);
  start.exit(1);
}
