import { test } from "node:test";
import assert from "node:assert/strict";
import type { ContactRecord, NeighbourList } from "@meshnet/meshcore";
import { contactOfPrefix, heardInList, isComplete, isFiltering, kmTicks, kmToPlace, neighbourRows, NO_FILTER, passes, placeToKm, scaleKm, STALE_S } from "./neighbours.js";

const contact = (key: string, name: string, lat = 0, lon = 0) => ({ key, name, prefix: key.slice(0, 12), type: 2, lat, lon }) as unknown as ContactRecord;

const HILL = "aa".repeat(32);
const TOWER = "bb".repeat(32);
const RIDGE = "cc".repeat(32);
const contacts = { [HILL]: contact(HILL, "Hill", 55, 73), [TOWER]: contact(TOWER, "Tower", 55.1, 73.1), [RIDGE]: contact(RIDGE, "Ridge") };
const AT = 1_000_000_000;
const list = (neighbours: NeighbourList["neighbours"], total = neighbours.length): NeighbourList => ({ total, order: 0, neighbours, at: AT });

test("a neighbour is matched to the contact its prefix names, and placed only with a position", () => {
  const state = { contacts, neighbours: { [HILL]: list([{ prefix: TOWER.slice(0, 12), heardSecsAgo: 60, snr: 4 }, { prefix: RIDGE.slice(0, 12), heardSecsAgo: 60, snr: 8 }, { prefix: "0d4c7bddeeff", heardSecsAgo: 60, snr: -3 }]) } };
  const rows = neighbourRows(state, HILL, AT);
  assert.deepEqual(rows.map((r) => [r.contact?.name ?? r.prefix, r.placed]), [["Ridge", false], ["Tower", true], ["0d4c7bddeeff", false]]);
});

test("the list goes strongest first, or heard last first (#75)", () => {
  const state = { contacts, neighbours: { [HILL]: list([{ prefix: TOWER.slice(0, 12), heardSecsAgo: 60, snr: -4 }, { prefix: RIDGE.slice(0, 12), heardSecsAgo: 86_000, snr: 9 }, { prefix: "0d4c7bddeeff", heardSecsAgo: 600, snr: 2 }]) } };
  const names = (sort?: "signal" | "heard") => neighbourRows(state, HILL, AT, sort).map((r) => r.contact?.name ?? r.prefix);
  assert.deepEqual(names(), ["Ridge", "0d4c7bddeeff", "Tower"]);
  assert.deepEqual(names("heard"), ["Tower", "0d4c7bddeeff", "Ridge"]);
});

test("how long ago a neighbour was heard counts from now, and past a day it may be gone", () => {
  const state = { contacts, neighbours: { [HILL]: list([{ prefix: TOWER.slice(0, 12), heardSecsAgo: STALE_S - 600, snr: 1 }]) } };
  assert.equal(neighbourRows(state, HILL, AT)[0]!.stale, false);
  const later = neighbourRows(state, HILL, AT + 3_600_000)[0]!;
  assert.equal(later.heardS, STALE_S + 3000);
  assert.equal(later.stale, true);
});

test("the other way round is known only from the neighbour's own list", () => {
  const state = { neighbours: { [TOWER]: list([{ prefix: HILL.slice(0, 12), heardSecsAgo: 30, snr: -1.5 }]) } };
  assert.deepEqual(heardInList(state, TOWER, HILL, AT + 10_000), { snr: -1.5, heardS: 40 });
  assert.equal(heardInList(state, HILL, TOWER, AT), null);
});

test("a list is complete once it holds as many as the repeater said", () => {
  assert.equal(isComplete(undefined), false);
  assert.equal(isComplete(list([{ prefix: "01", heardSecsAgo: 1, snr: 0 }], 12)), false);
  assert.equal(isComplete(list([], 0)), true);
});

test("a placed neighbour is as far as it is from the repeater; one with no position has no distance", () => {
  const state = { contacts, neighbours: { [HILL]: list([{ prefix: TOWER.slice(0, 12), heardSecsAgo: 60, snr: 4 }, { prefix: RIDGE.slice(0, 12), heardSecsAgo: 60, snr: 8 }]) } };
  const [ridge, tower] = neighbourRows(state, HILL, AT);
  assert.equal(ridge!.km, null);
  assert.ok(Math.abs(tower!.km! - 12.8) < 0.1);
});

test("the filter keeps those heard well enough, lately enough, and within the distance", () => {
  const row = (snr: number, km: number | null, stale = false) => ({ prefix: "", snr, heardS: 0, contact: null, placed: km !== null, km, stale });
  assert.equal(passes(row(-8, 3), null), true);
  assert.equal(passes(row(-8, 3), { ...NO_FILTER, minSnr: -5 }), false);
  assert.equal(passes(row(-5, 3), { ...NO_FILTER, minSnr: -5 }), true);
  assert.equal(passes(row(2, 3, true), { ...NO_FILTER, recent: true }), false);
  assert.equal(passes(row(2, 3), { ...NO_FILTER, fromKm: 5 }), false);
  assert.equal(passes(row(2, 30), { ...NO_FILTER, fromKm: 5, toKm: 20 }), false);
  assert.equal(passes(row(2, 12), { ...NO_FILTER, fromKm: 5, toKm: 20 }), true);
  // The distance cannot hold back one whose place is not known; the signal still does.
  assert.equal(passes(row(2, null), { ...NO_FILTER, fromKm: 5, toKm: 20 }), true);
  assert.equal(passes(row(-9, null), { ...NO_FILTER, minSnr: -5, toKm: 20 }), false);
  assert.equal(isFiltering(NO_FILTER), false);
  assert.equal(isFiltering({ ...NO_FILTER, toKm: 20 }), true);
});

test("the distance slider ends at a round number past the farthest, and gives the near km room", () => {
  const at = (km: number | null) => ({ prefix: "", snr: 0, heardS: 0, contact: null, placed: true, km, stale: false });
  assert.equal(scaleKm([at(3), at(41.2), at(null)]), 50);
  assert.equal(scaleKm([]), 1);
  assert.equal(kmToPlace(12.5, 50), 0.5);
  assert.equal(placeToKm(0.5, 50), 13);
  assert.equal(placeToKm(0.3, 50), 4.5);
  assert.equal(placeToKm(0.1, 50), 0.5);
  assert.deepEqual(kmTicks(50), [0, 1, 5, 10, 20, 30, 50]);
  assert.deepEqual(kmTicks(20), [0, 1, 5, 10, 20]);
});

test("an empty prefix names nobody", () => {
  assert.equal(contactOfPrefix(contacts, ""), null);
  assert.equal(contactOfPrefix(contacts, TOWER.slice(0, 12))?.name, "Tower");
});
