import { test } from "node:test";
import assert from "node:assert/strict";
import { ByteWriter, fromHex, pathByteLength, toHex } from "./bytes.js";
import { Push, Resp, TxtType } from "./codes.js";
import { decodeFrame, isPushFrame } from "./frames.js";
import { peerEntry, readMarkOf, readMarkValue } from "./peer.js";

const KEY = fromHex("0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20");

function contactBody(): ByteWriter {
  const path = new Uint8Array(64);
  path[0] = 0xab;
  path[1] = 0xcd;
  return new ByteWriter()
    .bytes(KEY)
    .u8(2) // repeater
    .u8(0x01) // favourite
    .u8(2) // two hops
    .bytes(path)
    .fixedString("Hill Repeater", 32)
    .u32(1_700_000_000)
    .i32(55_123_456)
    .i32(-3_500_000)
    .u32(1_700_000_100);
}

test("a contact frame is read field by field, positions in degrees", () => {
  const frame = decodeFrame(new ByteWriter().u8(Resp.Contact).bytes(contactBody().toBytes()).toBytes());
  assert.equal(frame.kind, "contact");
  if (frame.kind !== "contact") return;
  assert.equal(toHex(frame.contact.publicKey), toHex(KEY));
  assert.equal(frame.contact.type, 2);
  assert.equal(frame.contact.flags, 1);
  assert.equal(frame.contact.outPathLen, 2);
  assert.equal(frame.contact.outPath[0], 0xab);
  assert.equal(frame.contact.name, "Hill Repeater");
  assert.equal(frame.contact.lastAdvert, 1_700_000_000);
  assert.ok(Math.abs(frame.contact.lat - 55.123456) < 1e-9);
  assert.ok(Math.abs(frame.contact.lon - -3.5) < 1e-9);
  assert.equal(frame.contact.lastMod, 1_700_000_100);
});

test("a new-advert push carries the same body as a contact", () => {
  const frame = decodeFrame(new ByteWriter().u8(Push.NewAdvert).bytes(contactBody().toBytes()).toBytes());
  assert.equal(frame.kind, "newAdvert");
  assert.ok(isPushFrame(frame));
  if (frame.kind === "newAdvert") assert.equal(frame.contact.name, "Hill Repeater");
});

test("self info: the radio parameters and the name at the end", () => {
  const bytes = new ByteWriter()
    .u8(Resp.SelfInfo)
    .u8(1) // chat
    .i8(22)
    .i8(22)
    .bytes(KEY)
    .i32(0)
    .i32(0)
    .u8(3) // multi acks
    .u8(1) // advert loc policy
    .u8((2 << 4) | (1 << 2) | 2) // env=all, loc=flags, base=all
    .u8(0)
    .u32(869_161)
    .u32(62_500)
    .u8(7)
    .u8(7)
    .string("PKIO bot")
    .toBytes();
  const frame = decodeFrame(bytes);
  assert.equal(frame.kind, "selfInfo");
  if (frame.kind !== "selfInfo") return;
  assert.equal(frame.info.name, "PKIO bot");
  assert.equal(frame.info.frequencyKhz, 869_161);
  assert.equal(frame.info.bandwidthHz, 62_500);
  assert.equal(frame.info.spreadingFactor, 7);
  assert.equal(frame.info.codingRate, 7);
  assert.equal(frame.info.txPower, 22);
  assert.equal(frame.info.telemetryModeBase, 2);
  assert.equal(frame.info.telemetryModeLocation, 1);
  assert.equal(frame.info.telemetryModeEnvironment, 2);
  assert.equal(frame.info.multiAcks, 3);
});

test("device info: the fixed strings and the two bytes newer firmware adds", () => {
  const bytes = new ByteWriter()
    .u8(Resp.DeviceInfo)
    .u8(13)
    .u8(50) // MAX_CONTACTS / 2
    .u8(8)
    .u32(123456)
    .fixedString("14 Aug 2026", 12)
    .fixedString("Seeed XIAO C6", 40)
    .fixedString("v1.17.1", 20)
    .u8(1)
    .u8(0)
    .toBytes();
  const frame = decodeFrame(bytes);
  assert.equal(frame.kind, "deviceInfo");
  if (frame.kind !== "deviceInfo") return;
  assert.equal(frame.info.firmwareVerCode, 13);
  assert.equal(frame.info.maxContacts, 100);
  assert.equal(frame.info.maxChannels, 8);
  assert.equal(frame.info.blePin, 123456);
  assert.equal(frame.info.buildDate, "14 Aug 2026");
  assert.equal(frame.info.manufacturer, "Seeed XIAO C6");
  assert.equal(frame.info.firmwareVersion, "v1.17.1");
  assert.equal(frame.info.repeatEnabled, true);
  assert.equal(frame.info.pathHashMode, 0);
});

