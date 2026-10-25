import { test } from "node:test";
import assert from "node:assert/strict";
import { AdvType, ContactFlag, type ContactRecord } from "@meshnet/meshcore";
import { isSilent, lastWord } from "./silentNodes.js";

const NOW = 1_700_000_000_000;
const DAY = 24 * 3600 * 1000;

function node(patch: Partial<ContactRecord> = {}): ContactRecord {
  const key = "ab".repeat(32);
  return {
    key,
    prefix: key.slice(0, 12),
    type: AdvType.Repeater,
    flags: 0,
    outPathLen: 0xff,
    outPath: "",
    name: "Hill",
    lastAdvert: 0,
    lat: 0,
    lon: 0,
    lastMod: 0,
    lastHeardAt: null,
    pathSince: null,
    ...patch,
  };
}

test("a node is heard by the radio's clock or ours, its own stamp only where the radio left none", () => {
  // Restarted without its clock: stamped two years back, kept by the radio a minute ago.
  assert.equal(lastWord(node({ lastAdvert: (NOW - 700 * DAY) / 1000, lastMod: (NOW - 60_000) / 1000 }), NOW), NOW - 60_000);
  // Heard on the air since.
  assert.equal(lastWord(node({ lastMod: (NOW - 9 * DAY) / 1000, lastHeardAt: NOW - DAY }), NOW), NOW - DAY);
  // A stamp ahead of us counts as now.
  assert.equal(lastWord(node({ lastAdvert: (NOW + DAY) / 1000 }), NOW), NOW);
});

test("a repeater, room or sensor unheard for the days chosen is silent; a person or a starred node never is", () => {
  const old = { lastMod: (NOW - 31 * DAY) / 1000 };
  assert.equal(isSilent(node(old), 30, NOW), true);
  assert.equal(isSilent(node(old), 90, NOW), false);
  assert.equal(isSilent(node(old), null, NOW), false);
  assert.equal(isSilent(node({ ...old, type: AdvType.Room }), 30, NOW), true);
  assert.equal(isSilent(node({ ...old, type: AdvType.Sensor }), 30, NOW), true);
  assert.equal(isSilent(node({ ...old, type: AdvType.Chat }), 7, NOW), false);
  assert.equal(isSilent(node({ ...old, flags: ContactFlag.Favourite }), 7, NOW), false);
  assert.equal(isSilent(node({ ...old, lastHeardAt: NOW - 2 * DAY }), 7, NOW), false);
});
