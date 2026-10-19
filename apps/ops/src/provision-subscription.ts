import { parseArgs } from "node:util";
import {
  provisionFromSalesContract,
  type CustomerPlanKey,
  type SalesContractProvisioning,
  type SubscriptionRepository,
} from "@app/domain";
import { parseInstant } from "./instant";

/**
 * The operator command that gives an organization the plan its sales contract
 * names (ADR-0066 Decisions 1 and 2).
 *
 * It runs outside the web app, with the database credentials of whoever runs
 * it, which is the privilege. It reads no customer content, and it records who
 * ran it and why in the audit entry. It writes only a `SALES_ASSISTED`
 * subscription: a self-service one comes from its payment processor.
 */

export const USAGE = [
  "Usage: pnpm --filter @app/ops provision-subscription \\",
  "  --organization <organization id> \\",
  "  --plan standard|premium|enterprise \\",
  "  --starts <contract start, ISO 8601 with a time zone, e.g. 2026-11-01T00:00:00+09:00> \\",
  "  --contract <contract number> \\",
  "  --operator <your name> \\",
  "  --reason <why, e.g. the order it fulfils>",
].join("\n");

const PLAN_KEYS: readonly CustomerPlanKey[] = ["standard", "premium", "enterprise"];

const LIMITS = { organization: 100, contract: 200, operator: 200, reason: 500 } as const;

export type ParsedArguments =
  | { readonly ok: true; readonly value: SalesContractProvisioning }
  | { readonly ok: false; readonly error: string };

function text(values: Record<string, unknown>, name: keyof typeof LIMITS): string | string[] {
  const raw = values[name];
  const value = typeof raw === "string" ? raw.trim() : "";
  if (value === "") return [`--${name} is required`];
  if (value.length > LIMITS[name]) return [`--${name} is longer than ${LIMITS[name]} characters`];
  return value;
}

/** Read and validate the command line. Every option is required; nothing is defaulted. */
export function parseProvisionArguments(argv: readonly string[]): ParsedArguments {
  let values: Record<string, unknown>;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      strict: true,
      allowPositionals: false,
      options: {
        organization: { type: "string" },
        plan: { type: "string" },
        starts: { type: "string" },
        contract: { type: "string" },
        operator: { type: "string" },
        reason: { type: "string" },
      },
    }));
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Unreadable arguments",
    };
  }

  const errors: string[] = [];
  const organizationId = text(values, "organization");
  const contractReference = text(values, "contract");
  const operatorName = text(values, "operator");
  const reason = text(values, "reason");
  for (const field of [organizationId, contractReference, operatorName, reason]) {
    if (Array.isArray(field)) errors.push(...field);
  }

  const plan = typeof values.plan === "string" ? values.plan.trim() : "";
  const planKey = PLAN_KEYS.find((key) => key === plan);
  if (planKey === undefined) errors.push("--plan must be standard, premium or enterprise");

  const startsAt = parseInstant(typeof values.starts === "string" ? values.starts.trim() : "");
  if (startsAt === null) {
    errors.push("--starts must be an ISO 8601 instant with a time zone, e.g. 2026-11-01T00:00:00+09:00");
  }

  if (
    errors.length > 0 ||
    planKey === undefined ||
    startsAt === null ||
    Array.isArray(organizationId) ||
    Array.isArray(contractReference) ||
    Array.isArray(operatorName) ||
    Array.isArray(reason)
  ) {
    return { ok: false, error: errors.join("\n") };
  }
  return {
    ok: true,
    value: { organizationId, planKey, startsAt, contractReference, operator: { name: operatorName, reason } },
  };
}

export interface ProvisionResult {
  /** 0 when the organization has this plan afterwards, 1 when it was refused. */
  readonly exitCode: 0 | 1;
  readonly message: string;
}

const PLAN_NAMES: Record<CustomerPlanKey, string> = {
  standard: "Standard",
  premium: "Premium",
  enterprise: "Enterprise",
};

/** Provision, and say plainly what happened. */
export async function runProvisionSubscription(
  subscriptions: Pick<SubscriptionRepository, "provision" | "findByOrganization">,
  input: SalesContractProvisioning,
): Promise<ProvisionResult> {
  const outcome = await provisionFromSalesContract(subscriptions, input);
  const facts = `${PLAN_NAMES[input.planKey]}, invoice-paid, from ${input.startsAt.toISOString()}, contract ${input.contractReference}`;
  switch (outcome.kind) {
    case "PROVISIONED":
      return {
        exitCode: 0,
        message: `Provisioned organization ${input.organizationId}: ${facts}. Audited with operator ${input.operator.name}.`,
      };
    case "ALREADY_PROVISIONED":
      return {
        exitCode: 0,
        message: `Organization ${input.organizationId} already has exactly this plan (${facts}). Nothing was written.`,
      };
    case "CONFLICT": {
      const existing = await subscriptions.findByOrganization(input.organizationId);
      const held =
        existing === null
          ? "a different subscription"
          : `${PLAN_NAMES[existing.planKey]}, ${existing.channel === "SALES_ASSISTED" ? "invoice-paid" : "card-paid"}, from ${existing.anchorAt.toISOString()}, reference ${existing.commercialReference}`;
      return {
        exitCode: 1,
        message: `Refused: organization ${input.organizationId} already has ${held}. This command does not change a plan. Nothing was written.`,
      };
    }
    case "ORGANIZATION_NOT_FOUND":
      return { exitCode: 1, message: `Refused: there is no organization ${input.organizationId}. Nothing was written.` };
    case "CHANNEL_NOT_OFFERED":
    case "INVALID_SUBSCRIPTION":
      return {
        exitCode: 1,
        message: `Refused as invalid (${outcome.kind}). Nothing was written.`,
      };
  }
}
