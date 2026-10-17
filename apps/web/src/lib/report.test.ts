import { test } from "node:test";
import assert from "node:assert/strict";
import type { SessionState } from "@meshnet/meshcore";
import { radioLines, redact, reportText } from "./report.js";

const state = {
  status: "ready",
  link: { kind: "ble", label: "MeshCore-Node-21" },
  sharedAt: null,
  device: { firmwareVerCode: 13, maxContacts: 350, maxChannels: 40, blePin: 123456, buildDate: "13 Oct 2026", manufacturer: "Heltec V4", firmwareVersion: "v1.17.1", repeatEnabled: false, pathHashMode: 0 },
  self: { name: "Node-21", key: "a0a1", prefix: "a0a1", lat: 55.75, lon: 37.62, frequencyKhz: 869_525, bandwidthHz: 250_000, spreadingFactor: 11, codingRate: 5, txPower: 22, maxTxPower: 22 },
  contacts: { a: { unsaved: false }, b: { unsaved: true } },
  channels: [{ index: 0 }, { index: 1 }],
  tuning: { rxDelayBase: 0, airtimeFactor: 1 },
  region: { name: "msk" },
} as unknown as SessionState;

test("the radio's lines say how it is set up, never its name, key, position or PIN", () => {
  const lines = radioLines(state).join("\n");
  assert.match(lines, /firmware: v1\.17\.1 \(13 Oct 2026\), protocol 13, Heltec V4/);
  assert.match(lines, /passes others' packets on: no; route hash: 1 byte\(s\)/);
  assert.match(lines, /contacts: 1 of 350; channels: 2 of 40/);
  assert.match(lines, /air: 869\.525 MHz, 250 kHz, SF11, CR 4\/5, 22 of 22 dBm/);
  assert.match(lines, /airtime factor: 1/);
  assert.match(lines, /region: set/);
  for (const secret of ["Node-21", "a0a1", "55.75", "37.62", "123456", "msk"]) assert.ok(!lines.includes(secret), secret);
});

test("a command someone asked this radio to run is cut out of the log", () => {
  assert.equal(redact('Wan8 asked this radio to run "password hunter2"; not run'), "Wan8 asked this radio to run a command; not run");
  assert.equal(redact("connected to Node-21 (v1.17.1)"), "connected to Node-21 (v1.17.1)");
});

test("the report reads top to bottom: the app, the radio, what stopped, then the log oldest first", () => {
  const at = new Date(2026, 9, 17, 14, 3, 22).getTime();
  const text = reportText({
    app: "Ommesh 0.9.1 · android · ru",
    agent: "Mozilla/5.0",
    zoneMin: 180,
    radio: ["link: ble, ready"],
    now: "16 packet(s) waiting to go out",
    stops: ["2026-10-17 13:00:00 page: crashed"],
    log: [
      { at, kind: "link", text: "connected" },
      { at: at + 1000, kind: "radio", text: "sendTracePath: table full" },
    ],
  });
  assert.equal(
    text,
    [
      "app: Ommesh 0.9.1 · android · ru",
      "agent: Mozilla/5.0",
      "times: UTC+3",
      "",
      "radio:",
      "  link: ble, ready",
      "  now: 16 packet(s) waiting to go out",
      "",
      "app stopped:",
      "  2026-10-17 13:00:00 page: crashed",
      "",
      "log:",
      "2026-10-17 14:03:22 link      connected",
      "2026-10-17 14:03:23 radio     sendTracePath: table full",
    ].join("\n"),
  );
  assert.match(reportText({ app: "", agent: "", zoneMin: -270, radio: [], now: null, stops: [], log: [] }), /times: UTC-4:30/);
});
