# ADR-0071 — The AI-generated disclosure layer, and how it reaches a video

Status: Accepted (DS-1, 2026-10-20). DS-1 builds layer v1: the table, the
committed images and the renderer (Decisions 1 to 5). Decisions 6 and 7 describe
how the later DS pull requests put it into a video; none of that is built yet.
Implements: ADR-0052 Decision 8, Mode A:

- *exact text 「本コンテンツは生成AIを使用して作成しています。」*;
- *shown throughout the entire video, bottom-right, no background box, white,
  subtle / low-opacity / semi-transparent*;
- *visual target ≈ 1.25% of video height, ≈ 3% right and bottom safe margin,
  position scales correctly for landscape and portrait*.

And ADR-0052 Decision 17, the overlay-free Clean Master, which Decision 7 below
places in composition.

Approved by the product owner on 2026-10-20 as a series of pull requests, Mode A
and the Clean Master first (`/mnt/project-files/cto/disclosure-proposal.md`).

## Context

A delivered video must carry the disclosure its mode requires (ADR-0052
Decisions 3 and 8). No layer draws it today: composition profile v1 says "no
overlay, no watermark, no disclosure burn-in", deliverable validation measures
container, duration, size and streams only, and publication requires nothing of
the frames. The pipeline that would deliver a video is dormant, so the
disclosure can be built into it before anything can deliver a video without it.

Drawing Japanese text needs a font with Japanese glyphs. None is in the
repository, in CI or in a production image, and an FFmpeg `drawtext` filter
would draw whatever the machine's FreeType and HarfBuzz make of whatever font it
finds.

---

## Decision 1 — The disclosure is a committed image, one per frame size

Layer v1 is a closed table of six transparent PNGs, one for each raster
composition profile v1 produces (1280×720, 1920×1080, 720×1280, 1080×1920,
720×720, 1080×1080). Each image is the size of the frame, with the text already
in its place, so it is laid over the video at the origin with no coordinates.

- **Rendered once, by hand**, from the bundled font
  (`pnpm --filter @app/storage render-disclosure-layers`), and committed under
  `assets/disclosure/`.
- **Pinned.** `DISCLOSURE_LAYER_ASSETS` in `@app/domain` holds each file's
  SHA-256; a test reads each committed file and compares.
- **Closed.** A size outside the table has no disclosure image. The composer
  must refuse such a video rather than scale another size's image, as
  composition profile v1 refuses a target it cannot compose.

So what a customer receives does not depend on which fonts or which FFmpeg build
a worker has, a worker needs neither, and the image counsel reviews is byte for
byte the image that ships.

## Decision 2 — What Mode A looks like

| | Layer v1 |
| --- | --- |
| Text | `本コンテンツは生成AIを使用して作成しています。`, 24 characters, one line |
| Place | bottom-right |
| Right margin | 3% of the frame's width, rounded |
| Bottom margin | 3% of the frame's height, rounded |
| Text height | 1.25% of the frame's height, a half rounded up, **and never under 12 pixels** |
| Colour | white at 70% opacity |
| Shadow | black at 60% opacity, offset 1 pixel down and right, softened (blur σ 0.5) |
| Box | none |
| Font | Noto Sans JP Regular |

Per size:

| Frame | Text height | Right margin | Bottom margin |
| --- | --- | --- | --- |
| 1280×720 | 12 (1.25% is 9) | 38 | 22 |
| 1920×1080 | 14 | 58 | 32 |
| 720×1280 | 16 | 22 | 38 |
| 1080×1920 | 24 | 32 | 58 |
| 720×720 | 12 (1.25% is 9) | 22 | 22 |
| 1080×1080 | 14 | 32 | 32 |

**Two additions to ADR-0052's description**, put to the product owner with
sample frames on 2026-10-20:

- **The faint shadow.** White, semi-transparent text with no box disappears on
  a white floor or wall at any size, and a disclosure nobody can read does not
  disclose. The shadow is not a box: it follows the letters, and the frame shows
  through everywhere else.
- **The 12-pixel minimum.** 1.25% of 720 pixels is 9, which renders thin and
  faint. The minimum changes only the 720p landscape and square frames.

