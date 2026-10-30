import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * What DS-4 may and may not have changed (ADR-0074).
 *
 * 1. **One migration, migration 30**: one table, its unique index and foreign
 *    key, and two CHECKs. No existing row is touched.
 * 2. **A receipt and nothing else**, required in every column, RESTRICT to its
 *    version, with no default but its creation time.
 * 3. **Only Transaction J2 writes it** (DS-5b-2a, ADR-0077), and only J2 and
 *    Transaction G read it (DS-6a, ADR-0080); no app mentions it.
 * 4. **No signed URL reaches it.** The behaviour tests prove the signer, the
 *    verifier and the local adapter refuse it; this pins that there is no other
 *    signer, verifier, signed-URL implementation or presigner, and that the only
 *    route serving bytes reads a verified key.
 */

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const MIGRATIONS = join(REPO_ROOT, "packages", "database", "prisma", "migrations");
const MIGRATION_DIR = "00000000000030_clean_master_record";
const SIGNING = "packages/storage/src/signing.ts";
const LOCAL_STORAGE = "packages/storage/src/local-storage.ts";
const SHARED_FOLDER = "packages/storage/src/shared-folder-storage.ts";
const DOWNLOAD_ROUTE = "apps/web/src/app/api/storage/download/route.ts";
const UPLOAD_ROUTE = "apps/web/src/app/api/storage/upload/route.ts";
/** The test provider's photo reader in the development pipeline (ADR-0106). */
const PHOTO_READER = "apps/worker/src/development-pipeline/photo-reader.ts";

function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === "node_modules" || name === ".next" || name === "dist") return [];
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

const read = (path: string) => code(readFileSync(join(REPO_ROOT, path), "utf8"));

function matching(roots: readonly string[], pattern: RegExp): string[] {
  return roots
    .flatMap((root) => sourceFiles(join(REPO_ROOT, root)))
    .filter((file) => pattern.test(code(readFileSync(file, "utf8"))))
    .map((file) => file.slice(REPO_ROOT.length + 1))
    .sort();
}

function statements(): string[] {
  return readFileSync(join(MIGRATIONS, MIGRATION_DIR, "migration.sql"), "utf8")
    .replace(/--[^\n]*/g, " ")
    .split(";")
    .map((statement) => statement.replace(/\s+/g, " ").trim())
    .filter((statement) => statement.length > 0);
}

function schemaModel(name: string): string[] {
  const schema = readFileSync(join(REPO_ROOT, "packages", "database", "prisma", "schema.prisma"), "utf8");
  const body = new RegExp(`\\nmodel ${name} \\{([\\s\\S]*?)\\n\\}`).exec(schema)?.[1] ?? "";
  return body
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, "").trim().replace(/\s+/g, " "))
    .filter((line) => line.length > 0);
}

