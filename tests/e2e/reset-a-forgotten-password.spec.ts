import { expect, test, type Page } from "@playwright/test";
import { E2E_BASE_URL } from "./support/environment";
import { passwordResetLink } from "./support/outbox";
import { newPassword, signUpPerson } from "./support/owner";

/**
 * Password reset in a real browser (AT-4c, ADR-0133): a person who forgot
 * their password asks for a link from the sign-in page, opens it from the
 * outbox and chooses a new one. The browser they were still signed in on is
 * signed out, the old password no longer signs in, and the new one does.
 */
async function signIn(page: Page, email: string, password: string): Promise<void> {
  await page.goto("/login");
  const form = page.locator("form", { has: page.getByRole("heading", { name: "Sign in" }) });
  await form.getByLabel("Email").fill(email);
  await form.getByLabel("Password").fill(password);
  await form.getByRole("button", { name: "Sign in" }).click();
}

test("a person resets a forgotten password from an emailed link, and every sign-in of the account ends", async ({
  page,
  browser,
}) => {
  const person = await signUpPerson(page);

  // Another browser, signed in to nothing.
  const elsewhere = await browser.newPage({ baseURL: E2E_BASE_URL });
  await elsewhere.goto("/login");
  await elsewhere.getByRole("link", { name: "Forgot your password?" }).click();
  await expect(elsewhere.getByRole("heading", { name: "Reset your password" })).toBeVisible();
  await elsewhere.getByLabel("Email").fill(person.email);
  await elsewhere.getByRole("button", { name: "Send the link" }).click();
  await expect(elsewhere.getByRole("status")).toContainText("If an account uses that email address");

  await elsewhere.goto(await passwordResetLink(person.email));
  // The address holds the token: the page tells nothing it leads to more than its origin.
  await expect(elsewhere.locator('meta[name="referrer"]')).toHaveAttribute("content", "strict-origin");
  const password = newPassword();
  await elsewhere.getByLabel("New password (min 10 characters)").fill(password);
  await elsewhere.getByRole("button", { name: "Change password" }).click();
  await expect(elsewhere.getByRole("heading", { name: "Password changed" })).toBeVisible();
  // The link worked once.
  await elsewhere.goto(await passwordResetLink(person.email));
  await expect(elsewhere.getByRole("heading", { name: "Link not valid" })).toBeVisible();
  await elsewhere.close();

  // The first browser's sign-in ended with the reset.
  await page.reload();
  await expect(page).toHaveURL(/\/login$/);
  await signIn(page, person.email, person.password);
  await expect(page.getByRole("alert")).toHaveText("Invalid email or password");
  await signIn(page, person.email, password);
  await expect(page.getByRole("heading", { name: "Organizations" })).toBeVisible();
  await expect(page.getByText(`(${person.email})`)).toBeVisible();
});