The product owner chose both on 2026-10-20, on the decision card, option **C 影あり・最小12px** (a shadow, and 12 pixels at least), over the approved description as written (option A) and a shadow at the approved size (option B).

"Text height" is the height of the rendered line's ink, which for this sentence
is the font's pixel size. Margins are measured to the text, not to its shadow,
which reaches one pixel further.

## Decision 3 — The font

- **Noto Sans JP Regular**, Google Fonts version v57, licensed under the SIL Open
  Font License 1.1 (`assets/disclosure/OFL.txt`). Its reserved font name is
  "Source"; the subset keeps the family name "Noto Sans JP", which is not
  reserved.
- **Taken from npm**, `@expo-google-fonts/noto-sans-jp@0.4.4`, whose tarball
  matched its registry integrity
  (`sha512-1vl2U7uYG5JAXGERZaLMXtfOSgyOU4Qhq30OOPrbAHjOu8AW9Pral/qN9Anta9fjd6eVRTijiNqcgy2TowzrDA==`).
  The original `NotoSansJP_400Regular.ttf` has SHA-256
  `6255ea4692e97ef27330304fb96fd650f9111f868cd585fcf2802d42823930e5`.
- **Cut down** with fontTools 4.67.0 to the sentence's 20 distinct characters
  (38 glyphs), 10 KB instead of 5.7 MB:
  `python3 -m fontTools.subset NotoSansJP_400Regular.ttf --text="本コンテンツは生成AIを使用して作成しています。" --name-IDs='*' --layout-features='*' --output-file=NotoSansJP-Regular.disclosure-subset.ttf`.
  The result is reproducible byte for byte (SHA-256
  `64ae008b81bfd23b75f56aba0c73520daf45ea97287b575c5fd398e3beb2556e`) and holds
  every character of the sentence. A test pins it.

The font is needed only to render the images again. No worker reads it.

## Decision 4 — How the committed images are checked

For each of the six images, a test proves that:

- it is the file the domain table pins;
- it is the frame's size, with an alpha channel;
- its ink sits bottom-right within the margins (allowing the shadow's one
  pixel), is at least the text height and at most three pixels taller, and is
  more than twenty times as wide as it is tall, so the whole sentence is there;
- nothing in it is opaque: white pixels are at most 70% opaque, black ones at
  most 60%, and where they overlap at most 88%;
- rendering it again from the bundled font puts the ink in exactly the same
  rectangle, with no pixel's opacity more than 16 out of 255 apart. A different
  text renderer may shade an edge differently; it may not move the text.

## Decision 5 — Nothing draws it yet

DS-1 changes no composition, validation, publication, schema or screen. A test
proves that neither application, the managed-output code, composition,
validation nor the database package reads the layer, and that the renderer is
called only from the command run by hand.

---

## Decision 6 — How it will reach a video (DS-3 to DS-6, not built)

- **The mode is frozen at admission** (ADR-0052 Decision 10), on the generation
  job and on each deliverable version, and bound into the composition's input
  fingerprint. Until Mode B and Mode C are built, admission accepts Mode A only.
- **The image is laid over the video with FFmpeg's `overlay` filter at 0:0**, a
  single still image held for the whole video. Mode B will limit it to the first
  and last two seconds.
- **Publication requires it.** The transaction that publishes a deliverable and
  consumes its Unit will refuse one made without the disclosure of its job's
  frozen mode.

## Decision 7 — The Clean Master comes first (DS-4, DS-5, not built)

Composition will encode the overlay-free Clean Master (ADR-0052 Decision 17),
store it privately and first-wins, then lay the disclosure over the **stored**
master's bytes to make the customer's video. The master is encoded at higher
quality than the deliverable, so the second encode loses nothing visible. Its
storage location is refused by every download path, and it is not counted in the
customer's storage quota.

---

## Consequences

- The look of the disclosure is fixed in six reviewed images, and changing it is
  a new layer version with new images, never an edit in place.
- Production needs no Japanese font and no `drawtext`; the composer needs only
  `overlay`.
- Mode B, Mode C, later mode changes and the logo build on the same overlay and
  the same Clean Master.

Paid Provider Activation, production Provider credentials, production paid AI
calls, production scheduler activation and live Stripe charges remain BLOCKED.
Nothing here touches them.
