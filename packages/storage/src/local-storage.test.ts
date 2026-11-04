import { describe, expect, it } from "vitest";
import type { ObjectRead } from "@app/domain";
import { LocalObjectStorage } from "./local-storage";

/**
 * The in-memory store's streamed read (ADR-0115): the same answers as every
 * store gives, so the routes it backs in tests behave as over a real one.
 */

async function bytesOf(read: ObjectRead): Promise<Uint8Array> {
  if (read.kind !== "READ") throw new Error(`expected a read, got ${read.kind}`);
  return new Uint8Array(await new Response(read.body).arrayBuffer());
}

const KEY = "org/org_1/deliverables/gdv_1/output";

describe("the in-memory store's streamed read", () => {
  it("reads nothing where nothing is stored", async () => {
    const storage = new LocalObjectStorage({ secret: "s" });
    expect(await storage.readObject(KEY, null)).toEqual({ kind: "ABSENT" });
  });

  it("reads the whole object or a range of it, with the object's size", async () => {
    const storage = new LocalObjectStorage({ secret: "s" });
    await storage.putObject(KEY, new Uint8Array([0, 1, 2, 3, 4, 5]));
    const whole = await storage.readObject(KEY, null);
    expect(whole).toMatchObject({ kind: "READ", size: 6, start: 0, length: 6 });
    expect(await bytesOf(whole)).toEqual(new Uint8Array([0, 1, 2, 3, 4, 5]));
    const range = await storage.readObject(KEY, { kind: "FROM", start: 1, end: 2 });
    expect(range).toMatchObject({ kind: "READ", size: 6, start: 1, length: 2 });
    expect(await bytesOf(range)).toEqual(new Uint8Array([1, 2]));
    expect(await bytesOf(await storage.readObject(KEY, { kind: "LAST", length: 1 }))).toEqual(new Uint8Array([5]));
  });

  it("answers a range past the end with the object's size", async () => {
    const storage = new LocalObjectStorage({ secret: "s" });
    await storage.putObject(KEY, new Uint8Array([1]));
    expect(await storage.readObject(KEY, { kind: "FROM", start: 1, end: null })).toEqual({
      kind: "UNSATISFIABLE",
      size: 1,
    });
  });

  it("reads an empty object as empty, and keeps sending what it read when the key is written again", async () => {
    const storage = new LocalObjectStorage({ secret: "s" });
    await storage.putObject(KEY, new Uint8Array([]));
    expect(await bytesOf(await storage.readObject(KEY, null))).toEqual(new Uint8Array([]));
    await storage.putObject(KEY, new Uint8Array([1, 2]));
    const read = await storage.readObject(KEY, null);
    await storage.putObject(KEY, new Uint8Array([9, 9]));
    expect(await bytesOf(read)).toEqual(new Uint8Array([1, 2]));
  });
});