describe("DS-4 shape", () => {
  it("adds exactly one migration, in place", () => {
    const dirs = readdirSync(MIGRATIONS, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    // No longer the newest: DS-5b-2a added migration 31 after it, and GS-4b
    // migration 32.
    expect(dirs.indexOf(MIGRATION_DIR)).toBe(30);
    expect(dirs).toHaveLength(33);
  });

  it("creates one table, its key and its two checks, and touches no existing row", () => {
    expect(statements()).toEqual([
      `CREATE TABLE "generation_deliverable_clean_masters" ( "id" TEXT NOT NULL, "deliverableVersionId" TEXT NOT NULL, "storageKey" TEXT NOT NULL, "sha256" TEXT NOT NULL, "sizeBytes" BIGINT NOT NULL, "verifiedAt" TIMESTAMP(3) NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "generation_deliverable_clean_masters_pkey" PRIMARY KEY ("id") )`,
      `CREATE UNIQUE INDEX "generation_deliverable_clean_masters_deliverableVersionId_key" ON "generation_deliverable_clean_masters"("deliverableVersionId")`,
      `ALTER TABLE "generation_deliverable_clean_masters" ADD CONSTRAINT "generation_deliverable_clean_masters_deliverableVersionId_fkey" FOREIGN KEY ("deliverableVersionId") REFERENCES "generation_deliverable_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE`,
      `ALTER TABLE "generation_deliverable_clean_masters" ADD CONSTRAINT "deliverable_clean_master_key_check" CHECK ( btrim(split_part("storageKey", '/', 2)) <> '' AND "storageKey" = 'org/' || split_part("storageKey", '/', 2) || '/internal/clean-masters/' || "deliverableVersionId" )`,
      `ALTER TABLE "generation_deliverable_clean_masters" ADD CONSTRAINT "deliverable_clean_master_receipt_check" CHECK ( "sha256" ~ '^[0-9a-f]{64}$' AND "sizeBytes" > 0 AND "sizeBytes" <= 9007199254740991 )`,
    ]);
  });

  it("is a receipt, required in every column, RESTRICT to its version", () => {
    expect(schemaModel("GenerationDeliverableCleanMaster")).toEqual([
      "id String @id",
      "deliverableVersionId String @unique",
      "storageKey String",
      "sha256 String",
      "sizeBytes BigInt",
      "verifiedAt DateTime",
      "createdAt DateTime @default(now())",
      "deliverableVersion GenerationDeliverableVersion @relation(fields: [deliverableVersionId], references: [id], onDelete: Restrict)",
      '@@map("generation_deliverable_clean_masters")',
    ]);
    expect(
      schemaModel("GenerationDeliverableVersion").filter((line) => line.includes("CleanMaster")),
    ).toEqual(["cleanMaster GenerationDeliverableCleanMaster?"]);
  });

  it("is written only by Transaction J2, and read by J2 and Transaction G", () => {
    // DS-5b-2a (ADR-0077): the composition repository is the one module that
    // writes the table, and the claim is the one place outside the key module
    // that builds a key. The port carries the receipt to it, and the runner,
    // under profile v2, passes the stored master's (ADR-0078). DS-6a
    // (ADR-0080): Transaction G reads the row in its chain query and rebuilds
    // the key to compare. DS-5b-1's master store takes the key's type; no app
    // mentions any of it.
    const REPOSITORY = "packages/database/src/deliverable-composition-execution-repository.ts";
    const VALIDATION = "packages/database/src/deliverable-validation-repository.ts";
    expect(
      matching(["packages", "apps"], /generationDeliverableCleanMaster|generation_deliverable_clean_masters/),
    ).toEqual([REPOSITORY, VALIDATION]);
    // Transaction G only reads: no model call, and the table appears twice,
    // in discovery's filter and as the chain query's join.
    const validation = read(VALIDATION);
    expect(validation).not.toMatch(/generationDeliverableCleanMaster/);
    expect(
      validation.replace(/\s+/g, " ").match(/[^ ]+ [^ ]+ "generation_deliverable_clean_masters"[^=]*= [^ ]+/g),
    ).toEqual([
      `1 FROM "generation_deliverable_clean_masters" m WHERE m."deliverableVersionId" = v."id"`,
      `LEFT JOIN "generation_deliverable_clean_masters" m ON m."deliverableVersionId" = v."id"`,
    ]);
    expect(matching(["packages", "apps"], /cleanMaster\b/)).toEqual([
      REPOSITORY,
      "packages/domain/src/deliverable-composition-execution/ports.ts",
      "packages/domain/src/deliverable-composition-execution/runner.ts",
    ]);
    expect(matching(["packages", "apps"], /managedCleanMasterKey\(/)).toEqual([
      REPOSITORY,
      VALIDATION,
      "packages/domain/src/clean-master/key.ts",
    ]);
    expect(matching(["packages", "apps"], /managedCleanMasterKey|ManagedCleanMasterKey/)).toEqual([
      REPOSITORY,
      VALIDATION,
      "packages/domain/src/clean-master/index.ts",
      "packages/domain/src/clean-master/key.ts",
      "packages/domain/src/deliverable-composition-execution/ports.ts",
      "packages/storage/src/managed-output/clean-master-store.ts",
    ]);
  });

  it("has one signer, one verifier and one signed-URL implementation", () => {
    // The behaviour tests prove these refuse an internal key. What this pins is
    // that there is nothing else: a file that starts naming a signed URL, in
    // any syntax, fails here, and its author must route it through
    // `assertSignableStorageKey` and add it.
    expect(matching(["packages", "apps"], /\bsignStorageToken\b/)).toEqual([SIGNING]);
    // Each store makes its URLs through the one helper that calls the signer.
    expect(matching(["packages", "apps"], /\bsignedStorageUrl\b/)).toEqual([
      LOCAL_STORAGE,
      SHARED_FOLDER,
      SIGNING,
    ]);
    expect(matching(["packages", "apps"], /\bverifyStorageToken\b/)).toEqual([
      DOWNLOAD_ROUTE,
      UPLOAD_ROUTE,
      PHOTO_READER,
      SIGNING,
    ]);
    expect(matching(["packages", "apps"], /\bcreateSigned(?:Download|Upload)Url\b/)).toEqual([
      "packages/domain/src/generation/execution-preflight.ts",
      "packages/domain/src/property/asset-service.ts",
      "packages/domain/src/property/ports.ts",
      LOCAL_STORAGE,
      SHARED_FOLDER,
    ]);
    // No other way to make a URL to a stored object: no presigner, no SAS.
    expect(
      matching(["packages", "apps"], /presign|getSignedUrl|generateBlobSASQueryParameters|generateSasUrl|SharedAccessSignature/i),
    ).toEqual([]);
    for (const manifest of [
      ...readdirSync(join(REPO_ROOT, "packages")).map((name) => `packages/${name}/package.json`),
      ...readdirSync(join(REPO_ROOT, "apps")).map((name) => `apps/${name}/package.json`),
      "package.json",
    ]) {
      const text = readFileSync(join(REPO_ROOT, manifest), "utf8");
      expect(`${manifest}: ${/s3-request-presigner|@azure\/storage-blob|@google-cloud\/storage/.test(text)}`).toBe(
        `${manifest}: false`,
      );
    }
  });

  it("serves stored bytes from one route, for the key a verified token names", () => {
    // And hands them to the test provider from one reader, the same way.
    expect(matching(["apps"], /\.getObject\(/)).toEqual([DOWNLOAD_ROUTE, PHOTO_READER]);
    const route = read(DOWNLOAD_ROUTE);
    expect(route.match(/\.getObject\([^)]*\)/g)).toEqual([".getObject(verified.key)"]);
    expect(route).toContain(`verifyStorageToken(token, getServerEnv().STORAGE_SIGNING_SECRET, "download")`);
    const reader = read(PHOTO_READER);
    expect(reader.match(/\.getObject\([^)]*\)/g)).toEqual([".getObject(verified.key)"]);
    expect(reader).toContain(`verifyStorageToken(token, options.secret, "download")`);
  });
});
