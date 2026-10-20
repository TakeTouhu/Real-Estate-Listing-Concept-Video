# AI-generated disclosure, layer v1

The images a delivered video's AI-generated disclosure is drawn from
(ADR-0071, implementing ADR-0052 Decision 8, Mode A). Each `layer-v1-WxH.png`
is a transparent image the size of the frame, with
「本コンテンツは生成AIを使用して作成しています。」 bottom-right, white at 70%
over a faint shadow. The SHA-256 of each is pinned in `@app/domain`
(`DISCLOSURE_LAYER_ASSETS`).

**Do not edit or re-render these files in place.** A different look is layer v2:
new file names, new checksums, a new ADR.

## The font

`NotoSansJP-Regular.disclosure-subset.ttf` is Noto Sans JP Regular (Google
Fonts v57) cut down to the characters of the sentence. It is licensed under the
SIL Open Font License 1.1, in `OFL.txt`; its reserved font name is "Source",
which the subset does not use.

- Source: npm `@expo-google-fonts/noto-sans-jp@0.4.4`, tarball integrity
  `sha512-1vl2U7uYG5JAXGERZaLMXtfOSgyOU4Qhq30OOPrbAHjOu8AW9Pral/qN9Anta9fjd6eVRTijiNqcgy2TowzrDA==`,
  file `400Regular/NotoSansJP_400Regular.ttf`, SHA-256
  `6255ea4692e97ef27330304fb96fd650f9111f868cd585fcf2802d42823930e5`.
- Cut down with fontTools 4.67.0:

  ```bash
  python3 -m fontTools.subset NotoSansJP_400Regular.ttf \
    --text="本コンテンツは生成AIを使用して作成しています。" \
    --name-IDs='*' --layout-features='*' \
    --output-file=NotoSansJP-Regular.disclosure-subset.ttf
  ```

  The output is reproducible: SHA-256
  `64ae008b81bfd23b75f56aba0c73520daf45ea97287b575c5fd398e3beb2556e`.

## The font configuration

`fonts.conf` is the fontconfig file the images are drawn under. It loads no
installed font and assigns anti-aliasing with no hinting and no sub-pixel
colour. Without it, a machine draws the text with its own settings: stock
Ubuntu's draw the sentence a pixel narrower, with coloured fringes.

No worker reads the font or its configuration. They are kept so the images can
be rendered again.

## Rendering the images

```bash
pnpm --filter @app/storage render-disclosure-layers --out <directory>
```

renders the six images into `<directory>`, under `fonts.conf`, and prints each
file's SHA-256 and whether it is the committed image. It never writes here.
