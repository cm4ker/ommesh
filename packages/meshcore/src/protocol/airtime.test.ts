import { test } from "node:test";
import assert from "node:assert/strict";
import { loraAirtimeMs, neighbourSearchMs, replyBudgetMs, sealedBytes, traceBudgetMs } from "./airtime.js";

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

test("an answer from a flood is given time for every hop there and back, past what the radio estimates", () => {
  const status = { askBytes: sealedBytes(13), answerBytes: 60, holdMs: 300 };
  // The radio says 500 + 16 airtimes of the 22-byte request for a flood however far it goes: 6.2 s with room to spare.
  const radio = (500 + 16 * loraAirtimeMs(22, OMS)) * 1.25 + 1800;
  assert.ok(radio < 6_500, String(radio));
  // Six hops each way, each relay holding the packet up to 2.5 of its airtimes.
  const six = replyBudgetMs({ hops: 6, hashSize: 1, flood: true }, status, OMS);
  assert.ok(six > 17_000 && six < 18_500, String(six));
  // Along a route a relay holds a packet for less, and no path rides in the answer.
  const routed = replyBudgetMs({ hops: 6, hashSize: 1, flood: false }, status, OMS);
  assert.ok(routed < six - 4_000, String(routed));
});

test("a longer answer is given longer", () => {
  const way = { hops: 3, hashSize: 1, flood: false };
  const short = replyBudgetMs(way, { askBytes: 36, answerBytes: 10, holdMs: 600 }, OMS);
  const long = replyBudgetMs(way, { askBytes: 36, answerBytes: 150, holdMs: 600 }, OMS);
  assert.ok(long > short + 2_000, `${short} ${long}`);
});
