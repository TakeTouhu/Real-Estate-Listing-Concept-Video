import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * What DS-4 may and may not have changed (ADR-0074).
 *
 * 1. **One migration, the newest**: one table, its unique index and foreign
 *    key, and two CHECKs. No existing row is touched.
 * 2. **A receipt and nothing else**, required in every column, RESTRICT to its
 *    version, with no default but its creation time.
 * 3. **Nothing writes or reads it yet.** Composition does from DS-5; no app
 *    mentions it.
 * 4. **No signed URL reaches it.** The one signer refuses an internal key, the
 *    one verifier ignores a token for one, the only signed-URL implementation
 *    goes through them, and the only route serving bytes reads a verified key.
 */

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const MIGRATIONS = join(REPO_ROOT, "packages", "database", "prisma", "migrations");
const MIGRATION_DIR = "00000000000030_clean_master_record";
const SIGNING = "packages/storage/src/signing.ts";
const LOCAL_STORAGE = "packages/storage/src/local-storage.ts";
const DOWNLOAD_ROUTE = "apps/web/src/app/api/storage/download/route.ts";

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
  it("adds exactly one migration, the newest", () => {
    const dirs = readdirSync(MIGRATIONS, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(dirs.at(-1)).toBe(MIGRATION_DIR);
    expect(dirs).toHaveLength(31);
  });

  it("creates one table, its key and its two checks, and touches no existing row", () => {
    expect(statements()).toEqual([
      `CREATE TABLE "generation_deliverable_clean_masters" ( "id" TEXT NOT NULL, "deliverableVersionId" TEXT NOT NULL, "storageKey" TEXT NOT NULL, "sha256" TEXT NOT NULL, "sizeBytes" BIGINT NOT NULL, "verifiedAt" TIMESTAMP(3) NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "generation_deliverable_clean_masters_pkey" PRIMARY KEY ("id") )`,
      `CREATE UNIQUE INDEX "generation_deliverable_clean_masters_deliverableVersionId_key" ON "generation_deliverable_clean_masters"("deliverableVersionId")`,
      `ALTER TABLE "generation_deliverable_clean_masters" ADD CONSTRAINT "generation_deliverable_clean_masters_deliverableVersionId_fkey" FOREIGN KEY ("deliverableVersionId") REFERENCES "generation_deliverable_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE`,
      `ALTER TABLE "generation_deliverable_clean_masters" ADD CONSTRAINT "deliverable_clean_master_key_check" CHECK ( split_part("storageKey", '/', 2) <> '' AND "storageKey" = 'org/' || split_part("storageKey", '/', 2) || '/internal/clean-masters/' || "deliverableVersionId" )`,
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

  it("is written and read by nothing yet", () => {
    // DS-5's composition is the first writer; until then no repository, worker
    // or app names the table, the model or the key.
    expect(
      matching(["packages", "apps"], /generationDeliverableCleanMaster|generation_deliverable_clean_masters|cleanMaster\b/),
    ).toEqual([]);
    expect(matching(["packages", "apps"], /managedCleanMasterKey|ManagedCleanMasterKey/)).toEqual([
      "packages/domain/src/clean-master/index.ts",
      "packages/domain/src/clean-master/key.ts",
    ]);
  });

  it("is refused by the one signer and the one verifier", () => {
    const signing = read(SIGNING);
    const sign = signing.slice(signing.indexOf("export function signStorageToken("), signing.indexOf("export function verifyStorageToken("));
    // The refusal is the signer's first statement, before anything is signed.
    expect(sign.indexOf("assertSignableStorageKey(token.key);")).toBeGreaterThan(-1);
    expect(sign.indexOf("assertSignableStorageKey(token.key);")).toBeLessThan(sign.indexOf("payloadOf(token)"));
    const verify = signing.slice(signing.indexOf("export function verifyStorageToken("));
    const refusal = verify.indexOf("if (isInternalStorageKey(key)) return null;");
    expect(refusal).toBeGreaterThan(-1);
    expect(refusal).toBeLessThan(verify.indexOf("return { key, purpose, expiresAtSeconds };"));
  });

  it("is reachable through no other signed URL or byte-serving route", () => {
    // Every signed-URL implementation outside tests is the local adapter's, and
    // it signs through the guarded signer.
    expect(
      matching(["packages", "apps"], /\bcreateSigned(?:Download|Upload)Url\([^)]*\)[^;{]*\{/),
    ).toEqual([LOCAL_STORAGE]);
    const local = read(LOCAL_STORAGE);
    expect(local.match(/signStorageToken\(/g)).toHaveLength(1);
    expect(local.match(/this\.signedUrl\(key, "(?:upload|download)", ttlSeconds\)/g)).toHaveLength(2);
    // The only app code that reads object bytes is the download route, and it
    // reads the key a verified token named.
    expect(matching(["apps"], /\.getObject\(/)).toEqual([DOWNLOAD_ROUTE]);
    const route = read(DOWNLOAD_ROUTE);
    expect(route.match(/\.getObject\([^)]*\)/g)).toEqual([".getObject(verified.key)"]);
    expect(route).toContain(`verifyStorageToken(token, getServerEnv().STORAGE_SIGNING_SECRET, "download")`);
  });
});
