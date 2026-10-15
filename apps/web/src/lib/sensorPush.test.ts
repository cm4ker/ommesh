import { test } from "node:test";
import assert from "node:assert/strict";
import type { LppReading } from "@meshnet/meshcore";
import { defaultThresholds, fits, pushTargets, withThreshold } from "./sensorPush.js";

const WEATHER: LppReading[] = [
  { channel: 1, type: "voltage", volts: 3.98 },
  { channel: 1, type: "temperature", celsius: 31 },
  { channel: 2, type: "barometer", hpa: 1012.4 },
  { channel: 2, type: "temperature", celsius: 14.2 },
  { channel: 2, type: "humidity", percent: 63 },
];

test("the air comes first, the sensor's own battery last, and its processor's temperature not at all", () => {
  assert.deepEqual(pushTargets(WEATHER), [
    { channel: 2, type: "temperature" },
    { channel: 2, type: "humidity" },
    { channel: 2, type: "barometer" },
    { channel: 1, type: "voltage" },
  ]);
});

test("a sensor starts with what fits in its fourteen bytes, each at its second step", () => {
  assert.deepEqual(defaultThresholds(WEATHER), [
    { channel: 2, type: "temperature", delta: 0.5 },
    { channel: 2, type: "humidity", delta: 2 },
    { channel: 2, type: "barometer", delta: 1 },
  ]);
  assert.deepEqual(defaultThresholds([{ channel: 1, type: "temperature", celsius: 30 }]), [], "nothing worth sending");
});

test("one more fits only while there is room, and a changed one keeps its place", () => {
  const chosen = defaultThresholds(WEATHER);
  assert.ok(!fits(chosen, { channel: 1, type: "voltage" }));
  assert.ok(fits(chosen, { channel: 2, type: "humidity" }), "one already chosen always fits");
  const fewer = withThreshold(chosen, { channel: 2, type: "barometer" }, null);
  assert.ok(fits(fewer, { channel: 1, type: "voltage" }));
  assert.deepEqual(withThreshold(chosen, { channel: 2, type: "humidity" }, 5)[1], { channel: 2, type: "humidity", delta: 5 });
});
