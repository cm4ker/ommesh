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
