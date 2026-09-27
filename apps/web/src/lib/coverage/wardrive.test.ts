import { test } from "node:test";
import assert from "node:assert/strict";
import type { Survey } from "../surveyData.js";
import { batches, readUploadReply, wardriveSamples } from "./wardrive.js";

const survey: Survey = {
  id: "s",
  radio: "a1b2c3d4e5f6",
  startedAt: Date.UTC(2026, 8, 27, 8, 0, 0),
  endedAt: Date.UTC(2026, 8, 27, 8, 20, 0),
  nodes: {},
  points: [
    { at: Date.UTC(2026, 8, 27, 8, 0, 0), lat: 55.03, lon: 73.37, accuracy: 6, replies: [{ key: "0f1e2d3c4b5a", us: -1.5, them: 4.25, rssi: -91.4 }, { key: "99887766", us: 3, them: 2, rssi: -80 }] },
    { at: Date.UTC(2026, 8, 27, 8, 0, 30), lat: 55.035, lon: 73.371, accuracy: 9, replies: [] },
  ],
};

test("a ping is one sample naming the repeater the radio heard best, as Wardrive uploads it", () => {
  const [first, second] = wardriveSamples(survey, (key) => (key.startsWith("0f") ? "Hill" : "Tower"), "0.3.0");
  assert.deepEqual(first, {
    id: `${survey.points[0]!.at}_A1B2C3D4_0`,
    nodeId: "0F1E2D3C",
    repeaterName: "Hill",
    latitude: 55.03,
    longitude: 73.37,
    rssi: -91,
    snr: 4,
    pingSuccess: true,
    timestamp: "2026-09-27T08:00:00.000Z",
    appVersion: "Ommesh 0.3.0",
    source: "Ommesh",
  });
  assert.equal(second!.nodeId, "Unknown");
  assert.equal(second!.pingSuccess, false);
  assert.equal(second!.snr, null);
});

test("samples go a hundred at a time, and a map's answer is read whatever it leaves out", () => {
  assert.deepEqual(batches([...Array(250).keys()]).map((b) => b.length), [100, 100, 50]);
  assert.deepEqual(readUploadReply('{"success":true,"samplesReceived":3,"samplesProcessed":2,"samplesDeduped":1,"cellsCreated":1,"cellsUpdated":0}'), { received: 3, processed: 2, deduped: 1, cellsCreated: 1, cellsUpdated: 0 });
  assert.deepEqual(readUploadReply("not json"), { received: 0, processed: 0, deduped: 0, cellsCreated: 0, cellsUpdated: 0 });
  assert.equal(readUploadReply({ samplesReceived: 5 }).received, 5);
});
