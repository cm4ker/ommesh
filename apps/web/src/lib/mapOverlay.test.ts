import { test } from "node:test";
import assert from "node:assert/strict";
import type { ContactRecord, SessionState } from "@meshnet/meshcore";
import { neighboursOverlay, routeOverlay } from "./mapOverlay.js";
import type { NeighboursTool } from "./meshTool.js";
import { NO_FILTER, type NeighbourFilter } from "./neighbours.js";

const HILL = "aa".repeat(32);
const NEAR = "bb".repeat(32);
const FAR = "cc".repeat(32);
const contact = (key: string, lat: number, lon: number) => ({ key, name: key.slice(0, 4), prefix: key.slice(0, 12), type: 2, lat, lon }) as unknown as ContactRecord;
const AT = Date.now();
const state = {
  contacts: { [HILL]: contact(HILL, 55, 73), [NEAR]: contact(NEAR, 55.01, 73), [FAR]: contact(FAR, 55.3, 73) },
  neighbours: { [HILL]: { total: 2, order: 0, at: AT, neighbours: [{ prefix: NEAR.slice(0, 12), heardSecsAgo: 60, snr: 6 }, { prefix: FAR.slice(0, 12), heardSecsAgo: 60, snr: -9 }] } },
} as unknown as SessionState;
const tool = (filter: NeighbourFilter | null): NeighboursTool => ({ kind: "neighbours", key: HILL, link: null, returnTo: null, prev: null, filter });

test("every neighbour gets its line, with no rings while nothing is filtered", () => {
  const overlay = neighboursOverlay(tool(null), state, false, AT);
  assert.deepEqual(overlay.lines.map((l) => [l.to.key, l.tone]), [[NEAR, "good"], [FAR, "weak"]]);
  assert.equal(overlay.rings, undefined);
});

test("the filter leaves out those it hides, and rings the distance it keeps", () => {
  const weak = neighboursOverlay(tool({ ...NO_FILTER, minSnr: -5 }), state, false, AT);
  assert.deepEqual(weak.lines.map((l) => l.to.key), [NEAR]);
  const far = neighboursOverlay(tool({ ...NO_FILTER, fromKm: 5, toKm: 50 }), state, false, AT);
  assert.deepEqual(far.lines.map((l) => l.to.key), [FAR]);
  assert.deepEqual(far.rings?.map((r) => [r.km, r.label]), [[5, "5 km"], [50, "50 km"]]);
});

// A room with no place of its own, held through Tower (on the map), KZN-7 (not) and a relay whose hash is the room's own first byte.
const TOWER = "a3".repeat(32);
const KZN = "e4".repeat(32);
const ROOM = "94".repeat(32);
const routed = (lat: number) => {
  const room = { ...contact(ROOM, lat, lat ? 73.1 : 0), name: "Town Room", type: 3, outPathLen: 3, outPath: "a3e494" } as unknown as ContactRecord;
  return {
    self: { lat: 55, lon: 73 },
    contacts: { [TOWER]: { ...contact(TOWER, 55.05, 73), name: "Tower" }, [KZN]: { ...contact(KZN, 0, 0), name: "KZN-7" }, [ROOM]: room },
  } as unknown as SessionState;
};

test("a route to a node off the map is drawn as far as the map knows it, and named on from there", () => {
  const overlay = routeOverlay(ROOM, routed(0), null);
  assert.deepEqual(overlay.lines.map((l) => [l.from.key, l.to.key]), [["self", TOWER]]);
  // The relay sharing the room's first byte is not the room itself.
  assert.deepEqual(overlay.tail, { lat: 55.05, lon: 73, text: "KZN-7 › 94 › Town Room" });
});

test("a leg that goes round relays off the map says which", () => {
  const overlay = routeOverlay(ROOM, routed(55.2), null);
  assert.deepEqual(overlay.lines.map((l) => [l.from.key, l.to.key, l.note ?? null]), [["self", TOWER, null], [TOWER, ROOM, "via KZN-7, 94"]]);
  assert.equal(overlay.tail, undefined);
});
