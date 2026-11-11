import { test } from "node:test";
import assert from "node:assert/strict";
import { ByteWriter, fromHex, toHex } from "@meshnet/meshcore";
import { readPasted } from "./pastedKey.js";

const KEY = "4523c9e1a07b5f2d8e61b0c4a9d3f7e21c8b6a5d0e9f4c3b2a1d7e6f5c4b3a29";
const SECRET = "8f3a51c20d9e7b44a610e2f59c38d07b";

test("a bare key: a node's is a person, a channel's half as long, a radio's private one twice", () => {
  assert.equal(readPasted("  "), null);
  assert.deepEqual(readPasted(KEY), { kind: "node", key: KEY, type: 1, name: "", lat: null, lon: null });
  assert.deepEqual(readPasted(` ${KEY.toUpperCase().match(/.{4}/g)!.join(" ")}\n`), readPasted(KEY));
  assert.deepEqual(readPasted(SECRET.match(/.{8}/g)!.join("-")), { kind: "channel", secret: SECRET, name: "" });
  assert.deepEqual(readPasted(KEY + KEY), { kind: "private" });
  assert.deepEqual(readPasted(KEY.slice(0, 40)), { kind: "unknown" });
  assert.deepEqual(readPasted("Sokol"), { kind: "unknown" });
});

test("a link carries a contact's name and kind, or a channel's name and key", () => {
  assert.deepEqual(readPasted(`meshcore://contact/add?name=Hill%20top&public_key=${KEY}&type=2`), { kind: "node", key: KEY, type: 2, name: "Hill top", lat: null, lon: null });
  assert.deepEqual(readPasted(`meshcore://contact/add?name=Sokol&public_key=${KEY}&type=9`), { kind: "node", key: KEY, type: 1, name: "Sokol", lat: null, lon: null });
  assert.deepEqual(readPasted(`meshcore://channel/add?name=Dacha&secret=${SECRET}`), { kind: "channel", secret: SECRET, name: "Dacha" });
  assert.deepEqual(readPasted("meshcore://contact/add?name=Sokol"), { kind: "unknown" });
});

test("a card is the advert the radio exports: the node's name, kind and place come with it", () => {
  const payload = new ByteWriter().bytes(fromHex(KEY)).u32(1_762_900_000).zeros(64).u8(0x93).i32(55_751_244).i32(37_618_423).string("Club").toBytes();
  const card = `meshcore://${toHex(new ByteWriter().u8(0x11).u8(0).bytes(payload).toBytes())}`;
  assert.deepEqual(readPasted(card), { kind: "node", key: KEY, type: 3, name: "Club", lat: 55.751244, lon: 37.618423 });
  assert.deepEqual(readPasted("meshcore://1100" + "00".repeat(20)), { kind: "unknown" });
});
