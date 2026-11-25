import { basename } from "node:path";
import type { Browser, Locator, Page } from "@playwright/test";
import { expect, test } from "./support/csp-guard";
import { E2E_BASE_URL } from "./support/environment";
import { hydrated, pageAlert } from "./support/hydration";
import { invitationLink, verificationLink } from "./support/outbox";
import { newEmail, newPassword, provisionPremiumPlan, signUpOwner } from "./support/owner";
import { makePhotos } from "./support/photos";

/**
 * What invited members reach, in a real browser (AT-12, ADR-0149; ADR-0052
 * Decision 10, ADR-0064): an owner creates two Properties and a group, and
 * invites a Creator and a Manager, who each join from the emailed link with a
 * new, verified account. Neither reaches a Property yet. The owner makes the
 * Creator responsible for one Property, adds the Manager to the group and
 * creates a third Property in it. The Creator then sees only its own
 * Property, and the Manager only the group's; a Property a member does not
 * reach is not found from its address either. The owner sees all three. The
 * Creator works on its Property: it uploads the Property's photos.
 */

/** The owner invites `email` with `role` from the members page (ADR-0136). */
async function invite(page: Page, organizationId: string, email: string, role: string): Promise<void> {
  await page.goto(`/organizations/${organizationId}/members`);
  await page.getByLabel("Email address").fill(email);
  await page.getByLabel("Role").selectOption(role);
  await page.getByRole("button", { name: "Send invitation" }).click();
  await expect(page.getByRole("status")).toContainText("The invitation was sent.");
}

/**
 * The invited person, in their own browser, opens the emailed link, creates
 * an account with the invited address, verifies it and accepts (ADR-0138).
 */
async function join(browser: Browser, email: string, name: string, heading: string): Promise<Page> {
  const member = await browser.newPage({ baseURL: E2E_BASE_URL });
  await member.goto(await invitationLink(email));
  await member.getByRole("button", { name: "Continue" }).click();
  await expect(member).toHaveURL(/\/login$/);
  const register = member.locator("form", { has: member.getByRole("heading", { name: "Create account" }) });
  await register.getByLabel("Name").fill(name);
  await register.getByLabel("Email").fill(email);
  await register.getByLabel("Password (min 10 characters)").fill(newPassword());
  await register.getByRole("button", { name: "Create account" }).click();
  await expect(member.getByRole("heading", { name: "Verify your email address" })).toBeVisible();
  await member.goto(await verificationLink(email));
  await member.getByRole("button", { name: "Verify email address" }).click();
  await expect(member.getByRole("heading", { name: "Email address verified" })).toBeVisible();
  await member.getByRole("link", { name: "Continue" }).click();
  await member.getByRole("button", { name: "Accept invitation" }).click();
  await expect(member.getByRole("heading", { name: heading })).toBeVisible();
  return member;
}

/**
 * The owner creates a Property from the home page, with a group if one is
 * named, and returns its page's address.
 */
async function createProperty(page: Page, name: string, group?: string): Promise<string> {
  await page.goto("/");
  await page.getByText("Add a property").click();
  await page.getByLabel("Property name").fill(name);
  if (group !== undefined) await page.getByLabel("Group").selectOption({ label: group });
  await page.getByLabel("I own or have licensed the photos I will upload for this property.").check();
  await page.getByRole("button", { name: "Create property" }).click();
  await expect(page.getByRole("heading", { name })).toBeVisible();
  return page.url();
}

/** The Properties the home page lists. */
function listed(page: Page): Locator {
  return page.locator('.card li a[href^="/properties/"]');
}

test("invited members see only the Properties assigned to them or to their group", async ({
  page,
  browser,
}, testInfo) => {
  const organizationName = `Ebisu Homes ${Date.now()}`;
  const owner = await signUpOwner(page, organizationName);
  // Inviting needs a seat, and seats come with a plan (ADR-0135).
  await provisionPremiumPlan(owner.organizationId);
  const ebisu = await createProperty(page, "Ebisu House");
  const shibuya = await createProperty(page, "Shibuya Flat");
  await page.goto(`/organizations/${owner.organizationId}/groups`);
  await page.getByLabel("Group name").fill("East office");
  await page.getByRole("button", { name: "Create group" }).click();
  await expect(page.getByRole("status")).toHaveText("The group was created.");

  const creatorEmail = newEmail("creator");
  const managerEmail = newEmail("manager");
  await invite(page, owner.organizationId, creatorEmail, "CREATOR");
  await invite(page, owner.organizationId, managerEmail, "MANAGER");
  const creator = await join(browser, creatorEmail, "Sora Creator", `${organizationName} (CREATOR)`);
  const manager = await join(browser, managerEmail, "Ren Manager", `${organizationName} (MANAGER)`);
  // Nothing is assigned to either of them yet.
  for (const member of [creator, manager]) {
    await expect(member.getByText("No properties yet.")).toBeVisible();
    await expect(listed(member)).toHaveCount(0);
  }

  // The owner makes the Creator responsible for Shibuya Flat (ADR-0144).
  await page.goto(shibuya);
  await page.getByText("Change assignment…").click();
  await page.getByLabel("Responsible user").selectOption({ label: `Sora Creator · ${creatorEmail} · Creator` });
  await page.getByRole("button", { name: "Save assignment" }).click();
  await expect(page.getByRole("status")).toHaveText("The responsible user and group were saved.");

  // The owner adds the Manager to East office (ADR-0143) and creates a Property in it (ADR-0145).
  await page.goto(`/organizations/${owner.organizationId}/groups`);
  await page.locator('summary[aria-label="Add member to East office…"]').click();
  const managerLine = `Ren Manager · ${managerEmail} · Manager`;
  await page.getByLabel("Member to add to East office").selectOption({ label: managerLine });
  await page.getByRole("button", { name: "Add to group East office" }).click();
  await expect(page.getByRole("status")).toHaveText("The member is in the group.");
  const daikanyama = await createProperty(page, "Daikanyama Loft", "East office");

  // Each member reaches only what is assigned to them or to their group; the owner reaches all.
  await creator.goto("/");
  await expect(listed(creator)).toHaveText(["Shibuya Flat"]);
  await manager.goto("/");
  await expect(listed(manager)).toHaveText(["Daikanyama Loft"]);
  await page.goto("/");
  await expect(listed(page)).toHaveCount(3);

  // The Creator works on its Property: it uploads the photos.
  await creator.goto(shibuya);
  await expect(creator.getByRole("heading", { name: "Shibuya Flat" })).toBeVisible();
  const photos = await makePhotos(testInfo.outputPath());
  await (await hydrated(creator.locator('input[type="file"]'))).setInputFiles(photos);
  const uploads = creator.locator(".upload-list li");
  await expect(uploads).toHaveCount(photos.length);
  for (const photo of photos) {
    await expect(uploads.filter({ hasText: basename(photo) })).toContainText("ready");
  }
  await creator.reload();
  await expect(creator.getByRole("heading", { name: "Photos (3/20)" })).toBeVisible();

  // A Property a member does not reach is not found from its address either.
  for (const address of [ebisu, daikanyama]) {
    await creator.goto(address);
    await expect(pageAlert(creator)).toHaveText("Property not found");
  }
  await manager.goto(daikanyama);
  await expect(manager.getByRole("heading", { name: "Daikanyama Loft" })).toBeVisible();
  for (const address of [ebisu, shibuya]) {
    await manager.goto(address);
    await expect(pageAlert(manager)).toHaveText("Property not found");
  }
  await creator.close();
  await manager.close();
});
