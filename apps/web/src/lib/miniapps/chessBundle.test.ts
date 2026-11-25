import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { CHESS_ENGINE_JS } from "./chessBundle.js";

interface ChessGame {
  id: string;
  gameId: number;
  peerPrefix: string;
  peerName: string;
  myColor: "w" | "b";
  status: "invited_out" | "invited_in" | "active" | "finished" | "declined";
  moves: number[];
  drawOfferedBy: "w" | "b" | null;
  winner: "w" | "b" | "draw" | null;
  finishAction?: number | null;
  updatedAt: number;
}

interface ApplyResult {
  changed: boolean;
  synced?: boolean;
  notify: unknown;
  replies: { peerPrefix: string; payload: number[]; retry?: boolean }[];
  gameKey?: string;
}

interface ChessEngine {
  OP_INVITE: number;
  OP_ACCEPT: number;
  OP_MOVE: number;
  OP_ACTION: number;
  OP_SYNC_REQ: number;
  OP_SYNC_MOVES: number;
  ACT_RESIGN: number;
  ACT_DRAW_ACCEPT: number;
  packMove(from: number, to: number, promoIdx: number, offerDraw: boolean): number;
  replayMoves(moves: number[]): { pos: { turn: "w" | "b" }; legal: { from: number; to: number; promo: number }[] } | null;
  posHash8(pos: unknown): number;
  encodeInvite(gid: number, color: "w" | "b"): Uint8Array;
  encodeAccept(gid: number, color: "w" | "b"): Uint8Array;
  encodeMovePkt(gid: number, ply: number, bits: number, hash8: number): Uint8Array;
  encodeActionPkt(gid: number, ply: number, action: number): Uint8Array;
  encodeSyncReq(gid: number, fromPly: number, hash8?: number, flags?: number): Uint8Array;
  encodeSyncMoves(gid: number, fromPly: number, moves: number[]): Uint8Array;
  buildManualSyncPackets(g: ChessGame): Uint8Array[];
  applyIncomingPacket(
    games: Record<string, ChessGame>,
    packet: { peerPrefix: string; peerName: string; payload: Uint8Array; timestamp: number; snr: number; hops: number | null; mirrored?: boolean },
    locale: "en" | "ru",
  ): ApplyResult;
}

function loadEngine(): ChessEngine {
  const ctx: Record<string, unknown> = { TextEncoder, TextDecoder, Uint8Array, Math, Date, Array, Object, String };
  vm.createContext(ctx);
  vm.runInContext(CHESS_ENGINE_JS, ctx);
  return ctx as unknown as ChessEngine;
}

/** Generates `plies` legal deterministic moves (knight shuttles / pawn advances) without ending the game early. */
function makeLegalMoves(eng: ChessEngine, plies: number): number[] {
  // Repeating Nb1-c3, Nb8-c6, Nc3-b1, Nc6-b8 is always legal and gives arbitrary ply counts!
  const cycle = [
    eng.packMove(1, 18, 0, false),  // Nb1-c3
    eng.packMove(57, 42, 0, false), // Nb8-c6
    eng.packMove(18, 1, 0, false),  // Nc3-b1
    eng.packMove(42, 57, 0, false), // Nc6-b8
  ];
  const moves: number[] = [];
  for (let i = 0; i < plies; i++) moves.push(cycle[i % 4]!);
  assert.ok(eng.replayMoves(moves), "generated move sequence must be legal");
  return moves;
}

/** Pumps packets back and forth between Alice ("aaaaaa000001") and Bob ("bbbbbb000002") until quiescent. */
function exchange(
  eng: ChessEngine,
  aliceGames: Record<string, ChessGame>,
  bobGames: Record<string, ChessGame>,
  initialQueue: { to: "alice" | "bob"; payload: Uint8Array }[],
  maxSteps = 40,
): { steps: number; aliceSynced: boolean; bobSynced: boolean } {
  const queue = [...initialQueue];
  let steps = 0;
  let aliceSynced = false;
  let bobSynced = false;
  while (queue.length > 0) {
    assert.ok(steps < maxSteps, `sync did not terminate within ${maxSteps} packets (possible ping-pong loop)`);
    steps++;
    const item = queue.shift()!;
    const targetGames = item.to === "alice" ? aliceGames : bobGames;
    const fromPrefix = item.to === "alice" ? "bbbbbb000002" : "aaaaaa000001";
    const fromName = item.to === "alice" ? "Bob" : "Alice";
    const res = eng.applyIncomingPacket(
      targetGames,
      { peerPrefix: fromPrefix, peerName: fromName, payload: item.payload, timestamp: 1700000000 + steps, snr: 8, hops: null },
      "en",
    );
    if (res.synced) {
      if (item.to === "alice") aliceSynced = true;
      else bobSynced = true;
    }
    for (const r of res.replies) {
      queue.push({ to: item.to === "alice" ? "bob" : "alice", payload: new Uint8Array(r.payload) });
    }
  }
  return { steps, aliceSynced, bobSynced };
}

