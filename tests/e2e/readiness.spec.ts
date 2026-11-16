import { expect, test } from "@playwright/test";
import { e2eEnvironment } from "./support/environment";

/**
 * Readiness asks the database and the object storage to answer (RD-2,
 * ADR-0151 Decision 4): here the browser test's own PostgreSQL database and
 * shared folder, behind the operator's token.
 */
test("the readiness probe finds the database and the storage answering", async ({ request }) => {
  const token = e2eEnvironment().HEALTHCHECK_API_TOKEN;
  expect((await request.get("/api/health/ready")).status()).toBe(401);

  const response = await request.get("/api/health/ready", { headers: { authorization: `Bearer ${token}` } });
  expect(response.status()).toBe(200);
  expect(await response.json()).toMatchObject({
    status: "ready",
    checks: expect.arrayContaining([
      { name: "database", ok: true, detail: "answers" },
      { name: "storage", ok: true, detail: "adapter=shared-folder, answers" },
    ]),
  });
});
