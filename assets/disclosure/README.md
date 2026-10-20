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
Fonts v57) cut down to the characters of the sentence and renamed to the family
"VTaVision Disclosure". It is licensed under the SIL Open Font License 1.1, in
`OFL.txt`; its reserved font name is "Source", which the file does not use.

The family is renamed because fontconfig prefers an installed font of the name
asked for over the file the renderer hands it: on a machine with its own "Noto
Sans JP", the images would be drawn in that font instead.

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
- Renamed, in the name table only, with the same fontTools:

  ```bash
  python3 -I - NotoSansJP-Regular.disclosure-subset.ttf <<'EOF'
  import sys
  from fontTools.ttLib import TTFont
  NAMES = {
      1: "VTaVision Disclosure",
      3: "2.004-H2;VTaVision;VTaVisionDisclosure-Regular",
      4: "VTaVision Disclosure Regular",
      6: "VTaVisionDisclosure-Regular",
      25: "VTaVisionDisclosure",
  }
  font = TTFont(sys.argv[1], recalcTimestamp=False)
  for record in font["name"].names:
      if record.nameID in NAMES:
          record.string = NAMES[record.nameID]
  font.save(sys.argv[1])
  EOF
  ```

  The output is reproducible: SHA-256
  `73f51ed1f4a54fb9d4bf19ed63071c7e53ef2066cd3aa6c1dc56ed4a78c6ad1e`, the file
  committed here.

No worker reads the font. It is kept so the images can be rendered again.

## Rendering the images

```bash
pnpm --filter @app/storage render-disclosure-layers
```

writes the six images here and prints each file's SHA-256 for the domain table.
