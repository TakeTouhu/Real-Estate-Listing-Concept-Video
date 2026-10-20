/**
 * Writes the AI-generated disclosure layer v1 images into `assets/disclosure/`
 * and prints each file's SHA-256 for the domain table (ADR-0071).
 *
 *   pnpm --filter @app/storage render-disclosure-layers
 *
 * Run only when layer v1's look is deliberately changed, which makes it v2.
 */

import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DISCLOSURE_LAYER_ASSETS } from "@app/domain";
import { DISCLOSURE_FONT_PATH, renderDisclosureLayer } from "../disclosure/index";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));

for (const asset of DISCLOSURE_LAYER_ASSETS) {
  const image = await renderDisclosureLayer({
    widthPx: asset.widthPx,
    heightPx: asset.heightPx,
    fontFile: `${repoRoot}${DISCLOSURE_FONT_PATH}`,
  });
  writeFileSync(`${repoRoot}assets/disclosure/${asset.fileName}`, image);
  console.log(`${asset.fileName} ${createHash("sha256").update(image).digest("hex")}`);
}
