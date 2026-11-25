import { test } from "node:test";
import assert from "node:assert/strict";
import { DemoChessBot } from "./demoChess.js";

test("demo chess bot accepts invites and replies with legal moves and sync history", () => {
  const bot = new DemoChessBot();
  const gid = 0x1234;
  // Challenger plays White (flags = 0)
  const invite = new Uint8Array([1, gid & 0xff, (gid >> 8) & 0xff, 0, 0]);
  const r1 = bot.onOutgoing(invite);
  assert.equal(r1.length, 1);
  assert.equal(r1[0]!.payload[0], 2); // OP_ACCEPT
  assert.equal(r1[0]!.payload[1]! | (r1[0]!.payload[2]! << 8), gid);

  // White plays e2e4 (from=12, to=28)
  const e2e4 = (12 & 63) | ((28 & 63) << 6);
  const move = new Uint8Array([4, gid & 0xff, (gid >> 8) & 0xff, 1, 0, e2e4 & 0xff, (e2e4 >> 8) & 0xff, 0]);
  const r2 = bot.onOutgoing(move);
  assert.equal(r2.length, 1);
  assert.equal(r2[0]!.payload[0], 4); // OP_MOVE
  assert.equal(r2[0]!.payload[3]! | (r2[0]!.payload[4]! << 8), 2); // ply 2

  // Sync request from ply 0 returns both moves
  const syncReq = new Uint8Array([6, gid & 0xff, (gid >> 8) & 0xff, 0, 0]);
  const r3 = bot.onOutgoing(syncReq);
  assert.equal(r3.length, 1);
  assert.equal(r3[0]!.payload[0], 7); // OP_SYNC_MOVES
  assert.equal(r3[0]!.payload[5], 2); // 2 plies
});

test("demo chess bot plays first move as White when challenger chooses Black", () => {
  const bot = new DemoChessBot();
  const gid = 0x5678;
  const invite = new Uint8Array([1, gid & 0xff, (gid >> 8) & 0xff, 1, 0]);
  const replies = bot.onOutgoing(invite);
  assert.equal(replies.length, 2);
  assert.equal(replies[0]!.payload[0], 2); // OP_ACCEPT
  assert.equal(replies[1]!.payload[0], 4); // OP_MOVE (ply 1)
  assert.equal(replies[1]!.payload[3], 1);
});

test("demo chess bot recovers a mid-game after reload via SYNC_REQ / SYNC_MOVES", () => {
  const freshBot = new DemoChessBot();
  const gid = 0x9999;
  const nf3 = (6 & 63) | ((21 & 63) << 6);
  const movePly3 = new Uint8Array([4, gid & 0xff, (gid >> 8) & 0xff, 3, 0, nf3 & 0xff, (nf3 >> 8) & 0xff, 0]);
  const ask = freshBot.onOutgoing(movePly3);
  assert.equal(ask.length, 1);
  assert.equal(ask[0]!.payload[0], 6); // OP_SYNC_REQ

  // Client responds with 3 plies: e2e4, d7d6, g1f3
  const e2e4 = (12 & 63) | ((28 & 63) << 6);
  const d7d6 = (51 & 63) | ((43 & 63) << 6);
  const syncMoves = new Uint8Array([
    7, gid & 0xff, (gid >> 8) & 0xff, 0, 0, 3,
    e2e4 & 0xff, (e2e4 >> 8) & 0xff,
    d7d6 & 0xff, (d7d6 >> 8) & 0xff,
    nf3 & 0xff, (nf3 >> 8) & 0xff,
  ]);
  const reply = freshBot.onOutgoing(syncMoves);
  assert.equal(reply.length, 1);
  assert.equal(reply[0]!.payload[0], 4); // OP_MOVE
  assert.equal(reply[0]!.payload[3], 4); // ply 4!
});

test("demo chess bot replies to in-game OP_CHAT messages in matching language", () => {
  const bot = new DemoChessBot();
  const gid = 0x4242;
  const text = new TextEncoder().encode("Хороший ход!");
  const pkt = new Uint8Array(3 + text.length);
  pkt[0] = 8; // OP_CHAT
  pkt[1] = gid & 0xff;
  pkt[2] = (gid >> 8) & 0xff;
  pkt.set(text, 3);
  const res = bot.onOutgoing(pkt);
  assert.equal(res.length, 1);
  assert.equal(res[0]!.payload[0], 8);
  const replyText = new TextDecoder().decode(res[0]!.payload.subarray(3));
  assert.match(replyText, /[а-яёА-ЯЁ]/);
});
