import { test } from "node:test";
import assert from "node:assert/strict";
import type { ContactRecord } from "@meshnet/meshcore";
import { cellNodeMatch, cellToneFor, contactForCoverageNode, coverageCellId, findCoverageCell, hasCellsInBounds, levelHasNode, parseCoverage, pickCoverageLevel } from "./community.js";

const KEY_A = "ce5b9348" + "a".repeat(56);
const KEY_B = "936008bb" + "b".repeat(56);
const KEY_B2 = "936008bb" + "c".repeat(56);

const SAMPLE = {
  days: 90,
  from: 1_700_000_000_000,
  to: 1_707_776_000_000,
  samples: 42,
  levels: [
    {
      cellM: 800,
      cells: [
        {
          lat: 54.97,
          lon: 73.41,
          n: 12,
          ok: 10,
          snr: 5,
          best: 11,
          tone: "good",
          firstAt: 1_700_000_000_000,
          lastAt: 1_707_000_000_000,
          nodes: [[KEY_A, "PKIO", 8, 11], ["936008bb", "AVA5", 3, -7]],
          senders: [["", "", 5], ["195102f6" + "0".repeat(56), "Surveyor", 7]],
        },
      ],
    },
    {
      cellM: 200,
      cells: [
        {
          lat: 54.974383,
          lon: 73.408159,
          n: 4,
          ok: 0,
          snr: null,
          best: null,
          tone: "none",
          firstAt: 1_700_000_000_000,
          lastAt: 1_700_000_000_000,
          nodes: [],
          senders: [],
        },
        {
          lat: 54.97345,
          lon: 73.40549,
          n: 6,
          ok: 6,
          snr: 8,
          best: 12,
          tone: "good",
          firstAt: 1_700_000_000_000,
          lastAt: 1_705_000_000_000,
          nodes: [[KEY_A, "PKIO", 6, 12], ["936008bb", "AVA5", 2, -2]],
          senders: [],
        },
      ],
    },
  ],
};

test("parseCoverage validates, drops malformed cells, and sorts levels finest first", () => {
  const parsed = parseCoverage(JSON.stringify(SAMPLE));
  assert.ok(parsed);
  assert.equal(parsed.days, 90);
  assert.equal(parsed.samples, 42);
  assert.deepEqual(parsed.levels.map((l) => l.cellM), [200, 800]);
  assert.equal(parsed.levels[0]!.cells.length, 2);
  assert.equal(parseCoverage("not json"), null);
  assert.equal(parseCoverage({}), null);
  const bad = parseCoverage({ levels: [{ cellM: 200, cells: [{ lat: 999, lon: 0, n: 1, ok: 1, tone: "good", firstAt: 1, lastAt: 1 }, { lat: 55, lon: 73, n: 1, ok: 1, tone: "bogus", firstAt: 1, lastAt: 1 }] }] });
  assert.equal(bad?.levels[0]?.cells.length, 0);
});

test("pickCoverageLevel picks the finest level large enough to read, and findCoverageCell finds any tapped level", () => {
  const parsed = parseCoverage(SAMPLE)!;
  assert.equal(pickCoverageLevel(parsed, 14, 55)?.cellM, 200);
  assert.equal(pickCoverageLevel(parsed, 11, 55)?.cellM, 800);
  const id = coverageCellId(800, 54.97, 73.41);
  const found = findCoverageCell(parsed, id);
  assert.equal(found?.level.cellM, 800);
  assert.equal(found?.cell.n, 12);
  assert.equal(findCoverageCell(parsed, "400:54.97,73.41"), null);
});

test("node matching handles full keys and prefixes, and highlights a repeater by its own SNR", () => {
  const parsed = parseCoverage(SAMPLE)!;
  const big = parsed.levels[1]!.cells[0]!;
  assert.equal(cellNodeMatch(big, KEY_A)?.[1], "PKIO");
  assert.equal(cellNodeMatch(big, KEY_B)?.[1], "AVA5");
  assert.equal(cellNodeMatch(big, "ff".repeat(32)), null);
  assert.equal(levelHasNode(parsed.levels[1]!, KEY_B), true);
  assert.equal(levelHasNode(parsed.levels[1]!, "ff".repeat(32)), false);
  // Overall cell is good (+5 dB median), but AVA5 alone heard it at -7 dB (weak).
  assert.equal(cellToneFor(big, null), "good");
  assert.equal(cellToneFor(big, KEY_A), "good");
  assert.equal(cellToneFor(big, KEY_B), "weak");
  assert.equal(cellToneFor(big, "ff".repeat(32)), null);
});

test("contactForCoverageNode resolves exact keys and unambiguous prefixes only", () => {
  const mk = (key: string, name: string) => ({ key, name }) as ContactRecord;
  const unique = { [KEY_A]: mk(KEY_A, "PKIO"), [KEY_B]: mk(KEY_B, "AVA5") };
  assert.equal(contactForCoverageNode(unique, KEY_A)?.name, "PKIO");
  assert.equal(contactForCoverageNode(unique, "936008bb")?.name, "AVA5");
  assert.equal(contactForCoverageNode(unique, "9360")?.name, undefined);
  const ambiguous = { ...unique, [KEY_B2]: mk(KEY_B2, "AVA5 clone") };
  assert.equal(contactForCoverageNode(ambiguous, "936008bb"), null);
});

test("hasCellsInBounds reports whether any cell sits inside the viewport", () => {
  const parsed = parseCoverage(SAMPLE)!;
  const fine = parsed.levels[0]!;
  assert.equal(hasCellsInBounds(fine, { south: 54.9, north: 55.0, west: 73.3, east: 73.5 }), true);
  assert.equal(hasCellsInBounds(fine, { south: 59.8, north: 60.1, west: 30.1, east: 30.6 }), false);
});
