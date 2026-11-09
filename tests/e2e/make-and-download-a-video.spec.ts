import { expect, test } from "@playwright/test";
import { hydrated } from "./support/hydration";
import { decodeVideo, probeVideo } from "./support/media";
import { provisionPremiumPlan, signUpOwner } from "./support/owner";
import { makePhotos } from "./support/photos";
import { runPipeline } from "./support/pipeline";
import { propertyWithAnalyzedPhotos } from "./support/property";

/**
 * The whole way to a delivered video, in a real browser (GS-13c-2): an owner
 * approves a Property's analyzed photos, creates a video project, composes its
 * storyboard and starts the video on the start page, which reserves a Unit.
 * The development pipeline then makes it with the test provider, as a person
 * runs it (ADR-0108). The project page shows it delivered and the Unit used;
 * the player's link serves the video a range at a time, and the download saves
 * it under the project's name. Playwright's Chromium cannot decode H.264
 * (ADR-0117 Decision 4), so FFmpeg proves the saved file plays.
 */
test("an owner approves the photos, starts a video, has it made and downloads it, using one Unit", async ({
  page,
}, testInfo) => {
  const owner = await signUpOwner(page, "Video Test Realty");
  await provisionPremiumPlan(owner.organizationId);
  const unitsPage = `/organizations/${owner.organizationId}/units`;
  await page.goto(unitsPage);
  await expect(page.getByText("40 of 40 left.")).toBeVisible();

  const photos = await makePhotos(testInfo.outputPath());
  await propertyWithAnalyzedPhotos(page, "Shibuya Harbour View", photos);

  // A person approves each photo, one at a time, as the review page offers.
  for (let awaiting = photos.length; awaiting > 0; awaiting -= 1) {
    await expect(page.getByRole("heading", { name: `Awaiting decision (${awaiting})` })).toBeVisible();
    await (await hydrated(page.getByRole("button", { name: "Approve", exact: true }).first())).click();
  }
  await expect(page.getByRole("heading", { name: "Awaiting decision (0)" })).toBeVisible();
  await expect(page.getByRole("heading", { name: `Decided (${photos.length})` })).toBeVisible();

  await page.getByRole("link", { name: "← Shibuya Harbour View" }).click();
  await page.getByRole("link", { name: "Videos →" }).click();
  // A name outside ASCII, which the saved file keeps (ADR-0118 Decision 2).
  const name = "渋谷 Harbour View";
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
  await expect(page.getByRole("heading", { name: "Storyboard (3 scenes)" })).toBeVisible();
  const fresh = "This storyboard matches the photos currently approved for this property.";
  await expect(page.getByText(fresh)).toBeVisible();

  await page.getByRole("link", { name: "Review and start the video" }).click();
  await expect(page.getByRole("heading", { name: "Review the video" })).toBeVisible();
  await expect(page.getByText("Quality: Normal. 3 scenes, 15 seconds in all:")).toBeVisible();
  await page.getByRole("button", { name: "Start the video and reserve 1 Normal Unit" }).click();
  await expect(page.getByRole("status").filter({ hasText: "The start was confirmed." })).toBeVisible();
  const video = page.getByRole("region", { name: "Video", exact: true });
  await expect(video).toContainText("Queued");
  await expect(video).toContainText("0 of 3 scenes made");
  await expect(video).toContainText("1 Normal Unit is reserved for it, and used only if it is delivered.");

  // Made by the pipeline, which nothing runs by itself: one run takes the job to a delivered video.
  await runPipeline();
  await page.reload();
  await expect(video).toContainText("Completed");
  await expect(video).toContainText("Normal · 15 seconds");
  await expect(video).toContainText("It used 1 Normal Unit.");

  // The player's link serves the video a range at a time. It is asked from Node, outside Playwright's recorded steps,
  // and only its answer is read: the link is never printed (ADR-0121 Decision 1).
  const src = await video.getByLabel("The delivered video").getAttribute("src");
  if (src === null) throw new Error("The player has no link");
  const range = await fetch(new URL(src, page.url()), { headers: { Range: "bytes=0-1023" } }).catch(() => {
    throw new Error("The player's link could not be read");
  });
  expect(range.status).toBe(206);
  expect(range.headers.get("content-type")).toBe("video/mp4");
  expect(range.headers.get("content-range")).toMatch(/^bytes 0-1023\/[0-9]+$/);
  expect((await range.arrayBuffer()).byteLength).toBe(1024);

  // The download saves it under the project's name; FFmpeg decodes it as the H.264 video the project asked for.
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    video.getByRole("button", { name: "Download video" }).click(),
  ]);
  expect(download.suggestedFilename()).toBe(`${name}.mp4`);
  const saved = testInfo.outputPath("download.mp4");
  await download.saveAs(saved);
  const facts = await probeVideo(saved);
  expect({ codec: facts.codec, width: facts.width, height: facts.height }).toEqual({
    codec: "h264",
    width: 1280,
    height: 720,
  });
  expect(facts.durationSeconds).toBeCloseTo(15, 1);
  await decodeVideo(saved);

  // The count leaves out a reserved Unit as well as a used one: it shows that the Unit did not come back, and the
  // project page above that it was used.
  await page.goto(unitsPage);
  await expect(page.getByText("39 of 40 left.")).toBeVisible();
});
