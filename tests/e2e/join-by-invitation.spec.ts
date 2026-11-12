import { expect, test } from "@playwright/test";
import { E2E_BASE_URL } from "./support/environment";
import { invitationLink, verificationLink } from "./support/outbox";
import { newEmail, newPassword, provisionPremiumPlan, signUpOwner } from "./support/owner";

/**
 * Joining an organization by invitation in a real browser (AT-7b, ADR-0138):
 * an owner invites a colleague from the members page; the colleague opens the
 * emailed link in their own browser, creates an account with the invited
 * address and verifies it, the invitation waiting all along, then accepts and
 * joins with the invited role. The link works once, and the owner's page
 * shows the new member in a seat. The owner then gives the colleague another
 * role, which the colleague's page follows (AT-8a, ADR-0139), and finally
 * removes the colleague, whose page no longer lists the organization (AT-8b,
 * ADR-0140).
 */
test("a colleague opens an emailed invitation, signs up, verifies, joins, gets another role and is removed", async ({
  page,
  browser,
}) => {
  const organizationName = `Kanda Realty ${Date.now()}`;
  const owner = await signUpOwner(page, organizationName);
  await provisionPremiumPlan(owner.organizationId);
  await page.goto(`/organizations/${owner.organizationId}/members`);
  const colleague = newEmail("colleague");
  await page.getByLabel("Email address").fill(colleague);
  await page.getByLabel("Role").selectOption("CREATOR");
  await page.getByRole("button", { name: "Send invitation" }).click();
  await expect(page.getByRole("status")).toContainText("The invitation was sent.");

  // The colleague's own browser, signed in to nothing.
  const invitee = await browser.newPage({ baseURL: E2E_BASE_URL });
  const link = await invitationLink(colleague);
  await invitee.goto(link);
  // The address holds the token: the page tells nothing it leads to more than its origin.
  await expect(invitee.locator('meta[name="referrer"]')).toHaveAttribute("content", "strict-origin");
  await expect(invitee.getByRole("heading", { name: `Join ${organizationName}` })).toBeVisible();
  await expect(invitee.getByText("on VTaVision as a Creator.")).toBeVisible();
  await invitee.getByRole("button", { name: "Continue" }).click();

  // The invitation waits while the colleague creates an account and verifies its address.
  await expect(invitee).toHaveURL(/\/login$/);
  await expect(invitee.getByRole("status")).toContainText(`To join ${organizationName}, sign in or create`);
  const register = invitee.locator("form", { has: invitee.getByRole("heading", { name: "Create account" }) });
  await register.getByLabel("Name").fill("New Colleague");
  await register.getByLabel("Email").fill(colleague);
  await register.getByLabel("Password (min 10 characters)").fill(newPassword());
  await register.getByRole("button", { name: "Create account" }).click();
  await expect(invitee.getByRole("heading", { name: "Verify your email address" })).toBeVisible();
  await invitee.goto(await verificationLink(colleague));
  await invitee.getByRole("button", { name: "Verify email address" }).click();
  await expect(invitee.getByRole("heading", { name: "Email address verified" })).toBeVisible();
  await invitee.getByRole("link", { name: "Continue" }).click();

  await expect(invitee.getByRole("heading", { name: `Join ${organizationName}` })).toBeVisible();
  await expect(invitee.getByText("You are signed in as")).toContainText(colleague);
  await invitee.getByRole("button", { name: "Accept invitation" }).click();
  await expect(invitee.getByRole("status")).toHaveText(`You joined ${organizationName} as CREATOR.`);
  await expect(invitee.getByRole("heading", { name: `${organizationName} (CREATOR)` })).toBeVisible();

  // The link worked once.
  await invitee.goto(link);
  await expect(invitee.getByRole("heading", { name: "Link not valid" })).toBeVisible();

  // The owner's page shows the colleague as a member in a seat, and no invitation pending.
  await page.goto(`/organizations/${owner.organizationId}/members`);
  await expect(page.getByRole("heading", { name: "Members (2)" })).toBeVisible();
  await expect(page.getByText(`New Colleague · ${colleague} · Creator`)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Pending invitations (0)" })).toBeVisible();

  // The owner makes the colleague a Viewer, and the colleague's own page follows.
  await page.getByRole("combobox", { name: `New role for ${colleague}` }).selectOption("VIEWER");
  await page.getByRole("button", { name: `Change the role of ${colleague}` }).click();
  await expect(page.getByRole("status")).toContainText("The member's role was changed.");
  await expect(page.getByText(`New Colleague · ${colleague} · Viewer`)).toBeVisible();
  await invitee.goto("/");
  await expect(invitee.getByRole("heading", { name: `${organizationName} (VIEWER)` })).toBeVisible();

  // The owner removes the colleague, after reading what removing does; the colleague's page no longer lists it.
  await page.getByLabel(`Remove ${colleague}…`).click();
  await expect(page.getByText(`${colleague} will no longer be able to open this organization.`)).toBeVisible();
  await page.getByRole("button", { name: `Remove member ${colleague}` }).click();
  await expect(page.getByRole("status")).toContainText("The member was removed.");
  await expect(page.getByRole("heading", { name: "Members (1)" })).toBeVisible();
  await expect(page.getByText(colleague)).toHaveCount(0);
  await invitee.goto("/");
  await expect(invitee.getByText("You are not a member of any organization yet.")).toBeVisible();
  await expect(invitee.getByRole("heading", { name: new RegExp(organizationName) })).toHaveCount(0);
  await invitee.close();
});
