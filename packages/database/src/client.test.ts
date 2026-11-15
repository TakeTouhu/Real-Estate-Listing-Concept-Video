import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * A process makes one PrismaClient, however many times its module is
 * evaluated: `next dev` evaluates server modules again on each compile, and a
 * client per evaluation would keep its own connections open. Making a client
 * opens no connection.
 */
afterEach(() => {
  delete (globalThis as { appPrismaClient?: unknown }).appPrismaClient;
});

describe("the process's PrismaClient", () => {
  it("is made once, and kept when the module is evaluated again", async () => {
    const first = (await import("./client")).getPrismaClient();
    expect((await import("./client")).getPrismaClient()).toBe(first);
    vi.resetModules();
    expect((await import("./client")).getPrismaClient()).toBe(first);
  });
});
