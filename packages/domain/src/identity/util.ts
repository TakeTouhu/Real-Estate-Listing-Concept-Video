import { normalizeEmailAddress } from "@app/shared";
export function normalizeEmail(email: string): string {
  // One normalization for what the product stores and what the address rule judges (ADR-0167).
  return normalizeEmailAddress(email);
}
