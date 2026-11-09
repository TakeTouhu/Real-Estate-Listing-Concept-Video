import { basename } from "node:path";
import { expect, type Page } from "@playwright/test";
import { hydrated } from "./hydration";

/**
 * A Property whose photos await a person's decision (GS-13c-2): created,
 * uploaded to and analyzed through the pages, as the first browser test does
 * step by step (GS-13a, GS-13b).
 */

/**
 * Creates `name`, uploads `photos` to it, has each analyzed from the review
 * page, and leaves the browser on that page with every photo awaiting a
 * decision.
 */
export async function propertyWithAnalyzedPhotos(page: Page, name: string, photos: readonly string[]): Promise<void> {
  await page.goto("/");
  await page.getByText("Add a property").click();
  await page.getByLabel("Property name").fill(name);
  await page.getByLabel("I own or have licensed the photos I will upload for this property.").check();
  await page.getByRole("button", { name: "Create property" }).click();
  await expect(page.getByRole("heading", { name })).toBeVisible();

  await (await hydrated(page.locator('input[type="file"]'))).setInputFiles([...photos]);
  const uploads = page.locator(".upload-list li");
  await expect(uploads).toHaveCount(photos.length);
  for (const photo of photos) {
    await expect(uploads.filter({ hasText: basename(photo) })).toContainText("ready");
  }

  await page.reload();
  await page.getByRole("link", { name: "Review photo analyses →" }).click();
  const count = photos.length;
  await (await hydrated(page.getByRole("button", { name: `Analyze ${count} photos not analyzed yet` }))).click();
  // One request per photo, then the page read again: longer than one step on a cold dev server.
  await expect(page.getByRole("heading", { name: `Awaiting decision (${count})` })).toBeVisible({ timeout: 120_000 });
  await expect(page.getByRole("heading", { name: "Not reviewable yet (0)" })).toBeVisible();
}
