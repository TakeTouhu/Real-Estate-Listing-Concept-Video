import { expect, type Locator, type Page } from "@playwright/test";

/**
 * Waits until React has attached its handlers to an element of a client
 * component, and returns it (GS-13a, ADR-0121).
 *
 * `next dev` sends a page before its scripts have run, and a press or a typed
 * value before then is lost: nothing happens, or the component's state never
 * hears of it. A plain form posts without scripts and needs no wait. React
 * keeps an element's handlers under a `__reactProps$…` key once it has
 * hydrated it; the test reads only that the key is there.
 */
export async function hydrated(locator: Locator): Promise<Locator> {
  await expect(locator).toBeAttached();
  await expect
    .poll(() => locator.evaluate((element) => Object.keys(element).some((key) => key.startsWith("__reactProps$"))))
    .toBe(true);
  return locator;
}

/**
 * The alert the page itself shows (AT-12, ADR-0149 Decision 4).
 *
 * Once React has hydrated a page, Next.js adds a route announcer to the body
 * that is an alert too: out of sight, but found by `getByRole`, so a check of
 * every alert would match two. Every page of the app renders inside the root
 * layout's `main`, and the announcer sits outside it.
 */
export function pageAlert(page: Page): Locator {
  return page.getByRole("main").getByRole("alert");
}
