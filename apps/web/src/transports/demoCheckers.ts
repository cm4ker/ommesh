/**
 * Lightweight Russian draughts (8x8) opponent for Demo Mode (`demo.ts`),
 * speaking the exact `ommesh.checkers` (`appId = 0x0101`) binary wire protocol
 * so users can test mandatory captures, flying kings and in-game chat offline.
 */

export const DEMO_CHECKERS_APP_ID = 0x0101;

const OP_INVITE = 1;
const OP_ACCEPT = 2;
const OP_MOVE = 4;
const OP_ACTION = 5;
const OP_SYNC_REQ = 6;
const OP_SYNC_MOVES = 7;
const OP_CHAT = 8;

const ACT_DRAW_OFFER = 2;
const ACT_DRAW_ACCEPT = 3;
const MOVE_MULTI_BIT = 0x4000;
const MOVE_DRAW_BIT = 0x8000;

interface Pos {
  board: string[];
  turn: "w" | "b";
  quiet: number;
  ply: number;
}

interface LegalMove {
  path: number[];
  captures: number[];
  promoted: boolean;
}

function sq64To32(sq: number): number {
  return ((sq >> 3) << 2) | ((sq & 7) >> 1);
}

function sq32To64(idx: number): number {
  const r = (idx >> 2) & 7;
  const f = ((idx & 3) << 1) | (r & 1);
  return (r << 3) | f;
}

function pieceColor(ch: string): "" | "w" | "b" {
  if (!ch) return "";
  return ch === ch.toUpperCase() ? "w" : "b";
}

function isKing(ch: string): boolean {
  return ch === "K" || ch === "k";
}

function initialState(): Pos {
  const board = new Array<string>(64).fill("");
  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      if (((r + f) & 1) !== 0) continue;
      const sq = (r << 3) | f;
      if (r <= 2) board[sq] = "M";
      else if (r >= 5) board[sq] = "m";
    }
  }
  return { board, turn: "w", quiet: 0, ply: 0 };
}

function posHash8(p: Pos): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < 64; i++) {
    const c = p.board[i] ? p.board[i]!.charCodeAt(0) : 46;
    h = Math.imul(h ^ c, 16777619) >>> 0;
  }
  h = Math.imul(h ^ (p.turn === "w" ? 1 : 2), 16777619) >>> 0;
  h = Math.imul(h ^ (p.quiet & 0xff), 16777619) >>> 0;
  return h & 0xff;
}

