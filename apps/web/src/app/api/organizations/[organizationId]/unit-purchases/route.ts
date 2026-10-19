import { NextResponse } from "next/server";
import type { UnitPurchaseOutcome } from "@app/domain";
import { AppError } from "@app/shared";
import { getCurrentUser } from "@/lib/auth";
import { appErrorToResponse, redirectWithError } from "@/lib/http";
import { isSameOriginPost } from "@/lib/same-origin";
import { NOT_USABLE, failureMessage, readUnitPurchaseForm, refusalMessage } from "@/lib/unit-purchase-form";
import { getUnitPurchaseService } from "@/lib/unit-purchases";

export const dynamic = "force-dynamic";

/**
 * Approve one additional Unit package, from the confirmation step (ADR-0068).
 * Fields: `quality`, `units`, `priceYenExTax`, `periodEndsAt` and
 * `idempotencyKey`, as the step showed them. Only a holder of `billing.manage`
 * may; the purchase service decides, and audits every refusal of a member.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ organizationId: string }> },
): Promise<NextResponse> {
  if (!isSameOriginPost(request)) {
    return appErrorToResponse(new AppError("FORBIDDEN", "A purchase must be approved from this site"));
  }
  const current = await getCurrentUser();
  if (!current) return NextResponse.redirect(new URL("/login", request.url), { status: 303 });
  const { organizationId } = await context.params;
  const unitsPage = `/organizations/${encodeURIComponent(organizationId)}/units`;
  const buyPage = `${unitsPage}/buy`;

  const input = readUnitPurchaseForm(organizationId, await request.formData());
  if (input === null) return redirectWithError(request.url, buyPage, NOT_USABLE);

  let outcome: UnitPurchaseOutcome;
  try {
    outcome = await getUnitPurchaseService().approve(current.user.id, input);
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    return redirectWithError(request.url, buyPage, failureMessage(error));
  }
  if (outcome.kind === "REFUSED") return redirectWithError(request.url, buyPage, refusalMessage(outcome.reason));

  // A replay of the same approval lands where the approval did: it bought once.
  const done = new URL(unitsPage, request.url);
  done.searchParams.set("purchased", "1");
  return NextResponse.redirect(done, { status: 303 });
}
