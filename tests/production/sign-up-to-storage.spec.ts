import { SharpImageProcessor } from "@app/storage";
import { expect, test } from "../e2e/support/csp-guard";
import { hydrated } from "../e2e/support/hydration";
import { newEmail, newPassword, pressVerify, provisionPremiumPlan, signUpOwner } from "../e2e/support/owner";
import { totp } from "../e2e/support/totp";
import { EICAR, plainPng, storedZip } from "../scanner/clamav";
import { emulatorObjectNames } from "../storage/emulator";
import { onlyMailedLink, openMailedLink } from "./support/mail";
import { APP_BASE_URL, emulatorBytes, listValue, productionRun } from "./support/run";

/** Read as the file loads, so a run without the job's runner settings fails before the browser starts. */
const run = productionRun();

/**
 * The page policy a production build sends (ADR-0174 Decision 10): `next dev`'s but `'unsafe-eval'` and `ws: wss:`,
 * plus `upgrade-insecure-requests` (ADR-0190).
 */
const productionPagePolicy = (nonce: string): string =>
  `default-src 'self'; script-src 'self' 'nonce-${nonce}' 'strict-dynamic'; style-src 'self' 'unsafe-inline'; ` +
  "img-src 'self' data:; media-src 'self'; font-src 'self'; connect-src 'self'; object-src 'none'; " +
  "base-uri 'none'; form-action 'self'; frame-src 'none'; frame-ancestors 'none'; report-uri /api/csp-report; " +
  "report-to csp; upgrade-insecure-requests";

/**
 * The production image as built, through the TLS front, against the job's
 * stand-ins (RD-11b, ADR-0178): a customer signs up and verifies from Mailpit,
 * sets up MFA, is given a plan, stores photos in the emulator through the
 * production adapter, has a disguised test file quarantined by ClamAV,
 * downloads a photo whole and in ranges, invites a colleague who joins, and
 * signs in again; every page under the guard of the page policy.
 */
