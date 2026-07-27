import { NextResponse } from "next/server";
import { buildLiveness } from "@/lib/health";

// Public liveness probe. No authentication, no secrets, always dynamic.
export const dynamic = "force-dynamic";

export function GET(): NextResponse {
  return NextResponse.json(buildLiveness());
}
