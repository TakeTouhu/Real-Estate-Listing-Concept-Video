import type { ServerEnv } from "@app/shared";
import { chooseWebAdapters, type WebAdapterChoice } from "./adapters";
import { getServerEnv } from "./env";

/** The adapters a production start may choose, for every port the web app has. */
export type ProductionAdapters = { readonly [P in keyof WebAdapterChoice]: readonly WebAdapterChoice[P][] };

/**
 * What production may run with (RD-2a, ADR-0151). Every port is listed, so an
 * adapter or a port added to the choice is refused at a production start until
 * it is allowed here.
 */
export const PRODUCTION_ADAPTERS: ProductionAdapters = {
  // Each has development adapters only, which refuse production when built
  // (ADR-0008, ADR-0085, ADR-0126). RD-3, RD-5 and RD-6 add production ones.
  storage: [],
  malwareScanner: [],
  email: [],
  // Not refused in production: no decision keeps them out (ADR-0150 Decision 3).
  imageAnalysis: ["deterministic"],
  promptModeration: ["offline"],
};

/** Each port by name, in the order its problem is reported. */
const PORT_NAMES: Readonly<Record<keyof WebAdapterChoice, string>> = {
  storage: "object storage",
  malwareScanner: "malware scanning",
  email: "email",
  imageAnalysis: "image analysis",
  promptModeration: "prompt moderation",
};

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
 * when it may start. Names ports, adapters and settings; a setting is only
 * asked whether it is set, so no line carries one's value.
 */
export function productionStartProblems(
  env: ServerEnv,
  allowed: ProductionAdapters = PRODUCTION_ADAPTERS,
): readonly string[] {
  const choice = chooseWebAdapters(env);
  const problems: string[] = [];
  for (const port of Object.keys(PORT_NAMES) as (keyof WebAdapterChoice)[]) {
    const adapters: readonly string[] = allowed[port];
    if (adapters.includes(choice[port])) continue;
    problems.push(
      port === "email" && choice.email === "none"
        ? "email: none is configured, so sign-up cannot send its verification link"
        : `${PORT_NAMES[port]}: "${choice[port]}" is not a production adapter`,
    );
  }
  for (const name of PRODUCTION_SETTINGS) {
    if (env[name] === undefined) problems.push(`${name} is not set`);
  }
  return problems;
}

/** What a start check reads, and how a refused start is reported and ended. */
export interface WebStart {
  readonly loadEnv: () => ServerEnv;
  readonly allowed: ProductionAdapters;
  readonly report: (message: string) => void;
  readonly exit: (code: number) => void;
}

const processStart: WebStart = {
  loadEnv: getServerEnv,
  allowed: PRODUCTION_ADAPTERS,
  report: (message) => console.error(message),
  exit: (code) => process.exit(code),
};

const REFUSED = "The web app cannot start in production";

/**
 * Checked once as the web app's server starts (`src/instrumentation.ts`). A
 * production start with an invalid environment, an adapter production may not
 * use or a missing setting reports why and ends the process: left running,
 * Next.js answers every request with an error instead.
 *
 * A start is a production one when the ambient `NODE_ENV` or the configured
 * one says so: neither can vouch for the other (ADR-0150 Decision 2). Any
 * other start is left alone, as `next dev` and the browser test choose
 * development adapters on purpose.
 */
export function checkWebStart(start: WebStart = processStart): void {
  const ambient = process.env.NODE_ENV === "production";
  let env: ServerEnv;
  try {
    env = start.loadEnv();
  } catch (error) {
    // No configured value can be read, so the ambient one decides alone.
    // Elsewhere an invalid environment is reported where it is first read, as before.
    if (!ambient) return;
    // The schema's message names the invalid variables and what is wrong with each.
    const why = error instanceof Error ? error.message : "Its environment could not be read.";
    start.report(`${REFUSED}. ${why}`);
    start.exit(1);
    return;
  }
  if (!ambient && env.NODE_ENV !== "production") return;
  const problems = productionStartProblems(env, start.allowed);
  if (problems.length === 0) return;
  start.report(`${REFUSED}:\n${problems.map((problem) => `  - ${problem}`).join("\n")}`);
  start.exit(1);
}
