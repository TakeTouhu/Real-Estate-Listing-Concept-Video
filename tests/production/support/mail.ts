import { expect, type Page } from "@playwright/test";
import { messagesTo } from "../../email/smtp";
import { APP_BASE_URL, listValue, type ProductionRun } from "./run";

/** The page's own `location`: this file is typed without the DOM. */
type Location = { assign(href: string): void };

/**
 * Mail read from Mailpit as a person reads their inbox (ADR-0178 Decision 9).
 * A mailed link is a one-time secret: it is never printed, and a failure
 * names neither it nor the address.
 */

/**
 * The `path` link mailed to `to`, read once Mailpit holds exactly `count`
 * messages for it; the address and the link's token are listed for the log
 * check.
 */
export async function onlyMailedLink(run: ProductionRun, to: string, path: string, count = 1): Promise<string> {
  listValue(run, to);
  // Sent before the answer that follows it; Mailpit stores it as it says so. Bounded, never a fixed wait.
  await expect
    .poll(async () => (await messagesTo(run.mailpitApiPort, to)).length, { message: "Mail to the account" })
    .toBe(count);
  const prefix = `${APP_BASE_URL}${path}?token=`;
  const mail = await messagesTo(run.mailpitApiPort, to);
  if (mail.length !== count) throw new Error(`${mail.length} mails reached the account, ${count} expected`);
  const lines = mail.flatMap((message) => message.Text.split(/\r?\n/)).filter((line) => line.startsWith(prefix));
  const link = lines.at(-1);
  if (link === undefined) throw new Error(`No ${path} link was mailed to the account`);
  listValue(run, link.slice(prefix.length));
  return link;
}

/**
 * Opens a mailed link in `page` and runs `then` there. A script hands the link
 * to the page, so no step is titled with it, and any failure on the way is
 * rethrown as one fixed message, so no error carries it. `then` asserts on what
 * the page shows, never on its address: a failed step's error reaches the HTML
 * report even when caught here.
 */
export async function openMailedLink(page: Page, link: string, then: () => Promise<void>): Promise<void> {
  try {
    // Run in the page.
    const go = (href: string): void => (globalThis as unknown as { location: Location }).location.assign(href);
    await page.evaluate(go, link);
    await page.waitForURL(/[?&]token=/);
    await then();
  } catch {
    throw new Error("A mailed link did not lead where it should");
  }
}
