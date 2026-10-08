import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { BACKGROUND_ART, drawBackground } from "./background-art.mjs";

test("the bundled wallpaper palettes match their seeded source", () => {
  const folder = new URL("../apps/web/src/backgrounds/", import.meta.url);
  const expected = [];
  for (const id of Object.keys(BACKGROUND_ART)) {
    const palettes = [];
    for (const light of [false, true]) {
      const name = `${id}-${light ? "light" : "dark"}.svg`;
      expected.push(name);
      const svg = drawBackground(id, light);
      assert.equal(readFileSync(new URL(name, folder), "utf8"), svg, `${name}: run pnpm backgrounds`);
      assert.doesNotMatch(svg, /NaN|Infinity|undefined/);
      palettes.push(svg);
    }
    assert.notEqual(palettes[0], palettes[1], `${id} needs both theme palettes`);
  }
  assert.deepEqual(
    readdirSync(folder)
      .filter((name) => name.endsWith(".svg"))
      .sort(),
    expected.sort(),
  );
});

/** A WebP picture's width and height, from its lossless (VP8L) or extended (VP8X) header. */
function webpSize(bytes) {
  assert.equal(bytes.toString("ascii", 0, 4), "RIFF");
  assert.equal(bytes.toString("ascii", 8, 12), "WEBP");
  const chunk = bytes.toString("ascii", 12, 16);
  if (chunk === "VP8L") {
    const bits = bytes.readUInt32LE(21);
    return [(bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1];
  }
  if (chunk === "VP8X") return [bytes.readUIntLE(24, 3) + 1, bytes.readUIntLE(27, 3) + 1];
  assert.fail(`unexpected WebP chunk ${chunk}`);
}

test("every wallpaper has its pictures, one for each screen density", () => {
  // The encoder's bytes differ from one machine to another, so only their presence and size are checked.
  const folder = new URL("../apps/web/src/backgrounds/", import.meta.url);
  const expected = [];
  for (const id of Object.keys(BACKGROUND_ART)) {
    for (const theme of ["dark", "light"]) {
      for (const width of [400, 800, 1200]) {
        const name = `${id}-${theme}-${width}.webp`;
        expected.push(name);
        assert.deepEqual(webpSize(readFileSync(new URL(name, folder))), [width, width * 1.5], `${name}: run pnpm backgrounds`);
      }
    }
  }
  assert.deepEqual(
    readdirSync(folder)
      .filter((name) => name.endsWith(".webp"))
      .sort(),
    expected.sort(),
  );
});
