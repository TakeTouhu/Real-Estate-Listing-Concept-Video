import { test as base, expect, type BrowserContext } from "@playwright/test";

export { expect };

/** Chromium's console text for anything the page's Content Security Policy refused. */
const VIOLATION_TEXT = /Content Security Policy|Refused to/;

/** The page function the guard's listener reports through. */
const BINDING = "__reportCspViolation";

/** Whether a console message tells of a refusal by the policy. */
export function isViolationText(text: string): boolean {
  return VIOLATION_TEXT.test(text);
}

/** A refusal as the test reports it: a signed link's token is never printed (ADR-0121 Decision 1). */
export function redactViolation(text: string): string {
  return text.replace(/\?[^\s'"]+/g, "?…");
}

type Guard = { watch(context: BrowserContext): Promise<void> };

/**
 * Lets each open page of a context finish loading, then makes one round trip to
 * it, so that every refusal it has already reported has reached the guard. A
 * page that fails either is closed or gone: nothing to wait for.
 */
async function settle(context: BrowserContext): Promise<void> {
  for (const page of context.pages()) {
    await page.waitForLoadState("load").catch(() => undefined);
    await page.evaluate(() => 0).catch(() => undefined);
  }
}

/**
 * Every browser spec fails on a Content Security Policy refusal (RD-9e,
 * ADR-0174 Decision 10): a console message of Chromium's that names the policy
 * or says "Refused to", or a `securitypolicyviolation` event in any page. Specs
 * import `test` and `expect` from here, never from `@playwright/test`.
 *
 * It watches the test's own browser context and every one the test opens with
 * `browser.newPage` or `browser.newContext`, as a second person's browser, and
 * reports after the test, with each refusal's text.
 *
 * Its limit: it sees what is refused while the test runs and until each open
 * page has loaded and answered once after the test's last statement. A refusal
 * that comes later, from a script that runs after that or a page still
 * navigating as its context closes, is not seen; there is no fixed wait.
 */
export const test = base.extend<{ cspGuard: Guard }>({
  cspGuard: [
    async ({ browser }, use) => {
      const violations: string[] = [];
      const watched: BrowserContext[] = [];
      const watch = async (context: BrowserContext): Promise<void> => {
        if (watched.includes(context)) return;
        watched.push(context);
        context.on("console", (message) => {
          if (isViolationText(message.text())) violations.push(redactViolation(`console: ${message.text()}`));
        });
        await context.exposeBinding(BINDING, (_source, report: string) => {
          violations.push(redactViolation(`securitypolicyviolation: ${report}`));
        });
        // In the page, before its own scripts; the policy does not apply to it. On the window, not the document, so
        // a popup's window that keeps its first document's listeners still reports.
        await context.addInitScript({
          content: `globalThis.addEventListener("securitypolicyviolation", (event) => {
            const report = event.effectiveDirective + " refused " + event.blockedURI + " on " + event.documentURI;
            void globalThis.${BINDING}?.(report);
          });`,
        });
      };
      // Contexts the test opens itself: `newPage` makes its own context.
      const { newContext, newPage } = browser;
      browser.newContext = async (options) => {
        const context = await newContext.call(browser, options);
        await watch(context);
        return context;
      };
      browser.newPage = async (options) => {
        const page = await newPage.call(browser, options);
        await watch(page.context());
        return page;
      };
      try {
        await use({ watch });
      } finally {
        browser.newContext = newContext;
        browser.newPage = newPage;
      }
      // The test's own context is settled before it closes; this settles the ones the test opened.
      for (const context of watched) await settle(context);
      expect(violations, "The page's Content Security Policy refused something").toEqual([]);
    },
    { auto: true },
  ],
  context: async ({ context, cspGuard }, use) => {
    await cspGuard.watch(context);
    await use(context);
    await settle(context);
  },
});
