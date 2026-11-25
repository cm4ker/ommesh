import assert from "node:assert/strict";
import test from "node:test";
import { encodeOmapp, decodeOmapp } from "@ommesh/miniapp-sdk";
import { STORE_CATALOG } from "../lib/miniapps/catalog.js";
import { DemoBattleshipBot } from "./demoBattleship.js";
import { DemoCheckersBot } from "./demoCheckers.js";

test("STORE_CATALOG ships valid Checkers and Battleship bundles", () => {
  const checkers = STORE_CATALOG.find((e) => e.pkg.manifest.id === "ommesh.checkers");
  const battleship = STORE_CATALOG.find((e) => e.pkg.manifest.id === "ommesh.battleship");
  assert.ok(checkers && checkers.pkg.manifest.appId === 0x0101);
  assert.ok(battleship && battleship.pkg.manifest.appId === 0x0102);

  for (const entry of [checkers, battleship]) {
    const rt = decodeOmapp(encodeOmapp(entry.pkg));
    assert.equal(rt.manifest.id, entry.pkg.manifest.id);
    assert.ok(rt.workerJs && rt.workerJs.includes("self.onPacket"));
  }
});

test("DemoCheckersBot accepts invite, answers moves legally, and replies to chat", () => {
  const bot = new DemoCheckersBot();
  const gid = 0x1111;
  const inv = new Uint8Array([1, gid & 0xff, (gid >> 8) & 0xff, 0, 0]);
  const r1 = bot.onOutgoing(inv);
  assert.equal(r1.length, 1);
  assert.equal(r1[0]!.payload[0], 2); // OP_ACCEPT

  // White opening move: a3 (sq32=8) -> b4 (sq32=12)
  const w = (8 & 31) | ((12 & 31) << 5);
  const mv = new Uint8Array([4, gid & 0xff, (gid >> 8) & 0xff, 1, 0, w & 0xff, (w >> 8) & 0xff, 0]);
  const r2 = bot.onOutgoing(mv);
  assert.equal(r2.length, 1);
  assert.equal(r2[0]!.payload[0], 4); // OP_MOVE reply

  const chatText = new TextEncoder().encode("Привет!");
  const chatPkt = new Uint8Array(3 + chatText.length);
  chatPkt[0] = 8;
  chatPkt[1] = gid & 0xff;
  chatPkt[2] = (gid >> 8) & 0xff;
  chatPkt.set(chatText, 3);
  const r3 = bot.onOutgoing(chatPkt);
  assert.equal(r3.length, 1);
  assert.equal(r3[0]!.payload[0], 8);
});

test("DemoBattleshipBot accepts, sends SHA-256 commitment, evaluates shots, and reveals on resign", () => {
  const bot = new DemoBattleshipBot();
  const gid = 0x2222;
  const inv = new Uint8Array([1, gid & 0xff, (gid >> 8) & 0xff, 0]);
  const r1 = bot.onOutgoing(inv);
  assert.equal(r1.length, 2);
  assert.equal(r1[0]!.payload[0], 2); // OP_ACCEPT
  assert.equal(r1[1]!.payload[0], 4); // OP_READY
  assert.equal(r1[1]!.payload.length, 11);

  // Fire at cell 0 -> must return OP_RESULT (and OP_SHOT if miss)
  const shot = new Uint8Array([5, gid & 0xff, (gid >> 8) & 0xff, 1, 0, 0]);
  const r2 = bot.onOutgoing(shot);
  assert.ok(r2.length >= 1);
  assert.equal(r2[0]!.payload[0], 6); // OP_RESULT

  // Resign -> bot reveals its fleet for SHA-256 verification
  const resign = new Uint8Array([7, gid & 0xff, (gid >> 8) & 0xff, 1, 0, 1]);
  const r3 = bot.onOutgoing(resign);
  assert.equal(r3.length, 1);
  assert.equal(r3[0]!.payload[0], 9); // OP_REVEAL
  assert.equal(r3[0]!.payload.length, 21);
});
