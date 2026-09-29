import { test } from "node:test";
import assert from "node:assert/strict";
import type { ContactRecord, SessionState } from "@meshnet/meshcore";
import { neighboursOverlay } from "./mapOverlay.js";
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
