import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import { expect, type Page } from "@playwright/test";
import { REPO_ROOT, e2eEnvironment } from "./environment";
import { hydrated } from "./hydration";
import { verificationLink } from "./outbox";
import { totp } from "./totp";

/**
 * The people and contracts a browser test starts from (GS-13a, ADR-0121): a
 * new person signs up, verifies their email address from the link mailed to
 * it (ADR-0129), creates an organization and so becomes its `OWNER`, sets up
 * MFA as an `OWNER` must (MFA-3), and an operator gives the
 * organization a plan, as the operator command does for an executed contract
 * (ADR-0066). Each test makes its own, under a new address, so a run never
 * meets an earlier one's rows.
 */

const run = promisify(execFile);

export interface Owner {
  readonly email: string;
  readonly organizationId: string;
}

/** An address no earlier run used, at a domain reserved for tests. */
export function newEmail(role: string): string {
  return `${role}-${Date.now()}-${randomBytes(4).toString("hex")}@example.test`;
}

/** The first instant of this UTC month, with its offset, as the contract's start. */
export function contractStart(now: Date = new Date()): string {
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${now.getUTCFullYear()}-${month}-01T00:00:00+00:00`;
}

/**
 * Signs a new person up, has them verify their email address, create
 * `organizationName` and set up MFA with an authenticator app, and leaves them
 * signed in on the organizations page.
 */
export async function signUpOwner(page: Page, organizationName: string): Promise<Owner> {
  const email = newEmail("owner");
  await page.goto("/login");
  const register = page.locator("form", { has: page.getByRole("heading", { name: "Create account" }) });
  await register.getByLabel("Name").fill("Test Owner");
  await register.getByLabel("Email").fill(email);
  await register.getByLabel("Password (min 10 characters)").fill(`pw-${randomBytes(12).toString("hex")}`);
  await register.getByRole("button", { name: "Create account" }).click();
  // A new account sees only the verify page until it opens the link mailed to it (ADR-0129).
  await expect(page.getByRole("heading", { name: "Verify your email address" })).toBeVisible();
  await expect(page.getByText(email, { exact: true })).toBeVisible();
  await page.goto("/");
  await expect(page).toHaveURL(/\/verify-email$/);
  await page.goto(await verificationLink(email));
  await page.getByRole("button", { name: "Verify email address" }).click();
  await expect(page.getByRole("heading", { name: "Email address verified" })).toBeVisible();
  await page.getByRole("link", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Organizations" })).toBeVisible();
  await expect(page.getByText(`(${email})`)).toBeVisible();

  await page.getByLabel("Organization name").fill(organizationName);
  await page.getByRole("button", { name: "Create", exact: true }).click();
  // An OWNER must use MFA, so the organization is reached only through setting it up.
  await expect(page).toHaveURL(/\/security$/);
  await expect(page.getByText("Your role or organization requires two-step sign-in (MFA).")).toBeVisible();
  await (await hydrated(page.getByRole("button", { name: "Set up MFA" }))).click();
  const key = (await page.locator("p", { hasText: "Key:" }).locator("code").innerText()).trim();
  await page.getByLabel("Code from your authenticator app").fill(totp(key));
  await page.getByRole("button", { name: "Turn on MFA" }).click();
  await expect(page.getByRole("heading", { name: "Your recovery codes" })).toBeVisible();
  await page.getByRole("button", { name: "I have saved them" }).click();

  const card = page.locator(".card", { has: page.getByRole("heading", { name: `${organizationName} (OWNER)` }) });
  await expect(card).toBeVisible();
  const units = await card.getByRole("link", { name: "Units and plan" }).getAttribute("href");
  const organizationId = /^\/organizations\/([A-Za-z0-9_-]+)\/units$/.exec(units ?? "")?.[1];
  if (organizationId === undefined) throw new Error("The organizations page names no organization");
  return { email, organizationId };
}

/** Gives the organization a Premium plan from this month, as an operator does for a signed contract. */
export async function provisionPremiumPlan(organizationId: string): Promise<void> {
  await run(
    "pnpm",
    [
      ...["--filter", "@app/ops", "provision-subscription"],
      ...["--organization", organizationId, "--plan", "premium", "--starts", contractStart()],
      ...["--contract", `E2E-${organizationId}`, "--operator", "Browser test", "--reason", "Browser test"],
    ],
    { cwd: REPO_ROOT, env: { ...process.env, ...e2eEnvironment() } },
  );
}
