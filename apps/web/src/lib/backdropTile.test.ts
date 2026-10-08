import { test } from "node:test";
import assert from "node:assert/strict";
import { tilePixels, tileWidth } from "./backdropTile.js";

test("a shown size is drawn at the next of a few widths, so the size slider reuses them", () => {
  assert.equal(tileWidth(200), 200);
  assert.equal(tileWidth(320), 400);
  assert.equal(tileWidth(400), 400);
  assert.equal(tileWidth(480), 520);
  assert.equal(tileWidth(640), 640);
  assert.equal(tileWidth(700), 700);
});

test("a tile is drawn for the screen's pixels, keeping the picture's proportions", () => {
  assert.deepEqual(tilePixels(400, 800, 1200, 1), [400, 600]);
  assert.deepEqual(tilePixels(400, 800, 1200, 3), [1200, 1800]);
  assert.deepEqual(tilePixels(400, 800, 1200, 0.5), [400, 600]);
});

test("a big tile on a dense screen is drawn softer rather than past the pixel limit", () => {
  const [w, h] = tilePixels(640, 800, 1200, 3);
  assert.ok(w * h <= 4_000_000);
  assert.equal(Math.round((h / w) * 10), 15);
});
