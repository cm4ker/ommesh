/**
 * Lightweight legal-move chess opponent for Demo Mode (`demo.ts`), speaking
 * the exact `ommesh.chess` (`appId = 0x0100`) binary wire protocol so users
 * can test the full MCRS v2 + sandboxed mini-app flow without hardware.
 */

export const DEMO_CHESS_APP_ID = 0x0100;

interface Pos {
  board: string[];
  turn: "w" | "b";
  castle: number;
  ep: number;
  half: number;
  ply: number;
}

const OP_INVITE = 1;
const OP_ACCEPT = 2;
const OP_MOVE = 4;
const OP_ACTION = 5;
const OP_SYNC_REQ = 6;
const OP_SYNC_MOVES = 7;
const OP_CHAT = 8;

const ACT_DRAW_OFFER = 2;
const ACT_DRAW_ACCEPT = 3;

const PROMO_MAP = ["", "n", "b", "r", "q"] as const;

function packMove(from: number, to: number, promoIdx = 0): number {
  return (from & 63) | ((to & 63) << 6) | ((promoIdx & 7) << 12);
}

function initialState(): Pos {
  const board = new Array<string>(64).fill("");
  const back = ["r", "n", "b", "q", "k", "b", "n", "r"];
  for (let f = 0; f < 8; f++) {
    board[f] = back[f]!.toUpperCase();
    board[8 + f] = "P";
    board[48 + f] = "p";
    board[56 + f] = back[f]!;
  }
  return { board, turn: "w", castle: 15, ep: -1, half: 0, ply: 0 };
}

function pieceColor(ch: string): "" | "w" | "b" {
  if (!ch) return "";
  return ch === ch.toUpperCase() ? "w" : "b";
}

function posHash8(p: Pos): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < 64; i++) {
    const c = p.board[i] ? p.board[i]!.charCodeAt(0) : 46;
    h = Math.imul(h ^ c, 16777619) >>> 0;
  }
  h = Math.imul(h ^ (p.turn === "w" ? 1 : 2), 16777619) >>> 0;
  h = Math.imul(h ^ p.castle, 16777619) >>> 0;
  h = Math.imul(h ^ (p.ep + 2), 16777619) >>> 0;
  return h & 0xff;
}

function isAttacked(board: string[], sq: number, byColor: "w" | "b"): boolean {
  const f = sq & 7;
  const r = sq >> 3;
  const pawnDir = byColor === "w" ? -1 : 1;
  const pawnCh = byColor === "w" ? "P" : "p";
  for (const df of [-1, 1]) {
    const nf = f + df;
    const nr = r + pawnDir;
    if (nf >= 0 && nf < 8 && nr >= 0 && nr < 8 && board[nr * 8 + nf] === pawnCh) return true;
  }
  const knightCh = byColor === "w" ? "N" : "n";
  for (const [df, dr] of [[-2, -1], [-2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2], [2, -1], [2, 1]] as const) {
    const nf = f + df;
    const nr = r + dr;
    if (nf >= 0 && nf < 8 && nr >= 0 && nr < 8 && board[nr * 8 + nf] === knightCh) return true;
  }
  const kingCh = byColor === "w" ? "K" : "k";
  for (let df = -1; df <= 1; df++) {
    for (let dr = -1; dr <= 1; dr++) {
      if (!df && !dr) continue;
      const nf = f + df;
      const nr = r + dr;
      if (nf >= 0 && nf < 8 && nr >= 0 && nr < 8 && board[nr * 8 + nf] === kingCh) return true;
    }
  }
  const rookCh = byColor === "w" ? "R" : "r";
  const bishopCh = byColor === "w" ? "B" : "b";
  const queenCh = byColor === "w" ? "Q" : "q";
  for (const [df, dr, ch] of [
    [1, 0, rookCh], [-1, 0, rookCh], [0, 1, rookCh], [0, -1, rookCh],
    [1, 1, bishopCh], [1, -1, bishopCh], [-1, 1, bishopCh], [-1, -1, bishopCh],
  ] as const) {
    let nf = f + df;
    let nr = r + dr;
    while (nf >= 0 && nf < 8 && nr >= 0 && nr < 8) {
      const piece = board[nr * 8 + nf]!;
      if (piece) {
        if (piece === ch || piece === queenCh) return true;
        break;
      }
      nf += df;
      nr += dr;
    }
  }
  return false;
}