function legalMoves(p: Pos): LegalMove[] {
  const color = p.turn;
  const enemy = color === "w" ? "b" : "w";
  const promoRank = color === "w" ? 7 : 0;
  const kingChar = color === "w" ? "K" : "k";
  const dirs = [[-1, -1], [-1, 1], [1, -1], [1, 1]] as const;
  const captures: LegalMove[] = [];

  for (let sq = 0; sq < 64; sq++) {
    const pc = p.board[sq]!;
    if (!pc || pieceColor(pc) !== color) continue;
    const workBoard = p.board.slice();
    workBoard[sq] = "";

    const search = (curSq: number, curPiece: string, path: number[], caps: number[], capSet: Set<number>): boolean => {
      const f = curSq & 7;
      const r = curSq >> 3;
      let foundAny = false;
      if (!isKing(curPiece)) {
        for (const [dr, df] of dirs) {
          const mr = r + dr;
          const mf = f + df;
          const lr = r + 2 * dr;
          const lf = f + 2 * df;
          if (lr < 0 || lr > 7 || lf < 0 || lf > 7) continue;
          const mid = (mr << 3) | mf;
          const land = (lr << 3) | lf;
          const midPc = workBoard[mid]!;
          if (!midPc || pieceColor(midPc) !== enemy || capSet.has(mid) || workBoard[land] !== "") continue;
          foundAny = true;
          const nextPiece = lr === promoRank ? kingChar : curPiece;
          const nextSet = new Set(capSet);
          nextSet.add(mid);
          if (!search(land, nextPiece, [...path, land], [...caps, mid], nextSet)) {
            captures.push({ path: [...path, land], captures: [...caps, mid], promoted: !isKing(pc) && isKing(nextPiece) });
          }
        }
      } else {
        for (const [dr, df] of dirs) {
          let cr = r + dr;
          let cf = f + df;
          let enemySq = -1;
          while (cr >= 0 && cr < 8 && cf >= 0 && cf < 8) {
            const csq = (cr << 3) | cf;
            const cpc = workBoard[csq]!;
            if (cpc) {
              if (pieceColor(cpc) === enemy && !capSet.has(csq)) enemySq = csq;
              break;
            }
            cr += dr;
            cf += df;
          }
          if (enemySq < 0) continue;
          const lands: number[] = [];
          cr += dr;
          cf += df;
          while (cr >= 0 && cr < 8 && cf >= 0 && cf < 8) {
            const lsq = (cr << 3) | cf;
            if (workBoard[lsq] !== "") break;
            lands.push(lsq);
            cr += dr;
            cf += df;
          }
          if (lands.length === 0) continue;
          foundAny = true;
          const nextSet = new Set(capSet);
          nextSet.add(enemySq);
          let anyCont = false;
          for (const land of lands) {
            if (search(land, curPiece, [...path, land], [...caps, enemySq], nextSet)) anyCont = true;
          }
          if (!anyCont) {
            for (const land of lands) {
              captures.push({ path: [...path, land], captures: [...caps, enemySq], promoted: !isKing(pc) && isKing(curPiece) });
            }
          }
        }
      }
      return foundAny;
    };
    search(sq, pc, [sq], [], new Set());
  }

  if (captures.length > 0) return captures;

  const quietMoves: LegalMove[] = [];
  const fwdDir = color === "w" ? 1 : -1;
  for (let sq = 0; sq < 64; sq++) {
    const pc = p.board[sq]!;
    if (!pc || pieceColor(pc) !== color) continue;
    const f = sq & 7;
    const r = sq >> 3;
    if (!isKing(pc)) {
      const nr = r + fwdDir;
      if (nr >= 0 && nr < 8) {
        if (f > 0 && p.board[(nr << 3) | (f - 1)] === "") {
          quietMoves.push({ path: [sq, (nr << 3) | (f - 1)], captures: [], promoted: nr === promoRank });
        }
        if (f < 7 && p.board[(nr << 3) | (f + 1)] === "") {
          quietMoves.push({ path: [sq, (nr << 3) | (f + 1)], captures: [], promoted: nr === promoRank });
        }
      }
    } else {
      for (const [dr, df] of dirs) {
        let tr = r + dr;
        let tf = f + df;
        while (tr >= 0 && tr < 8 && tf >= 0 && tf < 8) {
          const tsq = (tr << 3) | tf;
          if (p.board[tsq] !== "") break;
          quietMoves.push({ path: [sq, tsq], captures: [], promoted: false });
          tr += dr;
          tf += df;
        }
      }
    }
  }
  return quietMoves;
}

function applyLegal(p: Pos, move: LegalMove): Pos {
  const board = p.board.slice();
  const from = move.path[0]!;
  const to = move.path[move.path.length - 1]!;
  const pc = board[from]!;
  const color = pieceColor(pc);
  const promoRank = color === "w" ? 7 : 0;
  let king = isKing(pc);
  board[from] = "";
  for (const c of move.captures) board[c] = "";
  for (let i = 1; i < move.path.length; i++) {
    if ((move.path[i]! >> 3) === promoRank) king = true;
  }
  board[to] = king ? (color === "w" ? "K" : "k") : pc;
  return {
    board,
    turn: color === "w" ? "b" : "w",
    quiet: (move.captures.length > 0 || !isKing(pc)) ? 0 : p.quiet + 1,
    ply: p.ply + 1,
  };
}

function encodeMoveRecord(path32: number[]): number[] {
  const w = (path32[0]! & 31) | ((path32[1]! & 31) << 5) | (path32.length > 2 ? MOVE_MULTI_BIT : 0);
  if (path32.length <= 2) return [w & 0xff, (w >> 8) & 0xff];
  const extra = Math.min(12, path32.length - 2);
  return [w & 0xff, (w >> 8) & 0xff, extra, ...path32.slice(2, 2 + extra).map((x) => x & 31)];
}

