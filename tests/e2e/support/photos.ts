import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

/**
 * Photos for the browser test to upload (GS-13a, ADR-0121): three different
 * 1280×720 JPEGs, drawn by FFmpeg from its own test patterns, so no customer
 * photo is ever used and nothing binary is committed.
 */

const run = promisify(execFile);

const PATTERNS = ["testsrc2", "smptebars", "mandelbrot"] as const;

/** Writes the photos into `dir`; their paths, named `room-1.jpg` onwards. */
export async function makePhotos(dir: string): Promise<string[]> {
  return Promise.all(
    PATTERNS.map(async (pattern, index) => {
      const path = join(dir, `room-${index + 1}.jpg`);
      await run("ffmpeg", [
        ...["-nostdin", "-y", "-v", "error", "-f", "lavfi", "-i", `${pattern}=size=1280x720`],
        ...["-frames:v", "1", "-update", "1", path],
      ]);
      return path;
    }),
  );
}