function applyRaw(p: Pos, from: number, to: number, promoIdx: number): Pos {
  const next: Pos = { board: p.board.slice(), turn: p.turn === "w" ? "b" : "w", castle: p.castle, ep: -1, half: p.half + 1, ply: p.ply + 1 };
  const piece = next.board[from]!;
  const lower = piece.toLowerCase();
  const captured = next.board[to]!;
  if (lower === "p" || captured) next.half = 0;
  if (lower === "p" && to === p.ep) {
    const capSq = p.turn === "w" ? to - 8 : to + 8;
    next.board[capSq] = "";
  }
  next.board[from] = "";
  if (lower === "p" && ((to >> 3) === 7 || (to >> 3) === 0)) {
    const promo = PROMO_MAP[promoIdx] || "q";
    next.board[to] = p.turn === "w" ? promo.toUpperCase() : promo;
  } else {
    next.board[to] = piece;
  }
  if (lower === "p" && Math.abs(to - from) === 16) next.ep = (from + to) >> 1;
  if (lower === "k" && Math.abs((to & 7) - (from & 7)) === 2) {
    const rank = from & 56;
    if ((to & 7) === 6) {
      next.board[rank + 5] = next.board[rank + 7]!;
      next.board[rank + 7] = "";
    } else {
      next.board[rank + 3] = next.board[rank]!;
      next.board[rank] = "";
    }
  }
  if (from === 4 || to === 4) next.castle &= ~3;
  if (from === 60 || to === 60) next.castle &= ~12;
  if (from === 7 || to === 7) next.castle &= ~1;
  if (from === 0 || to === 0) next.castle &= ~2;
  if (from === 63 || to === 63) next.castle &= ~4;
  if (from === 56 || to === 56) next.castle &= ~8;
  return next;
}

function legalMoves(p: Pos): { from: number; to: number; promo: number; next: Pos; score: number }[] {
  const me = p.turn;
  const them: "w" | "b" = me === "w" ? "b" : "w";
  const myKing = me === "w" ? "K" : "k";
  const out: { from: number; to: number; promo: number; next: Pos; score: number }[] = [];

  const pushIfLegal = (from: number, to: number, promo = 0) => {
    const next = applyRaw(p, from, to, promo);
    const kSq = next.board.indexOf(myKing);
    if (kSq < 0 || isAttacked(next.board, kSq, them)) return;
    let score = Math.random() * 2;
    const cap = p.board[to];
    if (cap) {
      const vals: Record<string, number> = { p: 10, n: 30, b: 32, r: 50, q: 90, k: 100 };
      score += vals[cap.toLowerCase()] ?? 0;
    }
    const tf = to & 7;
    const tr = to >> 3;
    if (tf >= 2 && tf <= 5 && tr >= 2 && tr <= 5) score += 4;
    if (promo) score += 60;
    out.push({ from, to, promo, next, score });
  };

  for (let sq = 0; sq < 64; sq++) {
    const ch = p.board[sq]!;
    if (pieceColor(ch) !== me) continue;
    const lower = ch.toLowerCase();
    const f = sq & 7;
    const r = sq >> 3;
    if (lower === "p") {
      const dir = me === "w" ? 1 : -1;
      const startRank = me === "w" ? 1 : 6;
      const promoRank = me === "w" ? 7 : 0;
      const one = (r + dir) * 8 + f;
      if (r + dir >= 0 && r + dir < 8 && !p.board[one]) {
        pushIfLegal(sq, one, r + dir === promoRank ? 4 : 0);
        const two = (r + 2 * dir) * 8 + f;
        if (r === startRank && !p.board[two]) pushIfLegal(sq, two, 0);
      }
      for (const df of [-1, 1]) {
        const nf = f + df;
        const nr = r + dir;
        if (nf < 0 || nf > 7 || nr < 0 || nr > 7) continue;
        const target = nr * 8 + nf;
        if (pieceColor(p.board[target]!) === them || target === p.ep) {
          pushIfLegal(sq, target, nr === promoRank ? 4 : 0);
        }
      }
    } else if (lower === "n") {
      for (const [df, dr] of [[-2, -1], [-2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2], [2, -1], [2, 1]] as const) {
        const nf = f + df;
        const nr = r + dr;
        if (nf >= 0 && nf < 8 && nr >= 0 && nr < 8 && pieceColor(p.board[nr * 8 + nf]!) !== me) {
          pushIfLegal(sq, nr * 8 + nf);
        }
      }
    } else if (lower === "k") {
      for (let df = -1; df <= 1; df++) {
        for (let dr = -1; dr <= 1; dr++) {
          if (!df && !dr) continue;
          const nf = f + df;
          const nr = r + dr;
          if (nf >= 0 && nf < 8 && nr >= 0 && nr < 8 && pieceColor(p.board[nr * 8 + nf]!) !== me) {
            pushIfLegal(sq, nr * 8 + nf);
          }
        }
      }
    } else {
      const dirs: [number, number][] = [];
      if (lower === "r" || lower === "q") dirs.push([1, 0], [-1, 0], [0, 1], [0, -1]);
      if (lower === "b" || lower === "q") dirs.push([1, 1], [1, -1], [-1, 1], [-1, -1]);
      for (const [df, dr] of dirs) {
        let nf = f + df;
        let nr = r + dr;
        while (nf >= 0 && nf < 8 && nr >= 0 && nr < 8) {
          const target = nr * 8 + nf;
          const c = pieceColor(p.board[target]!);
          if (c === me) break;
          pushIfLegal(sq, target);
          if (c === them) break;
          nf += df;
          nr += dr;
        }
      }
    }
  }
  return out;
}

