import { test } from "node:test";
import assert from "node:assert/strict";
import type { ChannelRecord } from "@meshnet/meshcore";
import { pinnedAt, radioPins } from "./chatPins.js";

const PUBLIC = "8b3387e9c5cdea6ac9e5edbaa115cd72";
const channels: ChannelRecord[] = [
  { index: 1, name: "#test", secret: "9cd8fcf22a47333b591d96a2b848b73f" },
  { index: 0, name: "Public", secret: PUBLIC },
];

test("a radio nobody has pinned anything for has Public pinned, found by its key", () => {
  assert.deepEqual(radioPins(undefined, channels), { "ch:0": { at: 0, name: "Public" } });
  const renamed = [{ index: 2, name: "Общий", secret: PUBLIC.toUpperCase() }];
  assert.deepEqual(radioPins(undefined, renamed), { "ch:2": { at: 0, name: "Общий" } });
});

test("pins written down win, even with Public unpinned", () => {
  assert.deepEqual(radioPins({}, channels), {});
  assert.deepEqual(radioPins({ "c:ab": { at: 5 } }, channels), { "c:ab": { at: 5 } });
});

test("a radio without Public has nothing pinned at first", () => {
  assert.deepEqual(radioPins(undefined, [channels[0]!]), {});
});

test("a channel's pin holds while the slot keeps its name", () => {
  const pins = { "ch:1": { at: 7, name: "#test" }, "c:ab": { at: 9 } };
  assert.equal(pinnedAt(pins, { id: "ch:1", channel: channels[0]! }), 7);
  assert.equal(pinnedAt(pins, { id: "ch:1", channel: { index: 1, name: "#omsk", secret: "00" } }), null);
  assert.equal(pinnedAt(pins, { id: "ch:1", channel: null }), null);
  assert.equal(pinnedAt(pins, { id: "c:ab", channel: null }), 9);
  assert.equal(pinnedAt(pins, { id: "c:cd", channel: null }), null);
});
