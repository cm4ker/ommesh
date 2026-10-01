import { test } from "node:test";
import assert from "node:assert/strict";
import { placeDay } from "./floatingDay.js";

// The floating date rests at 100 px and stands 20 px tall.
const LINE = 100;
const HEIGHT = 20;

test("at the head of the list, with the first day's own line in sight, nothing floats", () => {
  assert.equal(placeDay([130, 900], LINE, HEIGHT), null);
  assert.equal(placeDay([], LINE, HEIGHT), null);
});

test("the day floating is the last whose line has gone above its place", () => {
  assert.deepEqual(placeDay([-800, -300, 600], LINE, HEIGHT), { at: 1, shift: 0, covers: false });
  assert.deepEqual(placeDay([-800, -300], LINE, HEIGHT), { at: 1, shift: 0, covers: false });
});

test("the next day's line coming up under it pushes it up by as much as it is short of room", () => {
  // 100 + 20 + 4 of room would end at 124; the line at 114 pushes it 10 px up.
  assert.deepEqual(placeDay([-300, 114], LINE, HEIGHT), { at: 0, shift: -10, covers: false });
  assert.equal(placeDay([-300, 124], LINE, HEIGHT)!.shift, 0);
});

test("a line just passing under the floating date is hidden, not drawn twice", () => {
  assert.deepEqual(placeDay([95], LINE, HEIGHT), { at: 0, shift: 0, covers: true });
  assert.deepEqual(placeDay([100], LINE, HEIGHT), { at: 0, shift: 0, covers: true });
  assert.equal(placeDay([80], LINE, HEIGHT)!.covers, false);
});

test("a day jumped to, its line a fraction of a pixel below the place, counts as there", () => {
  assert.deepEqual(placeDay([-300, 100.6], LINE, HEIGHT), { at: 1, shift: 0, covers: true });
  assert.equal(placeDay([102], LINE, HEIGHT), null);
});