interface DemoGame {
  pos: Pos;
  moves: number[];
}

export interface DemoChessReply {
  delayMs: number;
  payload: Uint8Array;
}

export class DemoChessBot {
  private games = new Map<number, DemoGame>();
  private chatReplyIdx = 0;

  /** Handles an outgoing `ommesh.chess` packet and returns zero or more delayed opponent packets. */
  onOutgoing(payload: Uint8Array): DemoChessReply[] {
    if (payload.length < 3) return [];
    const op = payload[0]!;
    const gid = payload[1]! | (payload[2]! << 8);

    if (op === OP_INVITE) {
      const flags = payload[3] ?? 0;
      const challengerBlack = (flags & 1) !== 0;
      const game: DemoGame = { pos: initialState(), moves: [] };
      this.games.set(gid, game);
      const replies: DemoChessReply[] = [
        { delayMs: 900, payload: new Uint8Array([OP_ACCEPT, gid & 0xff, (gid >> 8) & 0xff, 0]) },
      ];
      if (challengerBlack) {
        const movePkt = this.makeBotMove(gid, game);
        if (movePkt) replies.push({ delayMs: 2100, payload: movePkt });
      }
      return replies;
    }

    if (op === OP_MOVE && payload.length >= 8) {
      const ply = payload[3]! | (payload[4]! << 8);
      const moveBits = payload[5]! | (payload[6]! << 8);
      let game = this.games.get(gid);
      if (!game && ply > 1) {
        // After a page reload the in-memory demo bot forgot this game — ask the client to sync history!
        return [{ delayMs: 450, payload: new Uint8Array([OP_SYNC_REQ, gid & 0xff, (gid >> 8) & 0xff, 0, 0]) }];
      }
      if (!game) {
        game = { pos: initialState(), moves: [] };
        this.games.set(gid, game);
      }
      if (ply <= game.moves.length) return [];
      const from = moveBits & 63;
      const to = (moveBits >> 6) & 63;
      const promo = (moveBits >> 12) & 7;
      game.pos = applyRaw(game.pos, from, to, promo);
      game.moves.push(moveBits);
      const replyPkt = this.makeBotMove(gid, game);
      return replyPkt ? [{ delayMs: 1350, payload: replyPkt }] : [];
    }

    if (op === OP_SYNC_MOVES && payload.length >= 6) {
      const fromPly = payload[3]! | (payload[4]! << 8);
      const count = payload[5]!;
      let game = this.games.get(gid);
      if (!game || fromPly === 0) {
        game = { pos: initialState(), moves: [] };
        this.games.set(gid, game);
      }
      for (let i = 0; i < count && 6 + i * 2 + 1 < payload.length; i++) {
        const bits = payload[6 + i * 2]! | (payload[7 + i * 2]! << 8);
        if (fromPly + i < game.moves.length) continue;
        game.pos = applyRaw(game.pos, bits & 63, (bits >> 6) & 63, (bits >> 12) & 7);
        game.moves.push(bits);
      }
      // If it is now the bot's turn (odd ply count for Black opponent), reply immediately.
      if (game.moves.length % 2 === 1) {
        const replyPkt = this.makeBotMove(gid, game);
        return replyPkt ? [{ delayMs: 900, payload: replyPkt }] : [];
      }
      return [];
    }

    if (op === OP_ACTION && payload.length >= 6) {
      const ply = payload[3]! | (payload[4]! << 8);
      const action = payload[5]!;
      if (action === ACT_DRAW_OFFER) {
        return [
          {
            delayMs: 1000,
            payload: new Uint8Array([OP_ACTION, gid & 0xff, (gid >> 8) & 0xff, ply & 0xff, (ply >> 8) & 0xff, ACT_DRAW_ACCEPT]),
          },
        ];
      }
    }

    if (op === OP_SYNC_REQ && payload.length >= 5) {
      const fromPly = payload[3]! | (payload[4]! << 8);
      const game = this.games.get(gid);
      if (!game || fromPly >= game.moves.length) return [];
      const slice = game.moves.slice(fromPly, fromPly + 64);
      const out = new Uint8Array(6 + slice.length * 2);
      out[0] = OP_SYNC_MOVES;
      out[1] = gid & 0xff;
      out[2] = (gid >> 8) & 0xff;
      out[3] = fromPly & 0xff;
      out[4] = (fromPly >> 8) & 0xff;
      out[5] = slice.length;
      slice.forEach((m, i) => {
        out[6 + i * 2] = m & 0xff;
        out[7 + i * 2] = (m >> 8) & 0xff;
      });
      return [{ delayMs: 800, payload: out }];
    }

    if (op === OP_CHAT && payload.length > 3) {
      const incoming = new TextDecoder().decode(payload.subarray(3)).trim();
      const ru = /[а-яёА-ЯЁ]/.test(incoming);
      let text: string;
      if (incoming.includes("👋")) {
        text = ru ? "Привет! Удачной партии ♟" : "Hey! Good luck ♟";
      } else if (incoming.includes("👍") || /хорош|nice|good/i.test(incoming)) {
        text = ru ? "Спасибо! Стараюсь 😄" : "Thanks! Trying my best 😄";
      } else if (/думаю|think/i.test(incoming)) {
        text = ru ? "Не торопись, по LoRa время есть" : "Take your time, LoRa is chill";
      } else {
        const pool = ru
          ? ["Интересная позиция!", "Принято по LoRa 📡", "Хм, надо подумать…", "Отличная партия!"]
          : ["Interesting position!", "Copy over LoRa 📡", "Hmm, let me think…", "Great game!"];
        text = pool[this.chatReplyIdx++ % pool.length]!;
      }
      const enc = new TextEncoder().encode(text);
      const out = new Uint8Array(3 + enc.length);
      out[0] = OP_CHAT;
      out[1] = gid & 0xff;
      out[2] = (gid >> 8) & 0xff;
      out.set(enc, 3);
      return [{ delayMs: 1100, payload: out }];
    }

    return [];
  }

  private makeBotMove(gid: number, game: DemoGame): Uint8Array | null {
    const moves = legalMoves(game.pos);
    if (moves.length === 0) return null;
    moves.sort((a, b) => b.score - a.score);
    const chosen = moves[0]!;
    const bits = packMove(chosen.from, chosen.to, chosen.promo);
    game.pos = chosen.next;
    game.moves.push(bits);
    const ply = game.moves.length;
    const h8 = posHash8(game.pos);
    return new Uint8Array([
      OP_MOVE,
      gid & 0xff,
      (gid >> 8) & 0xff,
      ply & 0xff,
      (ply >> 8) & 0xff,
      bits & 0xff,
      (bits >> 8) & 0xff,
      h8,
    ]);
  }
}
