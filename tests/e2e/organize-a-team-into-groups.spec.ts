import { expect, test } from "@playwright/test";
import { signUpOwner } from "./support/owner";

/**
 * Groups in a real browser (AT-9a, ADR-0141): an owner follows the
 * organization's Groups link, creates a group, and sees it listed; a second
 * group of the same name is refused and nothing is added.
 */
test("an owner creates a group from the groups page", async ({ page }) => {
  const organizationName = `Shinjuku Homes ${Date.now()}`;
  await signUpOwner(page, organizationName);
  const card = page.locator(".card", { has: page.getByRole("heading", { name: `${organizationName} (OWNER)` }) });
  await card.getByRole("link", { name: "Groups" }).click();

  await expect(page.getByRole("heading", { name: "Groups", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Groups (0)" })).toBeVisible();
  await page.getByLabel("Group name").fill("  East office ");
  await page.getByRole("button", { name: "Create group" }).click();
  await expect(page.getByRole("status")).toHaveText("The group was created.");
  await expect(page.getByRole("heading", { name: "Groups (1)" })).toBeVisible();
  await expect(page.getByText("East office · 0 members")).toBeVisible();

  await page.getByLabel("Group name").fill("East office");
  await page.getByRole("button", { name: "Create group" }).click();
  await expect(page.getByRole("alert")).toHaveText("Another group of this organization already has that name.");
  await expect(page.getByRole("heading", { name: "Groups (1)" })).toBeVisible();
});
