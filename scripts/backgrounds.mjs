/** Regenerates the bundled SVG wallpapers. Each tile has matching opposite edges and two palettes. */
import { mkdirSync, writeFileSync, readdirSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { BACKGROUND_ART, drawBackground } from "./background-art.mjs";

const out = fileURLToPath(new URL("../apps/web/src/backgrounds/", import.meta.url));
mkdirSync(out, { recursive: true });
const names = new Set();
for (const id of Object.keys(BACKGROUND_ART)) {
  for (const light of [false, true]) {
    const name = id + (light ? "-light.svg" : "-dark.svg");
    names.add(name);
    const svg = drawBackground(id, light);
    writeFileSync(join(out, name), svg);
    console.log(name + ": " + (Buffer.byteLength(svg) / 1024).toFixed(1) + " KB");
  }
}
// Only this generated directory is cleaned, so removed designs cannot remain in the client bundle.
for (const name of readdirSync(out)) if (name.endsWith(".svg") && !names.has(name)) unlinkSync(join(out, name));
