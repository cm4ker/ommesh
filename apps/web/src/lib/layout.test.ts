import { test } from "node:test";
import assert from "node:assert/strict";
import { sidewaysShape } from "./layout.js";

const phone = { coarse: true, width: 790, height: 360, orientation: "landscape-primary", landscape: true };

test("a phone turned on its side is sideways, either way round", () => {
  assert.equal(sidewaysShape(phone), true);
  assert.equal(sidewaysShape({ ...phone, orientation: "landscape-secondary" }), true);
  // iOS gives the screen's upright size whichever way the phone is held.
  assert.equal(sidewaysShape({ ...phone, width: 430, height: 932 }), true);
});

test("an upright phone is not sideways, even with a keyboard that leaves its window wider than tall", () => {
  assert.equal(sidewaysShape({ ...phone, width: 360, height: 790, orientation: "portrait-primary", landscape: true }), false);
});

test("a tablet and a computer are never sideways", () => {
  assert.equal(sidewaysShape({ ...phone, width: 1112, height: 834 }), false);
  assert.equal(sidewaysShape({ ...phone, width: 960, height: 600 }), false);
  assert.equal(sidewaysShape({ ...phone, coarse: false }), false);
});

test("without screen.orientation the window's shape decides", () => {
  assert.equal(sidewaysShape({ ...phone, orientation: undefined, landscape: true }), true);
  assert.equal(sidewaysShape({ ...phone, orientation: undefined, landscape: false }), false);
});
