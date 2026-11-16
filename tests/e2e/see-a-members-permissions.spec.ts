import { expect, test } from "@playwright/test";
import { signUpOwner } from "./support/owner";

/**
 * A member's permissions in a real browser (AT-11a, ADR-0146): an owner
 * follows the organization's Members link, opens its own permissions from
 * there, and sees what its role gives and what nothing uses yet.
 */
test("an owner opens its own permissions from the members page", async ({ page }) => {
  const organizationName = `Ebisu Lettings ${Date.now()}`;
  await signUpOwner(page, organizationName);
  const card = page.locator(".card", { has: page.getByRole("heading", { name: `${organizationName} (OWNER)` }) });
  await card.getByRole("link", { name: "Members" }).click();
  await expect(page.getByRole("heading", { name: "Members (1)" })).toBeVisible();

  await page.getByRole("link", { name: /^Permissions of / }).click();
  await expect(page.getByRole("heading", { name: "Permissions", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: /\(you\)$/ })).toBeVisible();
  await expect(page.getByText(/apply to every Property of the organization/)).toBeVisible();
  await expect(page.getByRole("listitem").filter({ hasText: "(permission.manage)" })).toHaveText(
    "Change members' roles and permissions (permission.manage): Yes, from their role.",
  );
  await expect(page.getByRole("listitem").filter({ hasText: "(disclosure.none)" })).toHaveText(
    "Make videos without the AI disclosure (disclosure.none): No. Nothing in VTaVision uses it yet.",
  );

  await page.getByRole("link", { name: "Back to members" }).click();
  await expect(page.getByRole("heading", { name: "Members (1)" })).toBeVisible();
});