test("a customer signs up, stores photos, has a file quarantined, invites a colleague and signs in again", async ({
  page,
  browser,
}) => {
  // 1. Sign-up: exactly one mail, read from Mailpit; the session cookie is Secure.
  const organizationName = `RD-11 Realty ${Date.now()}`;
  const owner = await signUpOwner(page, organizationName, async (person, to) => {
    const link = await onlyMailedLink(run, to, "/verify-email");
    await openMailedLink(person, link, async () => {
      await expect(person.getByText("Press the button to verify")).toBeVisible();
      await pressVerify(person);
    });
  });
  const cookie = (await page.context().cookies()).find((each) => each.name === "rev_session");
  for (const value of [owner.password, owner.mfaKey, cookie?.value]) listValue(run, value);
  expect(cookie?.secure, "The session cookie is Secure").toBe(true);

  // 2. The plan, by the operator command against the job's database.
  await page.getByRole("link", { name: "Units and plan" }).click();
  await expect(page.getByText("This organization has no plan yet.")).toBeVisible();
  await provisionPremiumPlan(owner.organizationId, { DATABASE_URL: run.databaseUrl });
  await page.reload();
  await expect(page.getByText("Premium plan")).toBeVisible();

  // 3 and 4. Three photos to READY, then a JPEG with the EICAR file in a ZIP behind it, quarantined.
  await page.goto("/");
  await page.getByText("Add a property").click();
  await page.getByLabel("Property name").fill("Production Harbour View");
  await page.getByLabel("I own or have licensed the photos I will upload for this property.").check();
  await page.getByRole("button", { name: "Create property" }).click();
  await expect(page.getByRole("heading", { name: "Production Harbour View" })).toBeVisible();
  const signedUploads: number[] = [];
  const completed: string[] = [];
  page.on("response", (response) => {
    const url = new URL(response.url());
    const asset = /^\/api\/assets\/([\w-]+)\/complete$/.exec(url.pathname)?.[1];
    if (asset !== undefined) completed.push(asset);
    if (response.request().method() === "PUT" && url.pathname === "/api/storage/upload") {
      listValue(run, url.searchParams.get("token"));
      signedUploads.push(response.status());
    }
  });
  const jpeg = Buffer.from((await new SharpImageProcessor().process(plainPng([200, 80, 40]))).normalized);
  const photos = [
    { name: "room-1.png", mimeType: "image/png", buffer: plainPng([40, 120, 200]) },
    { name: "room-2.png", mimeType: "image/png", buffer: plainPng([90, 160, 60]) },
    { name: "room-3.jpg", mimeType: "image/jpeg", buffer: jpeg },
  ];
  const input = await hydrated(page.locator('input[type="file"]'));
  const uploads = page.locator(".upload-list li");
  await input.setInputFiles(photos);
  for (const photo of photos) await expect(uploads.filter({ hasText: photo.name })).toContainText("ready");
  const disguised = Buffer.concat([jpeg, storedZip("eicar.com", EICAR)]);
  await input.setInputFiles([{ name: "flagged.jpg", mimeType: "image/jpeg", buffer: disguised }]);
  await expect(uploads.filter({ hasText: "flagged.jpg" })).toContainText("Malware scan flagged this file");
  expect(signedUploads).toEqual([200, 200, 200, 200]);
  await page.reload();
  for (const photo of photos) {
    await expect(page.getByRole("listitem").filter({ hasText: `${photo.name} — READY · 640×480` })).toBeVisible();
  }
  const flagged = page.getByRole("listitem").filter({ hasText: "flagged.jpg — QUARANTINED" });
  await expect(flagged).toContainText("Malware scan flagged this file");

  // The bucket, read from the emulator: each photo's derivatives, none of the flagged file's.
  const names = await emulatorObjectNames(run.storageEndpoint, run.bucket);
  const filesOf = (asset: string): string[] =>
    names.filter((name) => name.includes(`/assets/${asset}/`)).map((name) => name.slice(name.lastIndexOf("/") + 1));
  expect(completed).toHaveLength(4);
  const ready = completed.slice(0, 3);
  for (const asset of ready) {
    expect(filesOf(asset).filter((file) => /^(?:normalized|thumbnail)\./.test(file))).toHaveLength(2);
  }
  expect(filesOf(completed[3] ?? "").filter((file) => /^(?:normalized|thumbnail)\./.test(file))).toEqual([]);
  // Recorded, not asserted (critic C11 item 3).
  const kept = [...ready, completed[3] ?? ""].filter((asset) => filesOf(asset).includes("original.bin")).length;
  console.log(`original.bin kept for ${kept} of 4 uploads`);

  // 5. One normalized photo through its signed link, read by the page itself, so no step is titled with the link.
  const normalized = names.find((name) => name.includes(`/assets/${ready[0]}/normalized.`)) ?? "";
  const stored = await emulatorBytes(run, normalized);
  const given = await page.request.get(`/api/assets/${ready[0]}/download-url?organizationId=${owner.organizationId}`);
  expect(given.status()).toBe(200);
  const { url } = (await given.json()) as { readonly url: string };
  listValue(run, new URL(url, APP_BASE_URL).searchParams.get("token"));
  const read = (method: string, range?: string) =>
    page.evaluate(
      async (ask) => {
        const answer = await fetch(ask.url, { method: ask.method, headers: ask.range ? { Range: ask.range } : {} });
        const bytes = Array.from(new Uint8Array(await answer.arrayBuffer()));
        const header = (name: string) => answer.headers.get(name);
        return { status: answer.status, length: header("content-length"), range: header("content-range"), bytes };
      },
      { url, method, range },
    );
  const size = stored.length;
  const whole = await read("GET");
  expect([whole.status, whole.length]).toEqual([200, String(size)]);
  expect(Buffer.from(whole.bytes).equals(stored)).toBe(true);
  const first = await read("GET", "bytes=0-1023");
  expect([first.status, first.range]).toEqual([206, `bytes 0-1023/${size}`]);
  expect(Buffer.from(first.bytes).equals(stored.subarray(0, 1024))).toBe(true);
  const head = await read("HEAD");
  expect([head.status, head.length, head.bytes.length]).toEqual([200, String(size), 0]);
  const past = await read("GET", `bytes=${size}-`);
  expect([past.status, past.range]).toEqual([416, `bytes */${size}`]);

  // 6. A colleague invited as a Creator opens the one mail in their own browser, signs up, verifies and joins.
  await page.goto(`/organizations/${owner.organizationId}/members`);
  const colleague = newEmail("colleague");
  await page.getByLabel("Email address").fill(colleague);
  await page.getByLabel("Role").selectOption("CREATOR");
  await page.getByRole("button", { name: "Send invitation" }).click();
  await expect(page.getByRole("status")).toContainText("The invitation was sent.");
  const invitation = await onlyMailedLink(run, colleague, "/accept-invitation");
  // The second person's browser: a page of its own does not take the configuration's `use`.
  const invitee = await browser.newPage({ baseURL: APP_BASE_URL, ignoreHTTPSErrors: true });
  await openMailedLink(invitee, invitation, async () => {
    await expect(invitee.getByRole("heading", { name: `Join ${organizationName}` })).toBeVisible();
    await invitee.getByRole("button", { name: "Continue" }).click();
    await expect(invitee.getByRole("heading", { name: "Create account" })).toBeVisible();
  });
  const register = invitee.locator("form", { has: invitee.getByRole("heading", { name: "Create account" }) });
  await register.getByLabel("Name").fill("New Colleague");
  await register.getByLabel("Email").fill(colleague);
  const colleaguePassword = newPassword();
  listValue(run, colleaguePassword);
  await register.getByLabel("Password (min 10 characters)").fill(colleaguePassword);
  await register.getByRole("button", { name: "Create account" }).click();
  await expect(invitee.getByRole("heading", { name: "Verify your email address" })).toBeVisible();
  const verification = await onlyMailedLink(run, colleague, "/verify-email", 2);
  await openMailedLink(invitee, verification, () => pressVerify(invitee));
  await invitee.getByRole("link", { name: "Continue" }).click();
  await invitee.getByRole("button", { name: "Accept invitation" }).click();
  await expect(invitee.getByRole("status")).toHaveText(`You joined ${organizationName} as CREATOR.`);
  await invitee.close();

  // 7. Signed out to /login by a relative redirect, then in again with the password and the next code.
  await page.goto("/");
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(`${APP_BASE_URL}/login`);
  const signIn = page.locator("form", { has: page.getByRole("heading", { name: "Sign in" }) });
  await signIn.getByLabel("Email").fill(owner.email);
  await signIn.getByLabel("Password").fill(owner.password);
  await signIn.getByRole("button", { name: "Sign in" }).click();
  // A code of the next step is taken at once: a later step than the last used, inside the drift window.
  await page.getByLabel("Code").fill(totp(owner.mfaKey, new Date(Date.now() + 30_000)));
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: `${organizationName} (OWNER)` })).toBeVisible();

  // 8. The production page policy on the sign-in page and on a 404, with the answer's nonce on every script: a 404
  // renders per request (ADR-0188). Then the browser opens both, under the guard, and Next.js's scripts run.
  for (const [address, status] of [["/login", 200], ["/no-such-page", 404]] as const) {
    const asked = await page.request.get(address);
    const policy = asked.headers()["content-security-policy"] ?? "";
    const nonce = /'nonce-([^']+)'/.exec(policy)?.[1] ?? "";
    expect([asked.status(), policy]).toEqual([status, productionPagePolicy(nonce)]);
    expect(asked.headers()["reporting-endpoints"]).toBe('csp="/api/csp-report"');
    const scripts = (await asked.text()).match(/<script\b[^>]*>/g) ?? [];
    expect(scripts.length).toBeGreaterThan(0);
    for (const script of scripts) expect(script).toContain(` nonce="${nonce}"`);
    expect((await page.goto(address))?.status()).toBe(status);
    // The client router started: Next.js's inline scripts ran and loaded its chunks, which `/_next/static` sends with
    // the API policy (ADR-0188 Decision 4). That a browser applies no policy to a script it loads is inference; this
    // poll proves the chunks ran under that header.
    await expect
      .poll(() => page.evaluate(() => typeof (globalThis as { next?: { version?: unknown } }).next?.version))
      .toBe("string");
  }
});