function pairAt(
  movesAlice: number[],
  movesBob: number[],
  opts: { aliceStatus?: ChessGame["status"]; bobStatus?: ChessGame["status"] } = {},
): { gid: number; key: string; alice: Record<string, ChessGame>; bob: Record<string, ChessGame> } {
  const gid = 0x1234;
  const key = "g:1234";
  return {
    gid,
    key,
    alice: {
      [key]: {
        id: key, gameId: gid, peerPrefix: "bbbbbb000002", peerName: "Bob",
        myColor: "w", status: opts.aliceStatus ?? "active", moves: [...movesAlice],
        drawOfferedBy: null, winner: null, finishAction: null, updatedAt: 1,
      },
    },
    bob: {
      [key]: {
        id: key, gameId: gid, peerPrefix: "aaaaaa000001", peerName: "Alice",
        myColor: "b", status: opts.bobStatus ?? "active", moves: [...movesBob],
        drawOfferedBy: null, winner: null, finishAction: null, updatedAt: 1,
      },
    },
  };
}

test("chess sync: ahead player pressing Sync heals behind opponent", () => {
  const eng = loadEngine();
  const full = makeLegalMoves(eng, 15);
  const { key, alice, bob } = pairAt(full, full.slice(0, 14));

  const pkts = eng.buildManualSyncPackets(alice[key]!);
  exchange(eng, alice, bob, pkts.map((payload) => ({ to: "bob", payload })));

  assert.deepEqual(bob[key]!.moves, full);
  assert.deepEqual(alice[key]!.moves, full);
});

test("chess sync: behind player pressing Sync catches up from ahead opponent", () => {
  const eng = loadEngine();
  const full = makeLegalMoves(eng, 15);
  const { key, alice, bob } = pairAt(full, full.slice(0, 14));

  const pkts = eng.buildManualSyncPackets(bob[key]!);
  exchange(eng, alice, bob, pkts.map((payload) => ({ to: "alice", payload })));

  assert.deepEqual(bob[key]!.moves, full);
  assert.deepEqual(alice[key]!.moves, full);
});

test("chess sync: games longer than 72 plies sync completely via automatic chunking", () => {
  const eng = loadEngine();
  const full = makeLegalMoves(eng, 95);

  // Case A: Bob is stuck at ply 72 (the old ceiling!) and Alice is at ply 95.
  const caseA = pairAt(full, full.slice(0, 72));
  const pktsA = eng.buildManualSyncPackets(caseA.bob[caseA.key]!);
  exchange(eng, caseA.alice, caseA.bob, pktsA.map((payload) => ({ to: "alice", payload })));
  assert.deepEqual(caseA.bob[caseA.key]!.moves, full);

  // Case B: Bob is a fresh device at ply 0 and Alice is at ply 95 (> 72 moves -> 2 chunks).
  const caseB = pairAt(full, []);
  const pktsB = eng.buildManualSyncPackets(caseB.bob[caseB.key]!);
  exchange(eng, caseB.alice, caseB.bob, pktsB.map((payload) => ({ to: "alice", payload })));
  assert.deepEqual(caseB.bob[caseB.key]!.moves, full);

  // Case C: Ahead Alice at ply 95 presses Sync while Bob is stuck at ply 60.
  const caseC = pairAt(full, full.slice(0, 60));
  const pktsC = eng.buildManualSyncPackets(caseC.alice[caseC.key]!);
  exchange(eng, caseC.alice, caseC.bob, pktsC.map((payload) => ({ to: "bob", payload })));
  assert.deepEqual(caseC.bob[caseC.key]!.moves, full);
});

