/**
 * Renders the AI-generated disclosure layer v1 images into a directory of your
 * choice and says, for each, whether it is the committed image (ADR-0071).
 *
 *   pnpm --filter @app/storage render-disclosure-layers --out <directory>
 *
 * It never writes into `assets/disclosure/`: the committed images are reviewed,
 * and a different look is a layer v2 with new files. Exit code 0 when every
 * image is the committed one, 1 when any differs, 2 for unusable arguments.
 */

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { DISCLOSURE_LAYER_ASSETS } from "@app/domain";
import { DISCLOSURE_FONT_PATH, DISCLOSURE_FONTCONFIG_PATH, renderDisclosureLayer } from "../disclosure/index";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const fontConfigFile = `${repoRoot}${DISCLOSURE_FONTCONFIG_PATH}`;

const { values } = parseArgs({ options: { out: { type: "string" } } });
// pnpm runs the script from the package; a relative --out means where it was typed.
const out = values.out === undefined ? null : resolve(process.env.INIT_CWD ?? process.cwd(), values.out);
if (out === null || out === resolve(repoRoot, "assets/disclosure")) {
  console.error("Usage: render-disclosure-layers --out <directory>, anywhere but assets/disclosure");
  process.exit(2);
}

// Before the first text is drawn, which is when fontconfig reads it.
process.env.FONTCONFIG_FILE = fontConfigFile;
mkdirSync(out, { recursive: true });
let differing = 0;
for (const asset of DISCLOSURE_LAYER_ASSETS) {
  const image = await renderDisclosureLayer({
    widthPx: asset.widthPx,
    heightPx: asset.heightPx,
    fontFile: `${repoRoot}${DISCLOSURE_FONT_PATH}`,
    fontConfigFile,
  });
  writeFileSync(join(out, asset.fileName), image);
  const sha256 = createHash("sha256").update(image).digest("hex");
  const same = sha256 === asset.sha256;
  if (!same) differing += 1;
  console.log(`${asset.fileName} ${sha256} ${same ? "is the committed image" : "DIFFERS from the committed image"}`);
}
process.exitCode = differing === 0 ? 0 : 1;
