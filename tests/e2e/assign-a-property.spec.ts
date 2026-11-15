import { expect, test } from "@playwright/test";
import { signUpOwner } from "./support/owner";

/**
 * A Property's assignment in a real browser (AT-10a, ADR-0144): an owner
 * creates a group and a Property, makes itself responsible for the Property
 * and puts it in the group from the Property page, then deletes the group,
 * after which the Property is ungrouped and still its own (ADR-0062). And
 * (AT-10b, ADR-0145) an owner chooses both when creating a Property.
 */
test("an owner assigns a Property to a group and to itself, and deleting the group ungroups it", async ({ page }) => {
  const organizationName = `Meguro Estates ${Date.now()}`;
  await signUpOwner(page, organizationName);
  const card = page.locator(".card", { has: page.getByRole("heading", { name: `${organizationName} (OWNER)` }) });
  await card.getByRole("link", { name: "Groups" }).click();
  await page.getByLabel("Group name").fill("East office");
  await page.getByRole("button", { name: "Create group" }).click();
  await expect(page.getByRole("status")).toHaveText("The group was created.");

  await page.goto("/");
  await page.getByText("Add a property").click();
  await page.getByLabel("Property name").fill("Meguro Garden House");
  await page.getByLabel("I own or have licensed the photos I will upload for this property.").check();
  await page.getByRole("button", { name: "Create property" }).click();
  await expect(page.getByRole("heading", { name: "Meguro Garden House" })).toBeVisible();
  const propertyPage = page.url();
  await expect(page.getByText("Responsible user: None")).toBeVisible();
  await expect(page.getByText("Group: None")).toBeVisible();

  await page.getByText("Change assignment…").click();
  // The owner is the organization's only member, so the only one to choose.
  await page.getByLabel("Responsible user").selectOption({ index: 1 });
  await page.getByLabel("Group").selectOption({ label: "East office" });
  await page.getByRole("button", { name: "Save assignment" }).click();
  await expect(page.getByRole("status")).toHaveText("The responsible user and group were saved.");
  await expect(page.getByText(/^Responsible user: .+ · Owner$/)).toBeVisible();
  await expect(page.getByText("Group: East office")).toBeVisible();

  await page.goto("/");
  await card.getByRole("link", { name: "Groups" }).click();
  await page.locator('summary[aria-label="Delete East office…"]').click();
  await page.getByRole("button", { name: "Delete group East office" }).click();
  await expect(page.getByRole("status")).toHaveText("The group was deleted.");

  await page.goto(propertyPage);
  await expect(page.getByText("Group: None")).toBeVisible();
  await expect(page.getByText(/^Responsible user: .+ · Owner$/)).toBeVisible();
});

test("an owner chooses itself and a group when creating a Property", async ({ page }) => {
  const organizationName = `Nakano Estates ${Date.now()}`;
  await signUpOwner(page, organizationName);
  const card = page.locator(".card", { has: page.getByRole("heading", { name: `${organizationName} (OWNER)` }) });
  await card.getByRole("link", { name: "Groups" }).click();
  await page.getByLabel("Group name").fill("West office");
  await page.getByRole("button", { name: "Create group" }).click();
  await expect(page.getByRole("status")).toHaveText("The group was created.");

  await page.goto("/");
  await page.getByText("Add a property").click();
  await page.getByLabel("Property name").fill("Nakano Court");
  // The owner is the organization's only member, so the only one to choose.
  await page.getByLabel("Responsible user").selectOption({ index: 1 });
  await page.getByLabel("Group").selectOption({ label: "West office" });
  await page.getByLabel("I own or have licensed the photos I will upload for this property.").check();
  await page.getByRole("button", { name: "Create property" }).click();
  await expect(page.getByRole("heading", { name: "Nakano Court" })).toBeVisible();
  await expect(page.getByText(/^Responsible user: .+ · Owner$/)).toBeVisible();
  await expect(page.getByText("Group: West office")).toBeVisible();
});