test("chess sync: heals lost OP_ACCEPT when challenger is stuck in invited_out", () => {
  const eng = loadEngine();
  const { key, alice, bob } = pairAt([], [], { aliceStatus: "invited_out", bobStatus: "active" });

  // Alice (stuck in invited_out) taps Sync -> Bob replies ACCEPT -> both active!
  const pkts = eng.buildManualSyncPackets(alice[key]!);
  exchange(eng, alice, bob, pkts.map((payload) => ({ to: "bob", payload })));
  assert.equal(alice[key]!.status, "active");
  assert.equal(bob[key]!.status, "active");
});

test("chess sync: already in-sync players confirm with zero ping-pong", () => {
  const eng = loadEngine();
  const full = makeLegalMoves(eng, 12);
  const { key, alice, bob } = pairAt(full, full);

  const pkts = eng.buildManualSyncPackets(alice[key]!);
  const res = exchange(eng, alice, bob, pkts.map((payload) => ({ to: "bob", payload })));
  assert.equal(res.aliceSynced, true);
  assert.ok(res.steps <= 4, `expected quick confirmation, took ${res.steps} steps`);
});

test("chess sync: reconciles lost resignation action", () => {
  const eng = loadEngine();
  const full = makeLegalMoves(eng, 6);
  const { key, alice, bob } = pairAt(full, full);
  alice[key]!.status = "finished";
  alice[key]!.winner = "b";
  alice[key]!.finishAction = eng.ACT_RESIGN;

  const pkts = eng.buildManualSyncPackets(bob[key]!);
  exchange(eng, alice, bob, pkts.map((payload) => ({ to: "alice", payload })));
  assert.equal(bob[key]!.status, "finished");
  assert.equal(bob[key]!.winner, "b");
});

test("chess sync: mirrored OP_INVITE preserves challenger color and emits no replies", () => {
  const eng = loadEngine();
  const games: Record<string, ChessGame> = {};
  const invite = eng.encodeInvite(0x2222, "w");
  const res = eng.applyIncomingPacket(
    games,
    { peerPrefix: "bbbbbb000002", peerName: "Bob", payload: invite, timestamp: 100, snr: 0, hops: null, mirrored: true },
    "en",
  );
  assert.equal(res.changed, true);
  assert.equal(res.replies.length, 0);
  assert.equal(games["g:2222"]!.myColor, "w");
  assert.equal(games["g:2222"]!.status, "invited_out");

  // Mirrored SYNC_REQ must never emit replies to opponent either.
  const syncMirror = eng.applyIncomingPacket(
    games,
    { peerPrefix: "bbbbbb000002", peerName: "Bob", payload: eng.encodeSyncReq(0x2222, 0), timestamp: 101, snr: 0, hops: null, mirrored: true },
    "en",
  );
  assert.equal(syncMirror.replies.length, 0);
});

test("chess sync: fresh device infers color from incoming OP_MOVE parity and pulls full history", () => {
  const eng = loadEngine();
  const full = makeLegalMoves(eng, 4);
  const rep = eng.replayMoves(full)!;
  const alice: Record<string, ChessGame> = {};
  const bob: Record<string, ChessGame> = {
    "g:3333": {
      id: "g:3333", gameId: 0x3333, peerPrefix: "aaaaaa000001", peerName: "Alice",
      myColor: "b", status: "active", moves: [...full],
      drawOfferedBy: null, winner: null, finishAction: null, updatedAt: 1,
    },
  };
  // Bob made ply 4 (Black's move); fresh Alice receives ply 4 and must infer myColor = "w" and pull plies 0..4!
  const move4 = eng.encodeMovePkt(0x3333, 4, full[3]!, eng.posHash8(rep.pos));
  exchange(eng, alice, bob, [{ to: "alice", payload: move4 }]);
  assert.equal(alice["g:3333"]!.myColor, "w");
  assert.deepEqual(Array.from(alice["g:3333"]!.moves), full);
});

test("chess sync: equal-ply diverged history reconciles via hash mismatch", () => {
  const eng = loadEngine();
  const lineA = [eng.packMove(12, 28, 0, false), eng.packMove(52, 36, 0, false)]; // 1. e4 e5
  const lineB = [eng.packMove(11, 27, 0, false), eng.packMove(51, 35, 0, false)]; // 1. d4 d5
  const { key, alice, bob } = pairAt(lineA, lineB);

  const pkts = eng.buildManualSyncPackets(bob[key]!);
  exchange(eng, alice, bob, pkts.map((payload) => ({ to: "alice", payload })));
  assert.deepEqual(Array.from(bob[key]!.moves), lineA);
});
