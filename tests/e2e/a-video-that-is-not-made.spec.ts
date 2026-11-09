import { expect, test } from "@playwright/test";
import { runPipelineMakingNoClip } from "./support/clipless-pipeline";
import { provisionPremiumPlan, signUpOwner } from "./support/owner";
import { makePhotos } from "./support/photos";
import { propertyWithAnalyzedPhotos } from "./support/property";
import { startVideo } from "./support/video";

/**
 * A video that is not made, in a real browser (GS-13d): an owner starts a
 * video as the second test does, which reserves a Unit, and the development
 * pipeline runs with a test provider that makes no clip. The video ends
 * without one, so its Unit comes back (ADR-0052 Decision 19): the project
 * page says it failed in ADR-0052's words and that the Unit was not used,
 * offers no video to play or download, and offers a new start, which the
 * start page offers too; the Units page counts the Unit again.
 */
test("a video that is not made ends failed, gives its Unit back and can be started again", async ({
  page,
}, testInfo) => {
  const owner = await signUpOwner(page, "Failed Video Realty");
  await provisionPremiumPlan(owner.organizationId);
  const unitsPage = `/organizations/${owner.organizationId}/units`;

  const photos = await makePhotos(testInfo.outputPath());
  await propertyWithAnalyzedPhotos(page, "Meguro Garden House", photos);
  const video = await startVideo(page, "Meguro Garden House", "Meguro Garden House tour");
  // The project page without the start's notice, which belongs to the start alone.
  const projectPage = new URL(page.url());
  projectPage.search = "";
  // The count leaves out a reserved Unit as well as a used one.
  await page.goto(unitsPage);
  await expect(page.getByText("39 of 40 left.")).toBeVisible();

  // It ends as a scene the test provider refused ends (GS-2): one settled, the job's other two closed, nothing copied.
  const run = await runPipelineMakingNoClip();
  expect({
    settled: run.totals.attempt_failure_settlement.changed,
    closed: run.totals.failed_job_scene_closure.changed,
    copied: run.totals.provider_output.changed,
  }).toEqual({ settled: 1, closed: 2, copied: 0 });
  await page.goto(projectPage.toString());
  await expect(page.getByText("The start was confirmed.")).toHaveCount(0);
  await expect(video).toContainText("Failed");
  await expect(video).toContainText("Normal · 15 seconds");
  // ADR-0052's words for a video that ended without one (Decisions 5 and 19).
  const notDelivered = "動画を正常に生成できませんでした。今回の生成ではUnitは消費されていません。";
  await expect(video).toContainText(notDelivered);
  await expect(video).toContainText("The 1 Normal Unit reserved for it came back; it was not used.");
  await expect(video).toContainText("A new video can be started for this project.");
  await expect(video.getByLabel("The delivered video")).toHaveCount(0);
  await expect(video.getByRole("button", { name: "Download video" })).toHaveCount(0);

  // The start page offers the same video again, from the Unit that came back.
  await page.getByRole("link", { name: "Review and start the video" }).click();
  await expect(page.getByText("Quality: Normal. 3 scenes, 15 seconds in all:")).toBeVisible();
  await expect(page.getByRole("button", { name: "Start the video and reserve 1 Normal Unit" })).toBeVisible();

  await page.goto(unitsPage);
  await expect(page.getByText("40 of 40 left.")).toBeVisible();
});
