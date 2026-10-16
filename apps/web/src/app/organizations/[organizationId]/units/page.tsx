import { redirect } from "next/navigation";
import type { UnitsOverview } from "@app/domain";
import { AppError } from "@app/shared";
import { getCurrentUser } from "@/lib/auth";
import { getIdentityServices } from "@/lib/identity";
import { getUnitsOverviewService } from "@/lib/units";
import { CHANNEL_NAMES, PLAN_NAMES, QUALITY_NAMES, formatJst, formatYenExTax } from "@/lib/units-view";

export const dynamic = "force-dynamic";

/**
 * An organization's plan and what it has left to generate with this period
 * (ADR-0066 Decision 3). A holder of `unit.view` sees the Units; how the plan is
 * paid and its price need `billing.view` too. Viewing writes nothing.
 */
export default async function UnitsPage({ params }: { params: Promise<{ organizationId: string }> }) {
  const current = await getCurrentUser();
  if (!current) redirect("/login");
  const { organizationId } = await params;

  let overview: UnitsOverview;
  try {
    overview = await getUnitsOverviewService().overview(current.user.id, organizationId);
  } catch (error) {
    if (!(error instanceof AppError) || error.code !== "FORBIDDEN") throw error;
    return (
      <section>
        <h1>Units and plan</h1>
        <p className="status-bad" role="alert">
          You cannot view this organization&apos;s Units.
        </p>
        <p>
          <a href="/">Back to organizations</a>
        </p>
      </section>
    );
  }

  const memberships = await getIdentityServices().organizations.listForUser(current.user.id);
  const name = memberships.find(({ organization }) => organization.id === organizationId)?.organization.name;

  return (
    <section>
      <h1>Units and plan</h1>
      {name ? <p className="muted">{name}</p> : null}
      <Overview overview={overview} />
      <p>
        <a href="/">Back to organizations</a>
      </p>
    </section>
  );
}

function Billing({ overview }: { overview: Exclude<UnitsOverview, { kind: "NO_PLAN" }> }) {
  if (overview.billing === null) return null;
  return (
    <p>
      {CHANNEL_NAMES[overview.billing.channel]} · {formatYenExTax(overview.billing.monthlyPriceYenExTax)} per month
    </p>
  );
}

function Overview({ overview }: { overview: UnitsOverview }) {
  if (overview.kind === "NO_PLAN") {
    return (
      <div className="card">
        <p>This organization has no plan yet. VTaVision sets it up when your contract starts.</p>
      </div>
    );
  }

  const plan = PLAN_NAMES[overview.planKey];
  if (overview.kind === "NOT_STARTED") {
    return (
      <div className="card">
        <h2>{plan} plan</h2>
        <Billing overview={overview} />
        <p>Your plan starts on {formatJst(overview.startsAt)}. Its Units are available from then.</p>
      </div>
    );
  }

  const { baseUnits, highQuality } = overview;
  return (
    <>
      <div className="card">
        <h2>{plan} plan</h2>
        <Billing overview={overview} />
        <p>
          This period runs from {formatJst(overview.period.startsAt)} to {formatJst(overview.period.endsAt)}. Units
          left at its end expire, including additional Units: nothing carries over.
        </p>
      </div>

      <div className="card">
        <h2>Base Units</h2>
        <p>
          <strong>{baseUnits.remaining}</strong> of {baseUnits.included} left. They fund Normal or HQ videos.
        </p>
        <p>
          Up to <strong>{highQuality.fundableFromBase}</strong> of them can still fund HQ (HQ allowance:{" "}
          {highQuality.includedCeiling} included, {highQuality.ceilingRemaining} unused).
        </p>
      </div>

      <div className="card">
        <h2>Additional Units</h2>
        {overview.addOnBlocks.length === 0 ? (
          <p className="muted">None bought this period.</p>
        ) : (
          <>
            <p>
              Normal: <strong>{overview.normalAddOnRemaining}</strong> left · HQ:{" "}
              <strong>{overview.highQualityAddOnRemaining}</strong> left
            </p>
            <ul>
              {overview.addOnBlocks.map((block, index) => (
                <li key={index}>
                  {QUALITY_NAMES[block.quality]}: {block.remainingUnits} left · bought {formatJst(block.purchasedAt)}
                </li>
              ))}
            </ul>
          </>
        )}
        <p className="muted">
          Normal additional Units fund only Normal videos, and HQ additional Units only HQ videos. One is never used
          for the other.
        </p>
        {overview.highQualityAddOnAvailable ? null : (
          <p className="muted">The {plan} plan does not sell HQ additional Units.</p>
        )}
      </div>
    </>
  );
}
