import sharp from "sharp";
import type { ImageProcessor, ProcessedImage } from "@app/domain";

export interface SharpImageProcessorOptions {
  readonly maxLongEdgePx?: number;
  readonly thumbnailPx?: number;
  readonly jpegQuality?: number;
}

const DEFAULTS = { maxLongEdgePx: 2560, thumbnailPx: 400, jpegQuality: 85 } as const;

/**
 * Compute a 64-bit average-hash (aHash) from an 8x8 greyscale reduction and
 * return it as 16 hex characters. Robust enough for the duplicate-detection
 * foundation; a DCT-based pHash can replace it behind this same interface.
 */
export async function averageHashHex(data: Uint8Array): Promise<string> {
  const raw = await sharp(Buffer.from(data))
    .greyscale()
    .resize(8, 8, { fit: "fill" })
    .raw()
    .toBuffer();
  let total = 0;
  for (const byte of raw) total += byte;
  const mean = total / raw.length;
  let hex = "";
  for (let nibble = 0; nibble < 16; nibble += 1) {
    let value = 0;
    for (let bit = 0; bit < 4; bit += 1) {
      const pixel = raw[nibble * 4 + bit] ?? 0;
      value = (value << 1) | (pixel >= mean ? 1 : 0);
    }
    hex += value.toString(16);
  }
  return hex;
}

/**
 * sharp-backed image pipeline. `rotate()` with no argument applies the EXIF
 * orientation and, together with re-encoding, drops all EXIF/GPS metadata —
 * satisfying "strip sensitive EXIF and GPS metadata from processing copies".
 */
export class SharpImageProcessor implements ImageProcessor {
  private readonly options: Required<SharpImageProcessorOptions>;

  constructor(options: SharpImageProcessorOptions = {}) {
    this.options = { ...DEFAULTS, ...options };
  }

  async process(data: Uint8Array): Promise<ProcessedImage> {
    const input = Buffer.from(data);
    // withMetadata() is deliberately NOT called: metadata must not be carried over.
    const normalizedPipeline = sharp(input)
      .rotate()
      .resize({
        width: this.options.maxLongEdgePx,
        height: this.options.maxLongEdgePx,
        fit: "inside",
        withoutEnlargement: true,
      })
      .jpeg({ quality: this.options.jpegQuality, mozjpeg: true });

    const normalized = await normalizedPipeline.toBuffer();
    const meta = await sharp(normalized).metadata();
    if (!meta.width || !meta.height) {
      throw new Error("could not determine image dimensions");
    }

    const thumbnail = await sharp(normalized)
      .resize(this.options.thumbnailPx, this.options.thumbnailPx, {
        fit: "inside",
        withoutEnlargement: true,
      })
      .webp({ quality: 80 })
      .toBuffer();

    return {
      normalized: new Uint8Array(normalized),
      normalizedMimeType: "image/jpeg",
      thumbnail: new Uint8Array(thumbnail),
      thumbnailMimeType: "image/webp",
      width: meta.width,
      height: meta.height,
      perceptualHash: await averageHashHex(new Uint8Array(normalized)),
    };
  }
}
