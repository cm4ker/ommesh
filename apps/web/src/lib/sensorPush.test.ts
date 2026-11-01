import { test } from "node:test";
import assert from "node:assert/strict";
import type { LppReading } from "@meshnet/meshcore";
import { defaultThresholds, deltaLabel, fits, pushTargets, thresholdSteps, withThreshold } from "./sensorPush.js";
import { setPressureUnit, setTemperatureUnit } from "./units.js";

// The sensor's own units, whatever the machine's region would pick.
setPressureUnit("hpa");
setTemperatureUnit("c");

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

test("steps in mm Hg and °F go to the sensor in hPa and °C, to a tenth, and read back as offered", () => {
  const mmHg = { pressure: "mmhg", temperature: "c" } as const;
  assert.deepEqual(thresholdSteps("barometer", mmHg), [0.7, 1.3, 2.7, 6.7]);
  assert.equal(deltaLabel("barometer", 1.3, mmHg), "1 mmHg");
  assert.equal(deltaLabel("barometer", 1, mmHg), "0.8 mmHg", "one set in hPa reads converted");
  const fahrenheit = { pressure: "hpa", temperature: "f" } as const;
  assert.deepEqual(thresholdSteps("temperature", fahrenheit), [0.3, 0.6, 1.1, 2.8]);
  assert.equal(deltaLabel("temperature", 0.6, fahrenheit), "1 °F");
  assert.equal(deltaLabel("temperature", 0.5, fahrenheit), "0.9 °F", "a change, not a temperature: no 32 added");
  assert.deepEqual(thresholdSteps("humidity", mmHg), [1, 2, 5, 10], "the rest as they were");
});
