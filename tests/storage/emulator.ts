import { randomBytes } from "node:crypto";

/**
 * The Cloud Storage emulator the `test:gcs` suites speak to (ADR-0156): its
 * origin, from `GOOGLE_CLOUD_STORAGE_TEST_ENDPOINT`. A run without it fails,
 * and only this machine is accepted; the adapter sends no request through a
 * proxy and no token to any store but Google's, so no suite can reach a real
 * store.
 */
export function emulatorEndpoint(): string {
  const raw = process.env.GOOGLE_CLOUD_STORAGE_TEST_ENDPOINT;
  if (raw === undefined || raw === "") {
    throw new Error("Set GOOGLE_CLOUD_STORAGE_TEST_ENDPOINT to the emulator's origin, e.g. http://127.0.0.1:4443");
  }
  const url = new URL(raw);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    throw new Error("GOOGLE_CLOUD_STORAGE_TEST_ENDPOINT must be an http origin on this machine");
  }
  return url.origin;
}

/** A bucket no other run uses, created in the emulator. */
export async function createEmulatorBucket(endpoint: string): Promise<string> {
  const name = `vtavision-test-${randomBytes(6).toString("hex")}`;
  const response = await fetch(`${endpoint}/storage/v1/b?project=vtavision-test`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (response.status !== 200) throw new Error(`The emulator did not create a bucket (${response.status})`);
  return name;
}

/** Every object name in the bucket, read straight from the emulator. */
export async function emulatorObjectNames(endpoint: string, bucket: string): Promise<string[]> {
  const response = await fetch(`${endpoint}/storage/v1/b/${bucket}/o`);
  if (response.status !== 200) throw new Error(`The emulator did not list a bucket (${response.status})`);
  const body = (await response.json()) as { readonly items?: ReadonlyArray<{ readonly name: string }> };
  return (body.items ?? []).map((item) => item.name).sort();
}
