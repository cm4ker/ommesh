import { test } from "node:test";
import assert from "node:assert/strict";
import { ByteWriter, fromHex, toHex } from "./bytes.js";
import { parseAdvert, parseRawPacket, PayloadType, RouteType } from "./packet.js";

// Two copies of one channel message as repeaters sent it on, from a radio's RX log on 2026-09-21.
const PAYLOAD = "11d6dc2c479b3854d1d8b3808da05c1d141c4d152dd08b762da12b88d12d4e7620586110eff7c0e0c6b788ec71a11ebbba2c92";

test("a flooded packet: header, two-byte hashes in the path, payload to the end", () => {
  const one = parseRawPacket(fromHex("1541ce5b" + PAYLOAD))!;
  assert.equal(one.routeType, RouteType.Flood);
  assert.equal(one.flood, true);
  assert.equal(one.payloadType, PayloadType.GroupText);
  assert.equal(one.transportCodes, null);
  assert.deepEqual(one.path, ["ce5b"]);
  assert.equal(toHex(one.payload), PAYLOAD);

  const two = parseRawPacket(fromHex("1542dc0a9360" + PAYLOAD))!;
  assert.deepEqual(two.path, ["dc0a", "9360"]);
  assert.equal(toHex(two.payload), PAYLOAD);
});

test("transport codes come between the header and the path", () => {
  const packet = parseRawPacket(fromHex("14" + "3412" + "7856" + "0141" + "aabb"))!;
  assert.deepEqual(packet.transportCodes, [0x1234, 0x5678]);
  assert.deepEqual(packet.path, ["41"]);
  assert.equal(toHex(packet.payload), "aabb");
});

test("bytes that are not a packet are refused", () => {
  assert.equal(parseRawPacket(fromHex("15")), null);
  assert.equal(parseRawPacket(fromHex("1541ce5b")), null); // path but no payload
  assert.equal(parseRawPacket(fromHex("15ff" + "00".repeat(64))), null); // 63 four-byte hashes cannot fit
});

// A card as `CMD_EXPORT_CONTACT` writes it: a flooded advert, no path, then the payload.
const KEY = "4523c9e1a07b5f2d8e61b0c4a9d3f7e21c8b6a5d0e9f4c3b2a1d7e6f5c4b3a29";

test("an advert names its node: key, kind, place and name", () => {
  const payload = new ByteWriter().bytes(fromHex(KEY)).u32(1_762_900_000).zeros(64).u8(0x91).i32(55_751_244).i32(37_618_423).string("Sokol").toBytes();
  const packet = parseRawPacket(new ByteWriter().u8((PayloadType.Advert << 2) | RouteType.Flood).u8(0).bytes(payload).toBytes())!;
  assert.equal(packet.payloadType, PayloadType.Advert);
  assert.deepEqual(parseAdvert(packet.payload), { key: KEY, timestamp: 1_762_900_000, type: 1, name: "Sokol", lat: 55.751244, lon: 37.618423 });
});

test("an advert with feature words and no place still finds its name, and one cut short is refused", () => {
  const payload = new ByteWriter().bytes(fromHex(KEY)).u32(1).zeros(64).u8(0xe2).u16(7).u16(9).string("Hill").toBytes();
  assert.deepEqual(parseAdvert(payload), { key: KEY, timestamp: 1, type: 2, name: "Hill", lat: null, lon: null });
  assert.equal(parseAdvert(payload.subarray(0, 100)), null);
  assert.equal(parseAdvert(new ByteWriter().bytes(fromHex(KEY)).u32(1).zeros(64).u8(0x11).u16(1).toBytes()), null);
});
