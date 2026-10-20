/**
 * Renders the AI-generated disclosure layer v1 for one frame size (ADR-0071).
 *
 * Run by hand to produce the committed images in `assets/disclosure/`, never by
 * a worker: a worker lays the committed image over the video, so what ships
 * cannot depend on the fonts or the text renderer a machine happens to have.
 * The domain table pins each image's SHA-256, and a test proves the committed
 * images still have the geometry the domain describes.
 */

import sharp from "sharp";
import {
  AI_DISCLOSURE_TEXT,
  DISCLOSURE_SHADOW,
  DISCLOSURE_TEXT_OPACITY,
  disclosureLayout,
} from "@app/domain";

/** The family name inside the bundled font file. */
export const DISCLOSURE_FONT_FAMILY = "Noto Sans JP";

/** The bundled subset of Noto Sans JP Regular, relative to the repository root. */
export const DISCLOSURE_FONT_PATH = "assets/disclosure/NotoSansJP-Regular.disclosure-subset.ttf";

/**
 * The font configuration the images are drawn under, relative to the
 * repository root: no installed font, no hinting, no colour fringes
 * (ADR-0071 Decision 3).
 */
export const DISCLOSURE_FONTCONFIG_PATH = "assets/disclosure/fonts.conf";

interface Glyphs {
  readonly data: Buffer;
  readonly width: number;
  readonly height: number;
}

/** The text in one colour on a transparent background, cropped to its ink by the renderer. */
async function glyphs(textHeightPx: number, colour: string, fontFile: string): Promise<Glyphs> {
  const { data, info } = await sharp({
    text: {
      text: `<span foreground="${colour}">${AI_DISCLOSURE_TEXT}</span>`,
      font: `${DISCLOSURE_FONT_FAMILY} ${textHeightPx}px`,
      fontfile: fontFile,
      rgba: true,
    },
  })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

/** A copy of RGBA pixels with every alpha multiplied by `opacity`. */
function withOpacity(pixels: Buffer, opacity: number): Buffer {
  const out = Buffer.from(pixels);
  for (let alpha = 3; alpha < out.length; alpha += 4) {
    out[alpha] = Math.round((out[alpha] ?? 0) * opacity);
  }
  return out;
}

function png(pixels: Buffer, width: number, height: number): Promise<Buffer> {
  return sharp(pixels, { raw: { width, height, channels: 4 } }).png().toBuffer();
}

/**
 * The disclosure layer for a `widthPx` × `heightPx` frame: a transparent PNG of
 * exactly that size, with the text bottom-right as {@link disclosureLayout}
 * places it, white at {@link DISCLOSURE_TEXT_OPACITY}, over its faint shadow.
 */
export async function renderDisclosureLayer(input: {
  readonly widthPx: number;
  readonly heightPx: number;
  readonly fontFile: string;
  /** The absolute path of {@link DISCLOSURE_FONTCONFIG_PATH}. */
  readonly fontConfigFile: string;
}): Promise<Buffer> {
  // Unless told otherwise, fontconfig draws text with the machine's own hinting
  // and sub-pixel settings, and Ubuntu's defaults draw this sentence a pixel
  // narrower and with coloured fringes. It reads FONTCONFIG_FILE once, when the
  // process first draws text, so the caller sets it before then.
  if (process.env.FONTCONFIG_FILE !== input.fontConfigFile) {
    throw new Error(
      `The disclosure is drawn only under its own font configuration: set FONTCONFIG_FILE to ${input.fontConfigFile} before the process draws any text`,
    );
  }

  // Pango reads the text as markup. The text is a constant, but a markup
  // character in it would change what is drawn without failing.
  if (/[<>&]/.test(AI_DISCLOSURE_TEXT)) throw new Error("The disclosure text contains markup");

  const layout = disclosureLayout(input.widthPx, input.heightPx);
  const white = await glyphs(layout.textHeightPx, "#FFFFFF", input.fontFile);
  const black = await glyphs(layout.textHeightPx, "#000000", input.fontFile);

  const textLeft = input.widthPx - layout.rightMarginPx - white.width;
  const textTop = input.heightPx - layout.bottomMarginPx - white.height;
  return sharp({
    create: { width: input.widthPx, height: input.heightPx, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([
      {
        input: await png(withOpacity(black.data, DISCLOSURE_SHADOW.opacity), black.width, black.height),
        left: textLeft + DISCLOSURE_SHADOW.offsetPx,
        top: textTop + DISCLOSURE_SHADOW.offsetPx,
      },
      {
        input: await png(withOpacity(white.data, DISCLOSURE_TEXT_OPACITY), white.width, white.height),
        left: textLeft,
        top: textTop,
      },
    ])
    .png({ compressionLevel: 9 })
    .toBuffer();
}
