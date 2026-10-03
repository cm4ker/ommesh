import { test } from "node:test";
import assert from "node:assert/strict";
import type { LppReading } from "@meshnet/meshcore";
import { firstSource, getPlace, radioPosition, rememberRough, sendsRough, setPlace, startsRough, updatePlace, type PlaceDraft } from "./placeDraft.js";

const NOW = 1_000_000_000;
const radio = { lat: 55.02, lon: 73.36 };

test("a new place starts from the phone that knows where it is", () => {
  const fix = { lat: 55.03, lon: 73.37, accuracy: 8, at: NOW - 30_000 };
  assert.equal(firstSource({ fix, canLocate: true, radio, radioGps: true, now: NOW }), "phone");
});

test("a stale or rough fix gives way to the radio's GPS, but not to a position typed into the radio", () => {
  const stale = { lat: 55.03, lon: 73.37, accuracy: 8, at: NOW - 10 * 60_000 };
  const rough = { lat: 55.03, lon: 73.37, accuracy: 900, at: NOW };
  assert.equal(firstSource({ fix: stale, canLocate: true, radio, radioGps: true, now: NOW }), "radio");
  assert.equal(firstSource({ fix: rough, canLocate: true, radio, radioGps: true, now: NOW }), "radio");
  assert.equal(firstSource({ fix: stale, canLocate: true, radio, radioGps: false, now: NOW }), "phone");
});

test("with nothing that can look, the radio's set position, and with no position at all, nothing", () => {
  assert.equal(firstSource({ fix: null, canLocate: false, radio, radioGps: false, now: NOW }), "radio");
  assert.equal(firstSource({ fix: null, canLocate: false, radio: null, radioGps: false, now: NOW }), null);
});

test("a radio with GPS is where its GPS last said, else where it was put", () => {
  const readings: LppReading[] = [
    { channel: 1, type: "voltage", volts: 4.1 },
    { channel: 1, type: "gps", lat: 55.0412, lon: 73.3921, alt: 90 },
  ];
  assert.deepEqual(radioPosition(radio, readings, true), { lat: 55.0412, lon: 73.3921 });
  assert.deepEqual(radioPosition(radio, readings, false), radio);
  assert.deepEqual(radioPosition(radio, undefined, true), radio);
  assert.equal(radioPosition({ lat: 0, lon: 0 }, undefined, false), null);
});

test("a point put by hand goes exactly, whatever the chat asked for", () => {
  const draft: PlaceDraft = { source: "phone", lat: 55, lon: 73, accuracy: 8, rough: true, open: true };
  assert.equal(sendsRough(draft), true);
  assert.equal(sendsRough({ ...draft, source: "point" }), false);
});

test("a chat keeps its place and remembers how its last one went", () => {
  assert.equal(startsRough("r1", "c:aa", false), false);
  assert.equal(startsRough("r1", "ch:0", true), true);
  rememberRough("r1", "ch:0", false);
  assert.equal(startsRough("r1", "ch:0", true), false);
  setPlace("r1", "c:aa", { source: "phone", lat: 55, lon: 73, accuracy: 8, rough: false, open: true });
  updatePlace("r1", "c:aa", { open: false });
  assert.equal(getPlace("r1", "c:aa")?.open, false);
  assert.equal(getPlace("r2", "c:aa"), null);
  setPlace("r1", "c:aa", null);
  assert.equal(getPlace("r1", "c:aa"), null);
});
