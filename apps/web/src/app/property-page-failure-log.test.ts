import { afterEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@app/shared";

/**
 * A Property page tries each of the user's organizations (ADR-0177 Decision
 * 4): an organization that answers `NOT_FOUND` logs nothing, and one whose
 * read fails for a reason the app does not know logs one line, keyed by the
 * page, with no organization id or message.
 */
const ORGANIZATIONS = ["org-not-found-1", "org-failing-2", "org-not-found-3"];

vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Error(`redirect ${path}`);
  },
}));
vi.mock("@/lib/auth", () => ({ getCurrentUser: () => Promise.resolve({ user: { id: "user-1" } }) }));
vi.mock("@/lib/identity", () => ({
  getIdentityServices: () => ({
    organizations: { listForUser: () => Promise.resolve(ORGANIZATIONS.map((id) => ({ organization: { id } }))) },
  }),
}));
vi.mock("@/lib/property", () => ({
  getPropertyServices: () => ({
    properties: {
      get: (_user: string, organizationId: string) =>
        Promise.reject(
          organizationId === "org-failing-2"
            ? new AppError("INTERNAL_ERROR", "row CANARY could not be read")
            : new AppError("NOT_FOUND", "Property not found"),
        ),
    },
  }),
}));

const { default: PropertyDetailPage } = await import("./properties/[propertyId]/page");

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a Property page's failure line", () => {
  it("logs one line for the organization that failed, and none for those that answered NOT_FOUND", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: string) => void lines.push(line));
    const params = Promise.resolve({ propertyId: "property-1" });
    await expect(PropertyDetailPage({ params })).rejects.toThrow("redirect /?error=Property%20not%20found");
    const read = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(read.map(({ component, route, errorName, code }) => [component, route, errorName, code])).toEqual([
      ["request", "GET /properties/[propertyId]", "AppError", "INTERNAL_ERROR"],
    ]);
    expect(lines.join("\n")).not.toMatch(/CANARY|org-|user-1|property-1/);
  });
});