function decodeMoveRecord(bytes: Uint8Array, offset: number): { path32: number[]; nextOffset: number } | null {
  if (offset + 2 > bytes.length) return null;
  const w = bytes[offset]! | (bytes[offset + 1]! << 8);
  const path32 = [w & 31, (w >> 5) & 31];
  let nextOffset = offset + 2;
  if ((w & MOVE_MULTI_BIT) !== 0) {
    if (offset + 3 > bytes.length) return null;
    const extra = bytes[offset + 2]!;
    if (extra < 1 || extra > 12 || offset + 3 + extra > bytes.length) return null;
    for (let i = 0; i < extra; i++) path32.push(bytes[offset + 3 + i]! & 31);
    nextOffset = offset + 3 + extra;
  }
  // Ignore MOVE_DRAW_BIT for move playback
  void MOVE_DRAW_BIT;
  return { path32, nextOffset };
}

function applyPath32(pos: Pos, path32: number[]): Pos | null {
  const path64 = path32.map(sq32To64);
  const moves = legalMoves(pos);
  const found = moves.find((m) => m.path.length === path64.length && m.path.every((s, i) => s === path64[i]));
  return found ? applyLegal(pos, found) : null;
}

interface DemoGame {
  pos: Pos;
  moves: number[][];
  botBlack: boolean;
}

export interface DemoCheckersReply {
  delayMs: number;
  payload: Uint8Array;
}

export class DemoCheckersBot {
  private games = new Map<number, DemoGame>();
  private chatReplyIdx = 0;

