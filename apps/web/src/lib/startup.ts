import type { ServerEnv } from "@app/shared";
import { chooseWebAdapters, type WebAdapterChoice } from "./adapter-choice";
import { getServerEnv } from "./env";

/** The adapters a production start may choose, for every port the web app chooses one for. */
export type ProductionAdapters = { readonly [P in keyof WebAdapterChoice]: readonly WebAdapterChoice[P][] };

/**
 * What production may run with (RD-2a, ADR-0151). Every port is listed, so an
 * adapter or a port added to the choice is refused at a production start until
 * it is allowed here.
 */
export const PRODUCTION_ADAPTERS: ProductionAdapters = {
  // Google's own Cloud Storage (ADR-0159). An emulator, the shared folder and
  // memory refuse production when built (ADR-0008, ADR-0085).
  storage: ["gcs"],
  // A ClamAV daemon (ADR-0164). The test scanner refuses production when
  // built (ADR-0008).
  malwareScanner: ["clamav"],
  // The SMTP sender (ADR-0168). The outbox refuses production when built
  // (ADR-0126).
  email: ["smtp"],
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
 * every emailed link starts with (ADR-0129). The schema keeps each optional: a
 * build and a test run are given none of them, and the worker has no use for
 * the key or the address.
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

/**
 * Why this start of the web app is refused, one line each, or none when it
 * is not a production start or may go on.
 *
 * A start is a production one when the ambient `NODE_ENV`, which a production
 * build fixes at `production`, or the configured one says so: neither can
 * vouch for the other (ADR-0150 Decision 2). One that only one of them calls
 * production is refused for that too. Any other start is left alone, as
 * `next dev` and the browser test choose development adapters on purpose.
 *
 * The start check ends a start on it. Readiness reads it too, and so tells of
 * a start the check did not see (ADR-0154).
 */
export function webStartProblems(env: ServerEnv, allowed: ProductionAdapters = PRODUCTION_ADAPTERS): readonly string[] {
  const ambient = process.env.NODE_ENV === "production";
  const configured = env.NODE_ENV === "production";
  if (!ambient && !configured) return [];
  const problems = [...productionStartProblems(env, allowed)];
  // The schema's production rules and the session cookie's `Secure` follow the configured value, and
  // the build follows the ambient one: where the two differ, production's rules hold only in part.
  if (ambient !== configured) {
    problems.unshift(
      ambient
        ? 'NODE_ENV is not "production", but this is a production build'
        : 'NODE_ENV is "production", but this is not a production build',
    );
  }
  return problems;
}

/** How a start check reads its environment, and how a refused start is reported and ended. */
export interface WebStart {
  readonly loadEnv: () => ServerEnv;
  readonly report: (message: string) => void;
  readonly exit: (code: number) => void;
}

const processStart: WebStart = {
  loadEnv: getServerEnv,
  report: (message) => console.error(message),
  exit: (code) => process.exit(code),
};

const REFUSED = "The web app cannot start in production";

/**
 * Checked once as the web app's server starts (`src/instrumentation.ts`). A
 * production start with an invalid environment, an adapter production may not
 * use or a missing setting reports why and ends the process: left running,
 * Next.js answers every request with an error instead. What makes a start a
 * production one, and what it is refused for, is `webStartProblems`.
 *
 * Both arguments are for tests. The start hook gives neither, so the
 * process's own start is judged by `PRODUCTION_ADAPTERS`.
 */
export function checkWebStart(start: WebStart = processStart, allowed: ProductionAdapters = PRODUCTION_ADAPTERS): void {
  let env: ServerEnv;
  try {
    env = start.loadEnv();
  } catch (error) {
    // No configured value can be read, so the ambient one decides alone.
    // Elsewhere an invalid environment is reported where it is first read, as before.
    if (process.env.NODE_ENV !== "production") return;
    // The schema's message names the invalid variables and what is wrong with each.
    const why = error instanceof Error ? error.message : "Its environment could not be read.";
    start.report(`${REFUSED}. ${why}`);
    start.exit(1);
    return;
  }
  const problems = webStartProblems(env, allowed);
  if (problems.length === 0) return;
  start.report(`${REFUSED}:\n${problems.map((problem) => `  - ${problem}`).join("\n")}`);
  start.exit(1);
}
