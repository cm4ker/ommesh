import { test } from "node:test";
import assert from "node:assert/strict";
import type { Survey } from "./surveyData.js";
import { geohash, surveyCsv, surveyFileName, surveyGpx, surveyJson, surveyKml } from "./surveyFiles.js";

const survey: Survey = {
  id: "s",
  radio: "a1b2c3d4e5f6",
  startedAt: Date.UTC(2026, 8, 27, 8, 0, 0),
  endedAt: Date.UTC(2026, 8, 27, 8, 20, 0),
  nodes: {},
  points: [
    { at: Date.UTC(2026, 8, 27, 8, 0, 0), lat: 55.03, lon: 73.37, accuracy: 6.4, replies: [{ key: "0f1e2d3c4b5a", us: -1.5, them: 4.25, rssi: -91 }, { key: "99887766", us: 3, them: 2, rssi: -80 }] },
    { at: Date.UTC(2026, 8, 27, 8, 0, 30), lat: 55.035, lon: 73.371, accuracy: 9, replies: [] },
  ],
};
const name = (key: string) => (key.startsWith("0f") ? 'Hill, "north"' : "Tower");

test("geohash matches the reference encoder", () => {
  assert.equal(geohash(57.64911, 10.40744, 11), "u4pruydqqvj");
  assert.equal(geohash(55.03, 73.37).length, 8);
});

test("the JSON is Wardrive's format, one sample a point, with the repeater the radio heard best", () => {
  const data = JSON.parse(surveyJson(survey, name));
  assert.equal(data._format, "meshcore_wardrive_data");
  assert.equal(data._version, 2);
  assert.equal(data.samples.length, 2);
  const [first, second] = data.samples;
  assert.equal(first.path, "0F1E2D3C");
  assert.equal(first.snr, 4);
  assert.equal(first.rssi, -91);
  assert.equal(first.pingSuccess, true);
  assert.equal(first.timestamp, "2026-09-27T08:00:00.000Z");
  assert.equal(first.ommesh.replies.length, 2);
  assert.equal(second.path, null);
  assert.equal(second.pingSuccess, false);
  assert.equal(data.sessions[0].sampleCount, 2);
  assert.equal(data.sessions[0].successCount, 1);
  assert.ok(Number.isInteger(data.sessions[0].distanceMeters));
});

test("GPX, KML and CSV carry every point, and escape names", () => {
  const gpx = surveyGpx(survey, name);
  assert.equal(gpx.match(/<trkpt /g)?.length, 2);
  assert.ok(gpx.includes("Hill, &quot;north&quot;: ↑-1.5 ↓+4.25 dB"));
  const kml = surveyKml(survey, name);
  assert.equal(kml.match(/<Point>/g)?.length, 2);
  assert.ok(kml.includes("<styleUrl>#good</styleUrl>") && kml.includes("<styleUrl>#none</styleUrl>"));
  const csv = surveyCsv(survey, name).trim().split("\n");
  assert.equal(csv.length, 4);
  assert.ok(csv[1]!.includes('"Hill, ""north"""'));
  assert.ok(csv[3]!.endsWith(",,,,"));
  assert.match(surveyFileName(survey, "csv"), /^ommesh-survey-2026-09-27-\d{4}\.csv$/);
});
