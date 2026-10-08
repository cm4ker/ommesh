/**
 * Regenerates the bundled wallpapers. Each tile has matching opposite edges and two palettes.
 * The SVG is the drawing; the app shows WebP pictures made from it, because a phone takes
 * seconds to draw an SVG of a thousand shapes and more (ChatBackdrop).
 */
import { mkdirSync, writeFileSync, readdirSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import sharp from "sharp";
import { BACKGROUND_ART, drawBackground } from "./background-art.mjs";

/**
 * The widths of each picture, in pixels. A chat repeats it 400 CSS pixels wide, and the browser
 * takes the one for its screen's density (ChatBackdrop): squeezed to a third, thin lines break up.
 */
const BACKGROUND_WIDTHS = [400, 800, 1200];

/** The smaller of two encodings no eye tells from the drawing: thin coloured lines lose their colour in lossy WebP. */
async function picture(svg, width) {
  const png = await sharp(Buffer.from(svg), { density: (72 * width) / 800 }).png().toBuffer();
  const [near, exact] = await Promise.all([
    sharp(png).webp({ nearLossless: true, quality: 40, effort: 6 }).toBuffer(),
    sharp(png).webp({ lossless: true, effort: 6 }).toBuffer(),
  ]);
  return near.length < exact.length ? near : exact;
}

const out = fileURLToPath(new URL("../apps/web/src/backgrounds/", import.meta.url));
mkdirSync(out, { recursive: true });
const names = new Set();
for (const id of Object.keys(BACKGROUND_ART)) {
  for (const light of [false, true]) {
    const name = id + (light ? "-light" : "-dark");
    const svg = drawBackground(id, light);
    names.add(name + ".svg");
    writeFileSync(join(out, name + ".svg"), svg);
    const sizes = [];
    for (const width of BACKGROUND_WIDTHS) {
      const webp = await picture(svg, width);
      names.add(`${name}-${width}.webp`);
      writeFileSync(join(out, `${name}-${width}.webp`), webp);
      sizes.push(`${width}px ${(webp.length / 1024).toFixed(1)} KB`);
    }
    console.log(`${name}: svg ${(Buffer.byteLength(svg) / 1024).toFixed(1)} KB, ${sizes.join(", ")}`);
  }
}
// Only this generated directory is cleaned, so removed designs cannot remain in the client bundle.
for (const name of readdirSync(out)) if (/\.(svg|webp)$/.test(name) && !names.has(name)) unlinkSync(join(out, name));
