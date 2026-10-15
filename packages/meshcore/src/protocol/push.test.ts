import { test } from "node:test";
import assert from "node:assert/strict";
import { ByteWriter } from "./bytes.js";
import { ReqType } from "./codes.js";
import { encodeThresholds, readPushed, readSubscribeAnswer, subscribeRequest, thresholdBytes, type PushThreshold } from "./push.js";

const WEATHER: PushThreshold[] = [
  { channel: 2, type: "temperature", delta: 0.5 },
  { channel: 2, type: "humidity", delta: 2 },
  { channel: 2, type: "barometer", delta: 1 },
];

test("thresholds go as LPP in each type's width and scale, big-endian", () => {
  assert.deepEqual([...encodeThresholds(WEATHER)], [2, 103, 0, 5, 2, 104, 4, 2, 115, 0, 10]);
  assert.deepEqual([...encodeThresholds([{ channel: 1, type: "voltage", delta: 0.05 }])], [1, 116, 0, 5]);
  assert.equal(thresholdBytes("humidity"), 3);
});

test("no more thresholds than the sensor keeps", () => {
  assert.throws(() => encodeThresholds([...WEATHER, { channel: 1, type: "voltage", delta: 0.05 }]), /14 bytes/);
});

test("a subscribe names its tag, its time, then the thresholds", () => {
  const bytes = subscribeRequest(0x01020304, 99_999, WEATHER);
  assert.equal(bytes[0], ReqType.Subscribe);
  assert.deepEqual([...bytes.subarray(1, 5)], [4, 3, 2, 1], "the tag, little-endian as the firmware copies it");
  assert.deepEqual([...bytes.subarray(5, 7)], [0xff, 0xff], "at most the two bytes' worth of seconds");
  assert.deepEqual([...bytes.subarray(7, 9)], [0, 11]);
  assert.equal(bytes.length, 9 + 11);
  assert.throws(() => subscribeRequest(1, 60, []), /at least one/);
});

test("the sensor's answer says for how long and under which region, or 0 when it will not", () => {
  assert.deepEqual(readSubscribeAnswer(new ByteWriter().u16(65535).u16(0).string("omsk").toBytes()), { secs: 65535, region: "omsk" });
  assert.deepEqual(readSubscribeAnswer(new ByteWriter().u16(0).u16(0).toBytes()), { secs: 0, region: null });
});

test("what a sensor sends by itself is its clock, then its telemetry", () => {
  const data = new ByteWriter().u32(1_700_000_000).bytes(new Uint8Array([2, 103, 0, 148, 2, 104, 126])).toBytes();
  const pushed = readPushed(data);
  assert.equal(pushed.time, 1_700_000_000);
  assert.deepEqual(pushed.readings, [
    { channel: 2, type: "temperature", celsius: 14.8 },
    { channel: 2, type: "humidity", percent: 63 },
  ]);
});
