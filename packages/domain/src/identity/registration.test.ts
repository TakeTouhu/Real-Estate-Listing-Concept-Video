import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestDeps, type TestDeps } from "../testing/in-memory";
import { AuthService } from "./auth-service";

/**
 * Registering an account is one transaction (ADR-0130): the user, its password
 * and `user.registered` are written together or not at all, and an email two
 * sign-ups ask for at once goes to one of them.
 */

const PASSWORD = "password-123456";
const REPO_ROOT = resolve(__dirname, "../../../..");

function setup() {
  const deps: TestDeps = createTestDeps();
  return { deps, auth: new AuthService(deps, { sessionTtlSeconds: 3600 }) };
}

const register = (auth: AuthService, email = "new@example.com", name = "New") =>
  auth.register({ email, name, password: PASSWORD });

afterEach(() => {
  vi.restoreAllMocks();
});

describe("registering an account", () => {
  it("writes the user, its password and one audit entry together", async () => {
    const { deps, auth } = setup();
    const user = await register(auth);
    expect(deps.repos.users.peek(user.id)).toEqual(user);
    expect(user).toMatchObject({ email: "new@example.com", name: "New", status: "ACTIVE", emailVerifiedAt: null });
    const credential = await deps.repos.credentials.findByUserId(user.id);
    expect(await deps.passwords.verify(PASSWORD, credential!.passwordHash)).toBe(true);
    expect(deps.repos.auditLogs.all()).toEqual([
      expect.objectContaining({
        organizationId: null,
        actorUserId: user.id,
        action: "user.registered",
        resourceType: "user",
        resourceId: user.id,
        metadata: { email: "new@example.com" },
      }),
    ]);
  });

  it("gives an email asked for twice at once to one sign-up, and tells the other it is taken", async () => {
    const { deps, auth } = setup();
    const outcomes = await Promise.allSettled([
      register(auth, "same@example.com", "A"),
      register(auth, "SAME@example.com", "B"),
    ]);
    expect(outcomes.map((o) => o.status).sort()).toEqual(["fulfilled", "rejected"]);
    const refused = outcomes.find((o) => o.status === "rejected") as PromiseRejectedResult;
    expect(refused.reason).toMatchObject({ code: "VALIDATION_FAILED", message: "Email is already registered" });
    const created = (outcomes.find((o) => o.status === "fulfilled") as PromiseFulfilledResult<{ id: string }>).value;
    expect(await deps.repos.users.findByEmail("same@example.com")).toMatchObject({ id: created.id });
    expect(deps.repos.auditLogs.all()).toHaveLength(1);
  });

  it("writes nothing when its audit entry cannot be appended, so the email can register again", async () => {
    const { deps, auth } = setup();
    vi.spyOn(deps.repos.auditLogs, "append").mockRejectedValueOnce(new Error("audit store down"));
    await expect(register(auth)).rejects.toThrow("audit store down");
    expect(await deps.repos.users.findByEmail("new@example.com")).toBeNull();
    expect(await deps.repos.credentials.findByUserId("usr_1")).toBeNull();
    expect(deps.repos.auditLogs.all()).toEqual([]);

    const user = await register(auth);
    expect(await deps.repos.credentials.findByUserId(user.id)).not.toBeNull();
  });

  it("hashes no password for an email already registered", async () => {
    const { deps, auth } = setup();
    await register(auth);
    const hash = vi.spyOn(deps.passwords, "hash");
    await expect(register(auth, "new@example.com", "Again")).rejects.toMatchObject({
      message: "Email is already registered",
    });
    expect(hash).not.toHaveBeenCalled();
  });
});

describe("the in-memory registration", () => {
  const input = (id: string, email: string) => ({
    user: { id, email, name: "N", status: "ACTIVE" as const },
    passwordHash: "hash",
    audit: {
      organizationId: null,
      actorUserId: id,
      action: "user.registered",
      resourceType: "user",
      resourceId: id,
      metadata: {},
    },
  });

  it("refuses a taken identifier and answers EMAIL_TAKEN for a taken email, writing nothing", async () => {
    const { deps } = setup();
    expect(await deps.repos.users.register(input("usr_a", "a@example.com"))).toMatchObject({ outcome: "CREATED" });
    await expect(deps.repos.users.register(input("usr_a", "b@example.com"))).rejects.toThrow("Unique constraint");
    expect(await deps.repos.users.register(input("usr_b", "a@example.com"))).toEqual({ outcome: "EMAIL_TAKEN" });
    expect(await deps.repos.users.findByEmail("b@example.com")).toBeNull();
    expect(await deps.repos.credentials.findByUserId("usr_b")).toBeNull();
    expect(deps.repos.auditLogs.all()).toHaveLength(1);
  });
});

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === "node_modules" || name === ".next" || name === "dist") return [];
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

describe("where accounts are written", () => {
  it("creates users and passwords only in the registration transaction, once each", () => {
    const writes = ["apps", "packages"]
      .flatMap((dir) => sourceFiles(join(REPO_ROOT, dir)))
      .flatMap((file) =>
        [...readFileSync(file, "utf8").matchAll(/\.(user|credential)\.(create\w*|upsert)\(/g)].map(
          (match) => `${file.slice(REPO_ROOT.length + 1)} ${match[0]}`,
        ),
      );
    expect(writes).toEqual([
      "packages/database/src/repositories.ts .user.create(",
      "packages/database/src/repositories.ts .credential.create(",
    ]);
  });
});
