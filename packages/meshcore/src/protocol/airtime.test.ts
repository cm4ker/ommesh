import { test } from "node:test";
import assert from "node:assert/strict";
import { loraAirtimeMs, neighbourSearchMs, traceBudgetMs } from "./airtime.js";

// The OMS preset: 869.161 MHz, 62.5 kHz, SF7, 4/7.
const OMS = { bandwidthHz: 62_500, spreadingFactor: 7, codingRate: 7 };

test("time on air follows Semtech's formula with MeshCore's long preamble at low SF", () => {
  // 2.048 ms symbols; 32 + 4.25 preamble symbols, then 8 + 8 × 7 for 24 bytes.
  assert.equal(Math.round(loraAirtimeMs(24, OMS) * 10) / 10, 205.3);
  // SF11 at 125 kHz: 16.384 ms symbols turn on low data rate optimisation; 16 + 4.25 preamble, then 8 + 6 × 5.
  assert.equal(Math.round(loraAirtimeMs(24, { bandwidthHz: 125_000, spreadingFactor: 11, codingRate: 5 })), 954);
});

test("a trace is given about three airtimes a hop, well under what the radio estimates", () => {
  // Out through seven and back through six: thirteen one-byte hashes.
  const budget = traceBudgetMs(13, 1, OMS);
  assert.ok(budget > 12_000 && budget < 13_000, String(budget));
  // The radio says 500 + (6 × 205 + 250) × 14 for the same trace.
  assert.ok(budget < 500 + (6 * loraAirtimeMs(24, OMS) + 250) * 14);
});

test("a neighbour search waits for answers from neighbours with twice the default txdelay", () => {
  // EU/UK Narrow: 62.5 kHz, SF8, 4/8. An answer is 542 ms on the air, so at txdelay 1 it comes within 10.8 s.
  const narrow = neighbourSearchMs({ bandwidthHz: 62_500, spreadingFactor: 8, codingRate: 8 });
  assert.equal(Math.round(narrow / 100) / 10, 12.3);
  // The repeater listens for a minute and no longer.
  assert.equal(neighbourSearchMs({ bandwidthHz: 7_800, spreadingFactor: 12, codingRate: 8 }), 60_000);
});
