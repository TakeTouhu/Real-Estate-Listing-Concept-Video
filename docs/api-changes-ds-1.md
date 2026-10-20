# API Changes — DS-1

The AI-generated disclosure layer v1 (ADR-0071). **No migration, no route, no
page, no environment variable.** Nothing a customer or operator uses changes:
DS-1 adds a table of constants, six committed images and the command that
rendered them.

## Internal API

### Added: `@app/domain` disclosure

| Export | Shape |
| --- | --- |
| `AI_DISCLOSURE_TEXT` | `"本コンテンツは生成AIを使用して作成しています。"`, ADR-0052 Decision 8's exact sentence |
| `DISCLOSURE_LAYER_KEY` | `"vtavision-disclosure:v1"`, the versioned identity of the look |
| `DISCLOSURE_TEXT_HEIGHT_PER_TEN_THOUSAND` | `125`: the text is 1.25% of the frame's height |
| `DISCLOSURE_MIN_TEXT_HEIGHT_PX` | `12`: never smaller |
| `DISCLOSURE_MARGIN_PERCENT` | `3`: right margin of the width, bottom margin of the height |
| `DISCLOSURE_TEXT_OPACITY` | `0.7` |
| `DISCLOSURE_SHADOW` | `{ offsetPx: 1, opacity: 0.6 }`: the same glyphs in black, one pixel down and right |
| `disclosureLayout(widthPx, heightPx)` | `{ textHeightPx, rightMarginPx, bottomMarginPx }`, integer arithmetic, a half rounded up |
| `DISCLOSURE_LAYER_ASSETS` | the six committed images: `{ widthPx, heightPx, fileName, sha256 }`, one per raster composition profile v1 produces |
| `disclosureLayerFor(widthPx, heightPx)` | that size's image, or `null` |
| types `DisclosureLayout`, `DisclosureLayerAsset` | the two shapes above |

Nothing outside the disclosure module and its tests reads them yet.

### Added: `@app/storage` disclosure renderer

| Export | Shape |
| --- | --- |
| `renderDisclosureLayer({ widthPx, heightPx, fontFile })` | a `Promise<Buffer>`: a transparent PNG of exactly that size, the text placed by `disclosureLayout`, white at 70% over its shadow |
| `DISCLOSURE_FONT_FAMILY` | `"VTaVision Disclosure"`, the bundled font's own family name, which no installed font shares |
| `DISCLOSURE_FONT_PATH` | `"assets/disclosure/NotoSansJP-Regular.disclosure-subset.ttf"`, relative to the repository root |

Called only by the command below; a shape test pins that.

## Commands

### Added: `pnpm --filter @app/storage render-disclosure-layers`

Writes the six `assets/disclosure/layer-v1-WxH.png` images from the bundled
font and prints each file's SHA-256. It takes no options, reads no database
and needs no environment variable. It is run by hand only when the look is
deliberately changed, which makes a layer v2.

`@app/storage` gains `tsx` 4.23.1 as a development dependency, the same version
`apps/ops` already uses, to run it.

## Files

### Added: `assets/disclosure/`

| File | What it is |
| --- | --- |
| `layer-v1-1280x720.png`, `layer-v1-1920x1080.png`, `layer-v1-720x1280.png`, `layer-v1-1080x1920.png`, `layer-v1-720x720.png`, `layer-v1-1080x1080.png` | the disclosure layer v1, one per frame size, each pinned by SHA-256 in `DISCLOSURE_LAYER_ASSETS` |
| `NotoSansJP-Regular.disclosure-subset.ttf` | Noto Sans JP Regular cut down to the sentence's characters and renamed to the family "VTaVision Disclosure", 10 KB |
| `OFL.txt` | the font's SIL Open Font License 1.1 |
| `README.md` | where the font came from, how it was cut down, how the images are rendered, and that they are never edited in place |
