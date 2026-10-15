import { test } from "node:test";
import assert from "node:assert/strict";
import { fromHex, toHex } from "./bytes.js";
import { Cmd, MAX_TEXT_LEN } from "./codes.js";
import * as cmd from "./commands.js";

const KEY = fromHex("0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20");

test("app start: the code, seven reserved bytes, the name", () => {
  const bytes = cmd.appStart("Meshnet");
  assert.equal(bytes[0], Cmd.AppStart);
  assert.deepEqual([...bytes.subarray(1, 8)], [0, 0, 0, 0, 0, 0, 0]);
  assert.equal(new TextDecoder().decode(bytes.subarray(8)), "Meshnet");
});

test("device query names the protocol version this client speaks", () => {
  assert.deepEqual([...cmd.deviceQuery()], [Cmd.DeviceQuery, 3]);
});

test("a direct message: type, attempt, timestamp, six bytes of key, text", () => {
  const bytes = cmd.sendTextMessage(KEY, "hi", { attempt: 2, timestamp: 0x01020304 });
  assert.equal(bytes[0], Cmd.SendTxtMsg);
  assert.equal(bytes[1], 0);
  assert.equal(bytes[2], 2);
  assert.deepEqual([...bytes.subarray(3, 7)], [4, 3, 2, 1]);
  assert.equal(toHex(bytes.subarray(7, 13)), "010203040506");
  assert.equal(new TextDecoder().decode(bytes.subarray(13)), "hi");
});

test("a channel message leaves room for the sender name the firmware prepends", () => {
  const text = "x".repeat(MAX_TEXT_LEN - 6);
  assert.throws(() => cmd.sendChannelTextMessage(0, text, { senderName: "Alice" }), /at most 153/);
  assert.equal(cmd.sendChannelTextMessage(0, "x".repeat(153), { senderName: "Alice", timestamp: 0 }).length, 7 + 153);
});

test("text over the radio's limit is refused here rather than truncated there", () => {
  assert.throws(() => cmd.sendTextMessage(KEY, "y".repeat(MAX_TEXT_LEN + 1)), /at most 160/);
  assert.throws(() => cmd.sendTextMessage(KEY, "\u{1F600}".repeat(41)), /164 bytes/);
});

test("get contacts with and without a cursor", () => {
  assert.deepEqual([...cmd.getContacts()], [Cmd.GetContacts]);
  assert.deepEqual([...cmd.getContacts(0x01020304)], [Cmd.GetContacts, 4, 3, 2, 1]);
});

test("radio params in kHz and Hz, with the repeat flag only when asked", () => {
  const bytes = cmd.setRadioParams({ frequencyKhz: 869_161, bandwidthHz: 62_500, spreadingFactor: 7, codingRate: 7 });
  assert.equal(bytes.length, 11);
  assert.equal(bytes[9], 7);
  const withRepeat = cmd.setRadioParams({ frequencyKhz: 1, bandwidthHz: 1, spreadingFactor: 1, codingRate: 1, repeat: true });
  assert.equal(withRepeat.length, 12);
  assert.equal(withRepeat[11], 1);
});

test("add/update contact is the contact record with the command in front", () => {
  const bytes = cmd.addUpdateContact({
    publicKey: KEY,
    type: 1,
    flags: 1,
    outPathLen: 0xff,
    outPath: new Uint8Array(0),
    name: "Bob",
    lastAdvert: 1,
    lat: 55.5,
    lon: -3.25,
    lastMod: 42,
  });
  assert.equal(bytes.length, 1 + 32 + 1 + 1 + 1 + 64 + 32 + 4 + 4 + 4 + 4);
  assert.equal(bytes[0], Cmd.AddUpdateContact);
  assert.equal(bytes[35], 0xff);
  assert.equal(new TextDecoder().decode(bytes.subarray(100, 103)), "Bob");
});

test("a channel secret is exactly sixteen bytes", () => {
  assert.throws(() => cmd.setChannel(1, "x", new Uint8Array(8)), /16 bytes/);
  const bytes = cmd.setChannel(1, "Friends", new Uint8Array(16));
  assert.equal(bytes.length, 2 + 32 + 16);
});

test("reboot and factory reset carry the words the firmware checks", () => {
  assert.equal(new TextDecoder().decode(cmd.reboot().subarray(1)), "reboot");
  assert.equal(new TextDecoder().decode(cmd.factoryReset().subarray(1)), "reset");
});

test("a telemetry request for the radio itself is four bytes", () => {
  assert.equal(cmd.sendTelemetryReq().length, 4);
  assert.equal(cmd.sendTelemetryReq(KEY).length, 36);
});

test("other params pack three telemetry modes into one byte", () => {
  const bytes = cmd.setOtherParams({
    manualAddContacts: 1,
    telemetryModeBase: 2,
    telemetryModeLocation: 1,
    telemetryModeEnvironment: 0,
    advertLocPolicy: 1,
    multiAcks: 0,
  });
  assert.deepEqual([...bytes], [Cmd.SetOtherParams, 1, (1 << 2) | 2, 1, 0]);
});

test("a key of the wrong length is refused", () => {
  assert.throws(() => cmd.removeContact(new Uint8Array(31)), /32 bytes/);
});

test("a path's length byte carries the hops and the bytes per hop, as the firmware reads it", () => {
  // Two hops of two bytes each: hash size 2 in the top bits, two hops below.
  const raw = cmd.sendRawData(fromHex("a1b2c3d4"), fromHex("00112233"), 2);
  assert.deepEqual([...raw.subarray(0, 6)], [Cmd.SendRawData, (1 << 6) | 2, 0xa1, 0xb2, 0xc3, 0xd4]);
  // One-byte hops read as before 1.18: the length is the hop count.
  assert.equal(cmd.sendRawData(fromHex("a1b2"), fromHex("00112233"))[1], 2);
  assert.equal(cmd.sendChannelData(1, 0xff0e, fromHex("01"), fromHex("a1b2c3"), 3)[2], (2 << 6) | 1);
  assert.throws(() => cmd.sendRawData(fromHex("a1b2c3"), fromHex("00112233"), 2), /2-byte hops/);
});
