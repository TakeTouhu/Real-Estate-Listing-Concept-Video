import { expect, type Locator, type Page } from "@playwright/test";
import { hydrated } from "./hydration";

/**
 * From a Property's analyzed photos to a started video, through the pages
 * (GS-13c-2, GS-13d; ADR-0124, ADR-0125), as both browser tests of a video
 * take an owner there.
 */

/** The photos `makePhotos` draws, each approved and each a scene. */
const PHOTOS = 3;

/**
 * From the review page, with `makePhotos`' three photos awaiting a decision:
 * a person approves each, creates a video project `name` of 15 seconds at 720p
 * and 16:9 from the Property `propertyName`, composes a storyboard of three
 * 5-second scenes and starts the video on the start page, reserving one Normal
 * Unit. Leaves the browser on the project page, the video queued, and returns
 * the page's Video region.
 */
export async function startVideo(page: Page, propertyName: string, name: string): Promise<Locator> {
  // A person approves each photo, one at a time, as the review page offers.
  for (let awaiting = PHOTOS; awaiting > 0; awaiting -= 1) {
    await expect(page.getByRole("heading", { name: `Awaiting decision (${awaiting})` })).toBeVisible();
    await (await hydrated(page.getByRole("button", { name: "Approve", exact: true }).first())).click();
  }
  await expect(page.getByRole("heading", { name: "Awaiting decision (0)" })).toBeVisible();
  await expect(page.getByRole("heading", { name: `Decided (${PHOTOS})` })).toBeVisible();

  await page.getByRole("link", { name: `← ${propertyName}` }).click();
  await page.getByRole("link", { name: "Videos →" }).click();
  await (await hydrated(page.getByLabel("Project name"))).fill(name);
  await page.getByLabel("Target length in seconds").fill("15");
  await page.getByLabel("Aspect ratio").fill("16:9");
  await page.getByLabel("Output resolution").selectOption("720p");
  await page.getByRole("button", { name: "Create project" }).click();
  await page.getByRole("link", { name }).click();
  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();

  // Composition shares the project's 15 seconds between the 3 approved photos: 5 seconds each, which the test
  // provider's route makes (ADR-0123).
  await (await hydrated(page.getByLabel("Shortest scene, in seconds"))).fill("5");
  await page.getByLabel("Longest scene, in seconds").fill("5");
  await page.getByRole("button", { name: "Compose storyboard" }).click();
  await expect(page.getByRole("heading", { name: `Storyboard (${PHOTOS} scenes)` })).toBeVisible();
  const fresh = "This storyboard matches the photos currently approved for this property.";
  await expect(page.getByText(fresh)).toBeVisible();

  await page.getByRole("link", { name: "Review and start the video" }).click();
  await expect(page.getByRole("heading", { name: "Review the video" })).toBeVisible();
  await expect(page.getByText(`Quality: Normal. ${PHOTOS} scenes, 15 seconds in all:`)).toBeVisible();
  await page.getByRole("button", { name: "Start the video and reserve 1 Normal Unit" }).click();
  await expect(page.getByRole("status").filter({ hasText: "The start was confirmed." })).toBeVisible();
  const video = page.getByRole("region", { name: "Video", exact: true });
  await expect(video).toContainText("Queued");
  await expect(video).toContainText(`0 of ${PHOTOS} scenes made`);
  await expect(video).toContainText("1 Normal Unit is reserved for it, and used only if it is delivered.");
  return video;
}