test("an older device info stops at the version and reports the rest as unknown", () => {
  const bytes = new ByteWriter()
    .u8(Resp.DeviceInfo)
    .u8(7)
    .u8(50)
    .u8(8)
    .u32(0)
    .fixedString("1 Jan 2025", 12)
    .fixedString("x", 40)
    .fixedString("v1.5.0", 20)
    .toBytes();
  const frame = decodeFrame(bytes);
  if (frame.kind !== "deviceInfo") throw new Error(frame.kind);
  assert.equal(frame.info.repeatEnabled, null);
  assert.equal(frame.info.pathHashMode, null);
});

test("a v3 contact message: SNR in quarter dB, direct marked by 0xff, signed text carries a signer", () => {
  const bytes = new ByteWriter()
    .u8(Resp.ContactMsgRecvV3)
    .i8(-10) // -2.5 dB
    .u8(0)
    .u8(0)
    .bytes(KEY.subarray(0, 6))
    .u8(0xff)
    .u8(TxtType.SignedPlain)
    .u32(1_700_000_000)
    .bytes(fromHex("deadbeef"))
    .string("hello from a room")
    .toBytes();
  const frame = decodeFrame(bytes);
  assert.equal(frame.kind, "contactMessage");
  if (frame.kind !== "contactMessage") return;
  assert.equal(frame.snr, -2.5);
  assert.equal(frame.pathLen, null);
  assert.equal(toHex(frame.senderPrefix), "010203040506");
  assert.equal(toHex(frame.signerPrefix!), "deadbeef");
  assert.equal(frame.text, "hello from a room");
});

test("a legacy contact message has no SNR and no reserved bytes", () => {
  const bytes = new ByteWriter()
    .u8(Resp.ContactMsgRecv)
    .bytes(KEY.subarray(0, 6))
    .u8(3)
    .u8(TxtType.Plain)
    .u32(1_700_000_000)
    .string("old firmware")
    .toBytes();
  const frame = decodeFrame(bytes);
  if (frame.kind !== "contactMessage") throw new Error(frame.kind);
  assert.equal(frame.snr, null);
  assert.equal(frame.pathLen, 3);
  assert.equal(frame.text, "old firmware");
});

test("a channel message keeps the sender prefix the firmware put in the text", () => {
  const bytes = new ByteWriter()
    .u8(Resp.ChannelMsgRecvV3)
    .i8(8)
    .u8(0)
    .u8(0)
    .u8(0)
    .u8(2)
    .u8(TxtType.Plain)
    .u32(1_700_000_000)
    .string("Alice: hi all")
    .toBytes();
  const frame = decodeFrame(bytes);
  if (frame.kind !== "channelMessage") throw new Error(frame.kind);
  assert.equal(frame.snr, 2);
  assert.equal(frame.channelIndex, 0);
  assert.equal(frame.pathLen, 2);
  assert.equal(frame.text, "Alice: hi all");
});

test("the hop count is the low six bits of path_len; the top two are the hash size", () => {
  const bytes = new ByteWriter()
    .u8(Resp.ChannelMsgRecvV3)
    .i8(16)
    .u8(0)
    .u8(0)
    .u8(0)
    .u8(0x41) // one two-byte hash
    .u8(TxtType.Plain)
    .u32(1_700_000_000)
    .string("DGG-Bratskaya: hi")
    .toBytes();
  const frame = decodeFrame(bytes);
  if (frame.kind !== "channelMessage") throw new Error(frame.kind);
  assert.equal(frame.pathLen, 1);
});

test("sent, and the confirmation that matches it by tag", () => {
  const sent = decodeFrame(new ByteWriter().u8(Resp.Sent).u8(1).u32(0xcafebabe).u32(4200).toBytes());
  assert.deepEqual(sent, { kind: "sent", flood: true, ackTag: 0xcafebabe, estTimeoutMs: 4200 });
  const confirmed = decodeFrame(new ByteWriter().u8(Push.SendConfirmed).u32(0xcafebabe).u32(1234).toBytes());
  assert.deepEqual(confirmed, { kind: "sendConfirmed", ackTag: 0xcafebabe, roundTripMs: 1234 });
});

test("an error frame carries its code; an empty one is code zero", () => {
  assert.deepEqual(decodeFrame(new Uint8Array([Resp.Err, 2])), { kind: "err", code: 2 });
  assert.deepEqual(decodeFrame(new Uint8Array([Resp.Err])), { kind: "err", code: 0 });
});

