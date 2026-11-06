import { expect, type Locator } from "@playwright/test";

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
