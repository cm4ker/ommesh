import { test } from "node:test";
import assert from "node:assert/strict";
import { AdvType, type ContactRecord } from "@meshnet/meshcore";
import { buildGraph, noteFlood, SELF, type LinkBook } from "./linkGraph.js";
import { relayChoices } from "./relayPick.js";

const NOW = 1_700_000_000_000;

function contact(first: string, name: string, opts: { type?: number; lat?: number; lastAdvert?: number } = {}): ContactRecord {
  const key = (first + "00".repeat(32)).slice(0, 64);
  return { key, prefix: key.slice(0, 12), type: opts.type ?? AdvType.Repeater, flags: 0, outPathLen: 0xff, outPath: "", name, lastAdvert: opts.lastAdvert ?? 0, lat: opts.lat ?? 0, lon: opts.lat ? 73 : 0, lastMod: 0, lastHeardAt: null, pathSince: null };
}

const TOWER = contact("a3", "Tower", { lat: 55 });
const KZN = contact("e4", "KZN-7", { lastAdvert: 100 });
const HILL = contact("6f", "Hill", { lat: 55.1, lastAdvert: 50 });
const NORTH = contact("b0", "Север-2", { lastAdvert: 200 });
const ROOM = contact("94", "Town Room", { type: AdvType.Room });
const contacts = Object.fromEntries([TOWER, KZN, HILL, NORTH, ROOM].map((c) => [c.key, c]));

/** Floods heard: KZN-7 through Tower, Town Room's advert through KZN-7, and one through a repeater the radio has no advert of. */
function graph() {
  const book: LinkBook = new Map();
  noteFlood(book, ["e4", "a3"], 4, null, NOW);
  noteFlood(book, ["e4", "a3"], 4, ROOM.key, NOW);
  noteFlood(book, ["c7", "a3"], -3, null, NOW);
  return buildGraph(book, { contacts, neighbours: {} }, NOW);
}

const pick = (prev: string, taken: string[], query = "", size = 1) => relayChoices({ contacts }, graph(), { prev, target: ROOM.key, taken, query, size });

test("those heard next to the relay before come first, and those heard next to the end are marked", () => {
  const { near, rest } = pick(TOWER.key, [TOWER.key]);
  assert.deepEqual(near.map((c) => c.key), [KZN.key, "c7"]);
  assert.equal(near[0]!.nearEnd, true);
  assert.equal(near[0]!.placed, false);
  assert.equal(near[1]!.contact, null);
  // The rest by when they were last heard; the room itself is never a relay of its own route.
  assert.deepEqual(rest.map((c) => c.key), [NORTH.key, HILL.key]);
});

test("from this radio, the first relay is one it has heard", () => {
  const { near } = pick(SELF, []);
  assert.deepEqual(near.map((c) => c.key), [TOWER.key]);
});

test("a name or a hash finds a repeater, lookalike letters and all", () => {
  assert.deepEqual(pick(SELF, [], "cевер").rest.map((c) => c.key), [NORTH.key]);
  const byHash = pick(TOWER.key, [TOWER.key], "e4");
  assert.deepEqual([...byHash.near, ...byHash.rest].map((c) => c.key), [KZN.key]);
});

test("a hash heard shorter than the route's hashes is not offered", () => {
  assert.deepEqual(pick(TOWER.key, [TOWER.key], "", 2).near.map((c) => c.key), [KZN.key]);
});
