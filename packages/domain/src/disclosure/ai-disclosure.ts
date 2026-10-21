/**
 * The AI-generated disclosure, layer v1 (ADR-0071, implementing ADR-0052
 * Decision 8) — the exact text, how large and where Mode A draws it, and the
 * pre-rendered image for every size a video is composed at.
 *
 * ## A closed table of images, not text drawn at encode time
 *
 * The disclosure reaches a video as a transparent PNG the size of the frame,
 * laid over it at the origin. The images are rendered once, from a pinned font,
 * and committed with their SHA-256 below, so what a customer receives does not
 * depend on which fonts or which FFmpeg build a worker happens to have, and the
 * image counsel reviews is byte for byte the image that ships.
 *
 * ## Two additions to ADR-0052's description (the product owner, 2026-10-20; ADR-0071 Decision 2)
 *
 * White, semi-transparent text with no box disappears on a white floor or wall,
 * at any size. Layer v1 adds a faint dark shadow, offset one pixel down and to
 * the right, which is not a box. And the text is never smaller than 12 pixels:
 * 1.25% of the height is 9 pixels in a 720p landscape or square video, too
 * small to read. Every other size is exactly 1.25%.
 *
 * Nothing here draws anything; this is the table the renderer and the composer
 * read (ADR-0071, ADR-0075). No composition runs the composer's disclosure yet.
 */

/** The exact disclosure text (ADR-0052 Decision 8). Never paraphrased, never translated. */
export const AI_DISCLOSURE_TEXT = "本コンテンツは生成AIを使用して作成しています。";

/** The versioned identity of how the disclosure looks. A change to any value below is v2. */
export const DISCLOSURE_LAYER_KEY = "vtavision-disclosure:v1";

/** The text's height, as parts per ten thousand of the frame's height: 1.25%. */
export const DISCLOSURE_TEXT_HEIGHT_PER_TEN_THOUSAND = 125;

/** The smallest text height drawn, whatever the frame (ADR-0071 Decision 2). */
export const DISCLOSURE_MIN_TEXT_HEIGHT_PX = 12;

/** The right margin as a percentage of the width, and the bottom margin of the height: 3%. */
export const DISCLOSURE_MARGIN_PERCENT = 3;

/** The text is white at this opacity. Nothing in the layer is opaque. */
export const DISCLOSURE_TEXT_OPACITY = 0.7;

/** The faint shadow under the text: the same glyphs in black, offset down and right, at this opacity. */
export const DISCLOSURE_SHADOW = { offsetPx: 1, opacity: 0.6 } as const;

/** Where and how large the text sits in one frame size. */
export interface DisclosureLayout {
  /** The height of the text's ink, in pixels. */
  readonly textHeightPx: number;
  /** From the right edge of the frame to the right edge of the text. */
  readonly rightMarginPx: number;
  /** From the bottom edge of the frame to the bottom edge of the text. */
  readonly bottomMarginPx: number;
}

/**
 * Mode A's geometry for a frame: bottom-right, 3% in from each of those edges,
 * the text 1.25% of the height and never under 12 pixels. Margins scale with
 * their own axis, so a portrait frame keeps them in proportion too.
 *
 * Integer arithmetic, so `1080 × 1.25%` is exactly 13.5 and rounds to 14, not
 * whatever a binary fraction of 0.0125 makes of it.
 */
export function disclosureLayout(widthPx: number, heightPx: number): DisclosureLayout {
  return {
    textHeightPx: Math.max(
      DISCLOSURE_MIN_TEXT_HEIGHT_PX,
      Math.round((heightPx * DISCLOSURE_TEXT_HEIGHT_PER_TEN_THOUSAND) / 10_000),
    ),
    rightMarginPx: Math.round((widthPx * DISCLOSURE_MARGIN_PERCENT) / 100),
    bottomMarginPx: Math.round((heightPx * DISCLOSURE_MARGIN_PERCENT) / 100),
  };
}

/** One committed disclosure image, in `assets/disclosure/`. */
export interface DisclosureLayerAsset {
  readonly widthPx: number;
  readonly heightPx: number;
  readonly fileName: string;
  /** Lowercase hex SHA-256 of the committed file. */
  readonly sha256: string;
}

/**
 * The six images, one per raster composition profile v1 can produce. A size
 * outside this table has no disclosure image, and a video of that size cannot
 * be given one: the composer must refuse it rather than scale another size's.
 */
export const DISCLOSURE_LAYER_ASSETS: readonly DisclosureLayerAsset[] = [
  {
    widthPx: 1280,
    heightPx: 720,
    fileName: "layer-v1-1280x720.png",
    sha256: "a9292dd3e06d43857407985db0ae118aeb149a6f84e487385c1152645cbc97c9",
  },
  {
    widthPx: 1920,
    heightPx: 1080,
    fileName: "layer-v1-1920x1080.png",
    sha256: "bedb07488128c25a99843451e514d4d145c376d7b61791c4ea40ce61a5ff6044",
  },
  {
    widthPx: 720,
    heightPx: 1280,
    fileName: "layer-v1-720x1280.png",
    sha256: "fbc4c10b77e671e8fc49b820c38cac95e455096268d5ba0f870a894eb6539109",
  },
  {
    widthPx: 1080,
    heightPx: 1920,
    fileName: "layer-v1-1080x1920.png",
    sha256: "c1a6ccd99201304fdd0b6c9a314780e9e48dbc3b067efe5cfc34e3c7ba5b833d",
  },
  {
    widthPx: 720,
    heightPx: 720,
    fileName: "layer-v1-720x720.png",
    sha256: "0b503b175945c2362e3f055f23f212259d423a0a9fe760f7879ffede8a86a297",
  },
  {
    widthPx: 1080,
    heightPx: 1080,
    fileName: "layer-v1-1080x1080.png",
    sha256: "933ef167451c249b58e2e891dbf8492d355465a6eee71d9da9d7b3cf4bb384bb",
  },
];

/** The disclosure image for a frame size, or `null` when layer v1 has none. */
export function disclosureLayerFor(widthPx: number, heightPx: number): DisclosureLayerAsset | null {
  return DISCLOSURE_LAYER_ASSETS.find((one) => one.widthPx === widthPx && one.heightPx === heightPx) ?? null;
}
