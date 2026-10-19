import { redirect } from "next/navigation";
import type { AddOnPackageOffer, UnitPurchaseOffers } from "@app/domain";
import { AppError } from "@app/shared";
import { getCurrentUser } from "@/lib/auth";
import { getUnitPurchaseService } from "@/lib/unit-purchases";
import { PLAN_NAMES, QUALITY_NAMES, formatJst, formatYenExTax, packageName } from "@/lib/units-view";

export const dynamic = "force-dynamic";

/**
 * Buying an additional Unit package (ADR-0068): the packages the plan sells, and
 * the confirmation step for one of them (`?package=NORMAL` or `HIGH_QUALITY`).
 * Only a holder of `billing.manage` sees either. Viewing writes nothing.
 */
export default async function BuyUnitsPage({
  params,
  searchParams,
}: {
  params: Promise<{ organizationId: string }>;
  searchParams: Promise<{ package?: string; error?: string }>;
}) {
  const current = await getCurrentUser();
  if (!current) redirect("/login");
  const { organizationId } = await params;
  const query = await searchParams;
  const unitsPage = `/organizations/${encodeURIComponent(organizationId)}/units`;

  let offers: UnitPurchaseOffers;
  try {
    offers = await getUnitPurchaseService().offers(current.user.id, organizationId);
  } catch (error) {
    if (!(error instanceof AppError) || error.code !== "FORBIDDEN") throw error;
    return (
      <section>
        <h1>Buy additional Units</h1>
        <p className="status-bad" role="alert">
          You cannot buy Units for this organization.
        </p>
        <p>
          <a href="/">Back to organizations</a>
        </p>
      </section>
    );
  }

  const chosen =
    offers.kind === "AVAILABLE" && query.package !== undefined
      ? offers.packages.find((offer) => offer.quality === query.package)
      : undefined;
  const notSold = offers.kind === "AVAILABLE" && query.package !== undefined && chosen === undefined;

  return (
    <section>
      <h1>{chosen ? "Review your purchase" : "Buy additional Units"}</h1>
      {query.error ? (
        <p className="status-bad" role="alert">
          {query.error}
        </p>
      ) : null}
      {notSold ? (
        <p className="status-bad" role="alert">
          Your plan does not sell that package.
        </p>
      ) : null}
      {offers.kind === "AVAILABLE" && chosen ? (
        <Confirmation organizationId={organizationId} offers={offers} offer={chosen} />
      ) : (
        <Offers offers={offers} />
      )}
      <p>
        <a href={unitsPage}>Back to Units and plan</a>
      </p>
    </section>
  );
}

function Offers({ offers }: { offers: UnitPurchaseOffers }) {
  switch (offers.kind) {
    case "NO_PLAN":
      return <p>This organization has no plan yet. VTaVision sets it up when your contract starts.</p>;
    case "NOT_STARTED":
      return <p>Your plan starts on {formatJst(offers.startsAt)}. Additional Units can be bought from then.</p>;
    case "CARD_PAYMENT_NOT_AVAILABLE":
      return <p>Your plan is paid by card, and additional Units cannot be bought by card yet.</p>;
    case "THROUGH_SALES":
      return (
        <>
          <PackageList packages={offers.packages} />
          <p>
            On the {PLAN_NAMES[offers.planKey]} plan, additional Units are bought through your VTaVision
            representative. Contact them to add a package to your contract.
          </p>
        </>
      );
    case "AVAILABLE":
      return (
        <>
          <p>
            One package per purchase. Units bought now expire at the end of this period,{" "}
            {formatJst(offers.periodEndsAt)}, and nothing carries over.
          </p>
          <PackageList packages={offers.packages} review />
          {offers.packages.some((offer) => offer.quality === "HIGH_QUALITY") ? null : (
            <p className="muted">The {PLAN_NAMES[offers.planKey]} plan does not sell HQ additional Units.</p>
          )}
        </>
      );
  }
}

function PackageList({ packages, review = false }: { packages: readonly AddOnPackageOffer[]; review?: boolean }) {
  return (
    <ul>
      {packages.map((offer) => (
        <li key={offer.quality}>
          {packageName(offer)} · {formatYenExTax(offer.priceYenExTax)}
          {review ? (
            <>
              {" "}
              · <a href={`?package=${offer.quality}`}>Review purchase</a>
            </>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function Confirmation({
  organizationId,
  offers,
  offer,
}: {
  organizationId: string;
  offers: Extract<UnitPurchaseOffers, { kind: "AVAILABLE" }>;
  offer: AddOnPackageOffer;
}) {
  const quality = QUALITY_NAMES[offer.quality];
  const other = QUALITY_NAMES[offer.quality === "NORMAL" ? "HIGH_QUALITY" : "NORMAL"];
  // A new key for every confirmation shown: submitting this one twice buys once,
  // and buying again means reviewing again.
  const idempotencyKey = crypto.randomUUID();
  return (
    <div className="card">
      <h2>{packageName(offer)}</h2>
      <p>
        {quality} only: these Units fund {quality} videos and never {other} videos.
      </p>
      <p>Price: {formatYenExTax(offer.priceYenExTax)}. Consumption tax is added on the invoice.</p>
      <p>
        They expire at the end of this period, {formatJst(offers.periodEndsAt)}. Units left unused then do not carry
        over and are not refunded.
      </p>
      <p>
        The Units are ready to use as soon as you approve. VTaVision invoices this purchase under your contract{" "}
        {offers.contractReference}.
      </p>
      <form method="post" action={`/api/organizations/${encodeURIComponent(organizationId)}/unit-purchases`}>
        <input type="hidden" name="quality" value={offer.quality} />
        <input type="hidden" name="units" value={String(offer.units)} />
        <input type="hidden" name="priceYenExTax" value={String(offer.priceYenExTax)} />
        <input type="hidden" name="periodEndsAt" value={offers.periodEndsAt.toISOString()} />
        <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
        <button type="submit">Approve purchase for {formatYenExTax(offer.priceYenExTax)}</button>
      </form>
      <p>
        <a href="?">Choose another package</a>
      </p>
    </div>
  );
}