  /** Handles an outgoing `ommesh.checkers` packet and returns zero or more delayed opponent packets. */
  onOutgoing(payload: Uint8Array): DemoCheckersReply[] {
    if (payload.length < 3) return [];
    const op = payload[0]! & 0x1f;
    const gid = payload[1]! | (payload[2]! << 8);

    if (op === OP_INVITE) {
      const challengerBlack = ((payload[3] ?? 0) & 1) !== 0;
      const botBlack = !challengerBlack;
      const game: DemoGame = { pos: initialState(), moves: [], botBlack };
      this.games.set(gid, game);
      const replies: DemoCheckersReply[] = [
        { delayMs: 800, payload: new Uint8Array([OP_ACCEPT, gid & 0xff, (gid >> 8) & 0xff, botBlack ? 1 : 0]) },
      ];
      if (challengerBlack) {
        const movePkt = this.makeBotMove(gid, game);
        if (movePkt) replies.push({ delayMs: 1800, payload: movePkt });
      }
      return replies;
    }

    if (op === OP_MOVE && payload.length >= 8) {
      const ply = payload[3]! | (payload[4]! << 8);
      const rec = decodeMoveRecord(payload, 5);
      if (!rec) return [];
      let game = this.games.get(gid);
      if (!game && ply > 1) {
        return [{ delayMs: 450, payload: new Uint8Array([OP_SYNC_REQ, gid & 0xff, (gid >> 8) & 0xff, 0, 0]) }];
      }
      if (!game) {
        game = { pos: initialState(), moves: [], botBlack: ply % 2 === 1 };
        this.games.set(gid, game);
      }
      if (ply <= game.moves.length) return [];
      const next = applyPath32(game.pos, rec.path32);
      if (!next) return [];
      game.pos = next;
      game.moves.push(rec.path32);
      const replyPkt = this.makeBotMove(gid, game);
      return replyPkt ? [{ delayMs: 1150, payload: replyPkt }] : [];
    }

    if (op === OP_SYNC_MOVES && payload.length >= 6) {
      const fromPly = payload[3]! | (payload[4]! << 8);
      const count = payload[5]!;
      let game = this.games.get(gid);
      if (!game || fromPly === 0) {
        game = { pos: initialState(), moves: [], botBlack: true };
        this.games.set(gid, game);
      }
      let off = 6;
      for (let i = 0; i < count && off < payload.length; i++) {
        const rec = decodeMoveRecord(payload, off);
        if (!rec) break;
        off = rec.nextOffset;
        if (fromPly + i < game.moves.length) continue;
        const next = applyPath32(game.pos, rec.path32);
        if (!next) break;
        game.pos = next;
        game.moves.push(rec.path32);
      }
      if ((game.botBlack && game.pos.turn === "b") || (!game.botBlack && game.pos.turn === "w")) {
        const replyPkt = this.makeBotMove(gid, game);
        return replyPkt ? [{ delayMs: 850, payload: replyPkt }] : [];
      }
      return [];
    }

    if (op === OP_ACTION && payload.length >= 6) {
      const ply = payload[3]! | (payload[4]! << 8);
      if (payload[5] === ACT_DRAW_OFFER) {
        return [{ delayMs: 900, payload: new Uint8Array([OP_ACTION, gid & 0xff, (gid >> 8) & 0xff, ply & 0xff, (ply >> 8) & 0xff, ACT_DRAW_ACCEPT]) }];
      }
    }

    if (op === OP_SYNC_REQ && payload.length >= 5) {
      const fromPly = payload[3]! | (payload[4]! << 8);
      const game = this.games.get(gid);
      if (!game) return [];
      if (fromPly > game.moves.length) {
        return [{ delayMs: 500, payload: new Uint8Array([OP_SYNC_REQ, gid & 0xff, (gid >> 8) & 0xff, game.moves.length & 0xff, (game.moves.length >> 8) & 0xff]) }];
      }
      const body: number[] = [];
      let count = 0;
      for (let i = fromPly; i < game.moves.length && count < 255; i++) {
        const rec = encodeMoveRecord(game.moves[i]!);
        if (body.length + rec.length > 144) break;
        body.push(...rec);
        count++;
      }
      const out = new Uint8Array(6 + body.length);
      out[0] = OP_SYNC_MOVES;
      out[1] = gid & 0xff;
      out[2] = (gid >> 8) & 0xff;
      out[3] = fromPly & 0xff;
      out[4] = (fromPly >> 8) & 0xff;
      out[5] = count;
      out.set(body, 6);
      return [{ delayMs: 700, payload: out }];
    }

    if (op === OP_CHAT && payload.length > 3) {
      const incoming = new TextDecoder().decode(payload.subarray(3)).trim();
      const ru = /[а-яёА-ЯЁ]/.test(incoming);
      const pool = ru
        ? ["Привет! Сыграем в русские шашки!", "Хороший ход! Думаю над ответом…", "Ловушка? Посмотрим 😄", "Принято по LoRa 📡"]
        : ["Hey! Ready for Russian draughts!", "Nice move! Thinking…", "A trap? Let's see 😄", "Copy over LoRa 📡"];
      const text = incoming.includes("👋") ? pool[0]! : pool[1 + (this.chatReplyIdx++ % (pool.length - 1))]!;
      const enc = new TextEncoder().encode(text);
      const out = new Uint8Array(3 + enc.length);
      out[0] = OP_CHAT;
      out[1] = gid & 0xff;
      out[2] = (gid >> 8) & 0xff;
      out.set(enc, 3);
      return [{ delayMs: 1000, payload: out }];
    }

    return [];
  }

  private makeBotMove(gid: number, game: DemoGame): Uint8Array | null {
    const moves = legalMoves(game.pos);
    if (moves.length === 0) return null;
    const scored = moves.map((m) => {
      const to = m.path[m.path.length - 1]!;
      const f = to & 7;
      const r = to >> 3;
      let score = Math.random() * 2 + m.captures.length * 35 + (m.promoted ? 50 : 0);
      if (f >= 2 && f <= 5 && r >= 2 && r <= 5) score += 5;
      if (f === 0 || f === 7) score += 2; // safe edge
      return { m, score };
    });
    scored.sort((a, b) => b.score - a.score);
    const chosen = scored[0]!.m;
    const path32 = chosen.path.map(sq64To32);
    game.pos = applyLegal(game.pos, chosen);
    game.moves.push(path32);
    const ply = game.moves.length;
    const rec = encodeMoveRecord(path32);
    const out = new Uint8Array(6 + rec.length);
    out[0] = OP_MOVE;
    out[1] = gid & 0xff;
    out[2] = (gid >> 8) & 0xff;
    out[3] = ply & 0xff;
    out[4] = (ply >> 8) & 0xff;
    out.set(rec, 5);
    out[5 + rec.length] = posHash8(game.pos);
    return out;
  }
}
