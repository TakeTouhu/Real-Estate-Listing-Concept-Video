import { basename } from "node:path";
import { expect, test } from "@playwright/test";
import { hydrated } from "./support/hydration";
import { provisionPremiumPlan, signUpOwner } from "./support/owner";
import { makePhotos } from "./support/photos";

/**
 * The first browser test (GS-13a, ADR-0121): a new customer reaches a
 * Property holding their photos, through the web app's own pages, in a real
 * browser, and has them analyzed from the review page (GS-13b, ADR-0122). The
 * rest of the way to a delivered video follows in GS-13c and GS-13d.
 */
test("an owner signs up, sets up MFA, is given a plan, uploads a Property's photos and has them analyzed", async ({
  page,
}, testInfo) => {
  const owner = await signUpOwner(page, "Browser Test Realty");

  await page.getByRole("link", { name: "Units and plan" }).click();
  await expect(page.getByText("This organization has no plan yet.")).toBeVisible();
  await provisionPremiumPlan(owner.organizationId);
  await page.reload();
  await expect(page.getByText("Premium plan")).toBeVisible();
  await expect(page.getByText("40 of 40 left.")).toBeVisible();

  await page.goto("/");
  await page.getByText("Add a property").click();
  await page.getByLabel("Property name").fill("Shibuya Harbour View");
  await page.getByLabel("I own or have licensed the photos I will upload for this property.").check();
  await page.getByRole("button", { name: "Create property" }).click();
  await expect(page.getByRole("heading", { name: "Shibuya Harbour View" })).toBeVisible();

  // Each photo goes from the browser straight to its signed upload link, then is processed.
  // Only each answer's status is kept: a signed link is never printed.
  const signedUploads: number[] = [];
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (response.request().method() !== "PUT" || url.pathname !== "/api/storage/upload") return;
    if (url.searchParams.has("token")) signedUploads.push(response.status());
  });
  const photos = await makePhotos(testInfo.outputPath());
  await (await hydrated(page.locator('input[type="file"]'))).setInputFiles(photos);
  const uploads = page.locator(".upload-list li");
  await expect(uploads).toHaveCount(photos.length);
  for (const photo of photos) {
    await expect(uploads.filter({ hasText: basename(photo) })).toContainText("ready");
  }
  expect(signedUploads).toEqual(photos.map(() => 200));

  await page.reload();
  await expect(page.getByRole("heading", { name: "Photos (3/20)" })).toBeVisible();
  for (const photo of photos) {
    const listed = page.getByRole("listitem").filter({ hasText: `${basename(photo)} — READY · 1280×720` });
    await expect(listed).toBeVisible();
  }

  // GS-13b (ADR-0122): the review page starts each photo's analysis, so each awaits a person's decision.
  await page.getByRole("link", { name: "Review photo analyses →" }).click();
  await expect(page.getByRole("heading", { name: "Not reviewable yet (3)" })).toBeVisible();
  await (await hydrated(page.getByRole("button", { name: "Analyze 3 photos not analyzed yet" }))).click();
  await expect(page.getByRole("heading", { name: "Awaiting decision (3)" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Not reviewable yet (0)" })).toBeVisible();
  await expect(page.getByRole("button", { name: /not analyzed yet/ })).toHaveCount(0);
  for (const photo of photos) {
    await expect(page.locator(".review-name", { hasText: basename(photo) })).toContainText("revision 1");
  }
});
