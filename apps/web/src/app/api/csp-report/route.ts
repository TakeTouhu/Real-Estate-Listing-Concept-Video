import { answerCspReport } from "@/lib/csp-report";
import { getServerEnv } from "@/lib/env";
import { appErrorToResponse } from "@/lib/http";

// Browsers' page policy violation reports (ADR-0189). Unauthenticated by nature: it reads no cookie,
// session, database or limiter, and keeps only categories of reports from `APP_BASE_URL`'s own pages.
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  try {
    const status = await answerCspReport(request, () => getServerEnv().APP_BASE_URL);
    return new Response(null, { status });
  } catch (error) {
    return appErrorToResponse(error, "POST /api/csp-report");
  }
}