test("channel info is the index, a 32-byte name and a 16-byte secret", () => {
  const secret = fromHex("8b3387e9c5cdea6ac9e5edbaa115cd72");
  const frame = decodeFrame(new ByteWriter().u8(Resp.ChannelInfo).u8(0).fixedString("Public", 32).bytes(secret).toBytes());
  assert.deepEqual(frame, { kind: "channelInfo", index: 0, name: "Public", secret });
});

test("a telemetry push decodes the LPP it carries", () => {
  const bytes = new ByteWriter()
    .u8(Push.TelemetryResponse)
    .u8(0)
    .bytes(KEY.subarray(0, 6))
    // channel 1, voltage 4.12 V; channel 1, temperature 23.5 C
    .bytes(new Uint8Array([1, 0x74, 0x01, 0x9c, 1, 0x67, 0x00, 0xeb]))
    // the zeros that pad the 4-byte tag and these 8 bytes to one cipher block
    .bytes(new Uint8Array(4))
    .toBytes();
  const frame = decodeFrame(bytes);
  if (frame.kind !== "telemetryResponse") throw new Error(frame.kind);
  assert.deepEqual(frame.readings, [
    { channel: 1, type: "voltage", volts: 4.12 },
    { channel: 1, type: "temperature", celsius: 23.5 },
  ]);
});

test("a path discovery push splits the two paths by their length bytes", () => {
  const bytes = new ByteWriter()
    .u8(Push.PathDiscoveryResponse)
    .u8(0)
    .bytes(KEY.subarray(0, 6))
    .u8(2)
    .bytes(fromHex("aabb"))
    .u8(1)
    .bytes(fromHex("cc"))
    .toBytes();
  const frame = decodeFrame(bytes);
  if (frame.kind !== "pathDiscoveryResponse") throw new Error(frame.kind);
  assert.equal(toHex(frame.outPath), "aabb");
  assert.equal(toHex(frame.inPath), "cc");
});

test("path length bytes carry a hash size in the top two bits", () => {
  assert.equal(pathByteLength(3), 3);
  assert.equal(pathByteLength((1 << 6) | 3), 6);
  assert.equal(pathByteLength((3 << 6) | 2), 8);
});

test("a frame this client does not know is reported, not thrown, and a short one too", () => {
  const unknown = decodeFrame(new Uint8Array([0x7f, 1, 2, 3]));
  assert.equal(unknown.kind, "unknown");
  const short = decodeFrame(new Uint8Array([Resp.Contact, 1, 2, 3]));
  assert.equal(short.kind, "unknown");
  assert.equal(decodeFrame(new Uint8Array([])).kind, "unknown");
});

test("stats come in three shapes by their second byte", () => {
  const core = decodeFrame(new ByteWriter().u8(Resp.Stats).u8(0).u16(4100).u32(3600).u16(0).u8(2).toBytes());
  assert.deepEqual(core, { kind: "statsCore", batteryMv: 4100, uptimeSecs: 3600, errFlags: 0, queueLen: 2 });
  const radio = decodeFrame(new ByteWriter().u8(Resp.Stats).u8(1).u16(0xff9c).i8(-90).i8(20).u32(10).u32(20).toBytes());
  assert.deepEqual(radio, { kind: "statsRadio", noiseFloor: -100, lastRssi: -90, lastSnr: 5, txAirSecs: 10, rxAirSecs: 20 });
});

test("the phone's relay: its hello says which side this app is, and an entry carries a key and a value", () => {
  assert.deepEqual(decodeFrame(new Uint8Array([Push.Peer, 0, 1, 1])), { kind: "peerHello", version: 1, side: "computer" });
  assert.deepEqual(decodeFrame(new Uint8Array([Push.Peer, 0, 1, 0])), { kind: "peerHello", version: 1, side: "phone" });
  const entry = decodeFrame(peerEntry("r:ch:0", new Uint8Array([1, 2, 3])));
  assert.ok(isPushFrame(entry));
  assert.deepEqual(entry, { kind: "peerEntry", key: "r:ch:0", value: new Uint8Array([1, 2, 3]) });
  assert.equal(decodeFrame(new Uint8Array([Push.Peer, 1, 9, 65])).kind, "unknown", "one cut short");
  assert.equal(decodeFrame(new Uint8Array([Push.Peer, 7])).kind, "unknown", "a kind this app does not know");
  assert.deepEqual(readMarkOf(readMarkValue({ timestamp: 1_700_000_050, hash: 0xfedcba98 })), { timestamp: 1_700_000_050, hash: 0xfedcba98 });
});
