import { test } from "node:test";
import assert from "node:assert/strict";
import type { LppReading, SeriesSummary } from "@meshnet/meshcore";
import { batteryPercent, emojiOnly, errorShare, lowCharge, powerSummary, powerWatts, span, steadyMv, trailingEmoji } from "./format.js";

test("the emoji a name ends with goes on its circle", () => {
  assert.equal(trailingEmoji("Fox 🦊"), "🦊");
  assert.equal(trailingEmoji("Kolya ⛺ "), "⛺");
  assert.equal(trailingEmoji("Base 🇩🇪"), "🇩🇪");
  assert.equal(trailingEmoji("Dad 👨‍👩‍👧"), "👨‍👩‍👧");
  assert.equal(trailingEmoji("Love ❤️"), "❤️");
});

test("a name ending in a letter, a digit or a text symbol has no emoji", () => {
  assert.equal(trailingEmoji("Anna"), null);
  assert.equal(trailingEmoji("🦊 Fox"), null);
  assert.equal(trailingEmoji("Node-21"), null);
  assert.equal(trailingEmoji("Acme ©"), null);
  assert.equal(trailingEmoji(""), null);
});

test("a message of one to three emoji and nothing else is drawn large (#41)", () => {
  assert.equal(emojiOnly("👋"), 1);
  assert.equal(emojiOnly(" 👋🏽 "), 1);
  assert.equal(emojiOnly("🇩🇪 ❤️"), 2);
  assert.equal(emojiOnly("👨‍👩‍👧👍1️⃣"), 3);
});

test("text, a digit, a text symbol or a fourth emoji keeps the bubble", () => {
  assert.equal(emojiOnly("hi 👋"), 0);
  assert.equal(emojiOnly("1"), 0);
  assert.equal(emojiOnly("©"), 0);
  assert.equal(emojiOnly("👋👋👋👋"), 0);
  assert.equal(emojiOnly(""), 0);
  assert.equal(emojiOnly("  "), 0);
});

test("a LiFePO4 cell near full reads near full, not nearly empty (#26)", () => {
  assert.equal(batteryPercent(3350, "lifepo4"), 90);
  assert.equal(batteryPercent(3350), 8);
  assert.equal(batteryPercent(3650, "lifepo4"), 100);
  assert.equal(batteryPercent(3200, "lifepo4"), 20);
});

test("a full LiFePO4 is not low, though a Li-ion at its volts would be (#31)", () => {
  assert.equal(lowCharge(3430, "lifepo4"), false);
  assert.equal(lowCharge(3430), true);
});

test("a cell is low at 20% of its own curve and below", () => {
  assert.equal(lowCharge(3530), true);
  assert.equal(lowCharge(3550), false);
  assert.equal(lowCharge(3200, "lifepo4"), true);
  assert.equal(lowCharge(3230, "lifepo4"), false);
  assert.equal(lowCharge(0), false);
});

test("a sodium cell and two titanate cells in series read off their own curves", () => {
  assert.equal(batteryPercent(4000, "naion"), 100);
  assert.equal(batteryPercent(3220, "naion"), 50);
  assert.equal(lowCharge(2450, "naion"), true);
  assert.equal(batteryPercent(1800, "naion"), 0);
  assert.equal(batteryPercent(5600, "lto2s"), 100);
  assert.equal(batteryPercent(4780, "lto2s"), 50);
  assert.equal(batteryPercent(3600, "lto2s"), 0);
  // Read as Li-ion, a titanate pack at a quarter of its charge would look full.
  assert.equal(batteryPercent(4600), 100);
  assert.equal(batteryPercent(4600, "lto2s"), 23);
  assert.equal(lowCharge(4440, "lto2s"), true);
});

test("a charge is read off the curve, straight between its points, and kept within 0 to 100", () => {
  assert.equal(batteryPercent(3890), 70);
  assert.equal(batteryPercent(3940), 75);
  assert.equal(batteryPercent(4200), 100);
  assert.equal(batteryPercent(3100), 0);
  assert.equal(batteryPercent(2800), 0);
  assert.equal(batteryPercent(2500, "lifepo4"), 0);
});

test("a battery reads as the mean of its last half hour, so one wandering reading does not swing the charge", () => {
  const min = 60 * 1000;
  // A LiFePO4 whose radio read 3.21, 3.31 and 3.22 V: 23, 77 and 27% one by one.
  const samples = [
    { at: 0, mv: 3330 },
    { at: 50 * min, mv: 3210 },
    { at: 60 * min, mv: 3310, n: 2 },
    { at: 70 * min, mv: 3220 },
  ];
  assert.equal(steadyMv(samples, 3220), 3263);
  assert.equal(batteryPercent(steadyMv(samples, 3220), "lifepo4"), 53);
  assert.equal(steadyMv([], 3220), 3220);
  assert.equal(steadyMv([{ at: 0, mv: 3300 }], 3220), 3300);
});

test("power comes from the channel's voltage and current, not the whole watts it is sent in", () => {
  const readings: LppReading[] = [
    { channel: 4, type: "voltage", volts: 3.38 },
    { channel: 4, type: "current", amps: 0.119 },
    { channel: 4, type: "power", watts: 0 },
    { channel: 5, type: "power", watts: 2 },
  ];
  assert.equal(Math.round(powerWatts({ channel: 4, watts: 0 }, readings) * 1000), 402);
  // Without both on its channel, what was sent stands.
  assert.equal(powerWatts({ channel: 5, watts: 2 }, readings), 2);
});

test("a power series comes from the channel's voltage and current series", () => {
  const series: SeriesSummary[] = [
    { channel: 4, lppType: 0x74, min: 3.3, max: 3.4, avg: 3.38 },
    { channel: 4, lppType: 0x75, min: 0.1, max: 0.13, avg: 0.119 },
    { channel: 4, lppType: 0x80, min: 0, max: 0, avg: 0 },
    { channel: 5, lppType: 0x80, min: 1, max: 3, avg: 2 },
  ];
  const mw = (w: number) => Math.round(w * 1000);
  const power = powerSummary(series[2]!, series);
  assert.deepEqual([mw(power.min), mw(power.avg), mw(power.max)], [330, 402, 442]);
  assert.deepEqual(powerSummary(series[3]!, series), series[3]);
});

test("the receive errors are a share of everything heard, the errors included", () => {
  assert.equal(errorShare(950, 2971)!.toFixed(1), "24.2");
  assert.equal(errorShare(2, 2971)!.toFixed(3), "0.067");
  assert.equal(errorShare(5, 0), 100);
});

test("no receive error has no share", () => {
  assert.equal(errorShare(0, 2971), null);
  assert.equal(errorShare(0, 0), null);
});

test("a stretch of time reads in its largest whole unit, either way", () => {
  assert.equal(span(47), "47 s");
  assert.equal(span(-300), "5 min");
  assert.equal(span(-299.6), "5 min");
  assert.equal(span(3 * 3600 + 600), "3 h");
  assert.equal(span(868 * 86_400), "868 d");
});
