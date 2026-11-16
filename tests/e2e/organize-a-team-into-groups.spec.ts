import { expect, test } from "@playwright/test";
import { signUpOwner } from "./support/owner";

/**
 * Groups in a real browser (AT-9a, ADR-0141; AT-9b, ADR-0142; AT-9c,
 * ADR-0143; AT-11c, ADR-0148): an owner follows the organization's Groups
 * link, creates a group, and sees it listed; a second group of the same name
 * is refused and nothing is added. The owner gives the group a permission and
 * takes it back, adds itself to the group and removes itself, then renames the
 * group and deletes it.
 */
test("an owner creates a group, changes its permissions and members, renames it and deletes it", async ({ page }) => {
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

  await expect(page.getByText("It gives its members no permissions.")).toBeVisible();
  await page.locator('summary[aria-label="Give a permission to East office…"]').click();
  await page.getByLabel("Permission to give to East office").selectOption("unit.view");
  await page.getByRole("button", { name: "Give to group East office" }).click();
  await expect(page.getByRole("status")).toHaveText("The group gives that permission now, to each of its members.");
  await expect(page.getByText("It gives each of its members:")).toBeVisible();
  await page.getByRole("button", { name: "Take back from East office the permission: See Units" }).click();
  await expect(page.getByRole("status")).toHaveText(
    "The group no longer gives that permission. A member keeps it only if their role, an individual grant or " +
      "another group gives it.",
  );
  await expect(page.getByText("It gives its members no permissions.")).toBeVisible();

  await page.locator('summary[aria-label="Add member to East office…"]').click();
  // The owner is the organization's only member, so the only one to add.
  await page.getByLabel("Member to add to East office").selectOption({ index: 1 });
  await page.getByRole("button", { name: "Add to group East office" }).click();
  await expect(page.getByRole("status")).toHaveText("The member is in the group.");
  await expect(page.getByText("East office · 1 member", { exact: false })).toBeVisible();

  await page.locator('summary[aria-label$=" from East office…"]').click();
  await page.getByRole("button", { name: /^Remove from group East office: .+$/ }).click();
  await expect(page.getByRole("status")).toHaveText(
    "The member was removed from the group. They stay in the organization with their role.",
  );
  await expect(page.getByText("East office · 0 members")).toBeVisible();

  await page.locator('summary[aria-label="Rename East office…"]').click();
  await page.getByLabel("New name").fill("North office");
  await page.getByRole("button", { name: "Rename group East office" }).click();
  await expect(page.getByRole("status")).toHaveText("The group's name was saved.");
  await expect(page.getByText("North office · 0 members")).toBeVisible();

  await page.locator('summary[aria-label="Delete North office…"]').click();
  await expect(page.getByText("North office will be deleted.", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Delete group North office" }).click();
  await expect(page.getByRole("status")).toHaveText("The group was deleted.");
  await expect(page.getByRole("heading", { name: "Groups (0)" })).toBeVisible();
  await expect(page.getByText("No groups yet.")).toBeVisible();
});
