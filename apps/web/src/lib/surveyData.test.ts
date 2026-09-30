import { test } from "node:test";
import assert from "node:assert/strict";
import { FIX_AGE_MS, MOVE_M, PING_EVERY_MS, bestReply, metresToGo, onMap, pointTone, repeaterRows, surveyStats, surveyStep, toneFor, type Survey, type SurveyPoint } from "./surveyData.js";

const reply = (key: string, us: number, them: number) => ({ key, us, them, rssi: -90 });
const point = (at: number, lat: number, lon: number, replies = [reply("aa", 2, 3)]): SurveyPoint => ({ at, lat, lon, accuracy: 5, replies });

test("a point takes the repeater that hears and is heard best, by the worse of the two ways", () => {
  const p = point(0, 55, 73, [reply("aa", 6, -7), reply("bb", 1, 2)]);
  assert.equal(bestReply(p)?.key, "bb");
  assert.equal(pointTone(p), "good");
  assert.equal(pointTone(point(0, 55, 73, [reply("aa", 6, -3)])), "fair");
  assert.equal(pointTone(point(0, 55, 73, [reply("aa", -8, 4)])), "weak");
  assert.equal(pointTone(point(0, 55, 73, [])), "none");
});

test("the survey waits for a good fix, the half minute and a move, then asks", () => {
  const now = 1_000_000;
  const fix = { lat: 55, lon: 73, accuracy: 8, at: now };
  assert.equal(surveyStep(now, null, null, null), "gps");
  assert.equal(surveyStep(now, { ...fix, accuracy: 140 }, null, null), "gps");
  assert.equal(surveyStep(now, { ...fix, at: now - FIX_AGE_MS - 1 }, null, null), "gps");
  assert.equal(surveyStep(now, fix, null, null), "ping");
  const last = point(now - PING_EVERY_MS, 55, 73);
  assert.equal(surveyStep(now, fix, now - 10_000, last), "wait");
  assert.equal(surveyStep(now, fix, now - PING_EVERY_MS, last), "still");
  // About 110 m north.
  assert.equal(surveyStep(now, { ...fix, lat: 55.001 }, now - PING_EVERY_MS, last), "ping");
});

test("standing still, the way left to the next ask is what is missing to the move", () => {
  const fix = { lat: 55, lon: 73, accuracy: 8, at: 0 };
  const last = point(0, 55, 73);
  assert.equal(metresToGo(fix, last), MOVE_M);
  // About 22 m north.
  assert.equal(metresToGo({ ...fix, lat: 55.0002 }, last), MOVE_M - 22);
  assert.equal(metresToGo({ ...fix, lat: 55.001 }, last), 0);
  assert.equal(metresToGo(null, last), null);
  assert.equal(metresToGo(fix, null), null);
});

test("a drive adds up its time, distance, points and answers, and its repeaters by points", () => {
  const survey: Survey = {
    id: "s",
    radio: "ab",
    startedAt: 0,
    endedAt: 600_000,
    nodes: {},
    points: [point(0, 55, 73, [reply("aa", 1, 1)]), point(30_000, 55.01, 73, [reply("aa", -2, 4), reply("bb", 5, 5)]), point(60_000, 55.02, 73, [])],
  };
  const stats = surveyStats(survey);
  assert.equal(stats.ms, 600_000);
  assert.equal(stats.points, 3);
  assert.equal(stats.answered, 2);
  assert.ok(Math.abs(stats.km - 2.22) < 0.02);
  const rows = repeaterRows(survey);
  assert.deepEqual(rows.map((r) => [r.key, r.count]), [["aa", 2], ["bb", 1]]);
  assert.equal(rows[0]!.best.us, 1);
  assert.equal(toneFor(survey.points[1]!, "bb"), "good");
  assert.equal(toneFor(survey.points[2]!, "bb"), "off");
});

test("a survey is on a map once it has been sent to one", () => {
  const survey: Survey = { id: "s", radio: "ab", startedAt: 0, endedAt: 1, nodes: {}, points: [] };
  assert.equal(onMap(survey), false);
  assert.equal(onMap({ ...survey, sent: {} }), false);
  assert.equal(onMap({ ...survey, sent: { meshcoretel: { at: 5, points: 3 } } }), true);
});
