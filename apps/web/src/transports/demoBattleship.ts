/**
 * Honest commit-reveal Battleship opponent for Demo Mode (`demo.ts`), speaking
 * the exact `ommesh.battleship` (`appId = 0x0102`) binary wire protocol with
 * hunt/target AI firing and real SHA-256 fleet commitments.
 */

export const DEMO_BATTLESHIP_APP_ID = 0x0102;

const OP_INVITE = 1;
const OP_ACCEPT = 2;
const OP_READY = 4;
const OP_SHOT = 5;
const OP_RESULT = 6;
const OP_ACTION = 7;
const OP_CHAT = 8;
const OP_REVEAL = 9;
const OP_SYNC_REQ = 10;

const RES_MISS = 0;
const RES_HIT = 1;
const RES_SUNK = 2;
const RES_WIN = 3;
const FLEET_LENS = [4, 3, 3, 2, 2, 2, 1, 1, 1, 1] as const;

interface Ship {
  x: number;
  y: number;
  len: number;
  horiz: boolean;
}

const SHA_K = [
  0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
  0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
  0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
  0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
  0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
  0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
  0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
  0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2,
];

function sha256First8(msg: Uint8Array): Uint8Array {
  const len = msg.length;
  const bitLen = len * 8;
  const padLen = ((len + 9 + 63) >> 6) << 6;
  const buf = new Uint8Array(padLen);
  buf.set(msg);
  buf[len] = 0x80;
  buf[padLen - 4] = (bitLen >>> 24) & 0xff;
  buf[padLen - 3] = (bitLen >>> 16) & 0xff;
  buf[padLen - 2] = (bitLen >>> 8) & 0xff;
  buf[padLen - 1] = bitLen & 0xff;

  let H0 = 0x6a09e667, H1 = 0xbb67ae85, H2 = 0x3c6ef372, H3 = 0xa54ff53a;
  let H4 = 0x510e527f, H5 = 0x9b05688c, H6 = 0x1f83d9ab, H7 = 0x5be0cd19;
  const W = new Int32Array(64);

  for (let off = 0; off < padLen; off += 64) {
    for (let i = 0; i < 16; i++) {
      const o = off + i * 4;
      W[i] = (buf[o]! << 24) | (buf[o + 1]! << 16) | (buf[o + 2]! << 8) | buf[o + 3]!;
    }
    for (let t = 16; t < 64; t++) {
      const w15 = W[t - 15]!, w2 = W[t - 2]!;
      const s0 = ((w15 >>> 7) | (w15 << 25)) ^ ((w15 >>> 18) | (w15 << 14)) ^ (w15 >>> 3);
      const s1 = ((w2 >>> 17) | (w2 << 15)) ^ ((w2 >>> 19) | (w2 << 13)) ^ (w2 >>> 10);
      W[t] = (W[t - 16]! + s0 + W[t - 7]! + s1) | 0;
    }
    let a = H0, b = H1, c = H2, d = H3, e = H4, f = H5, g = H6, h = H7;
    for (let r = 0; r < 64; r++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + SHA_K[r]! + W[r]!) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) | 0;
      h = g; g = f; f = e; e = (d + temp1) | 0;
      d = c; c = b; b = a; a = (temp1 + temp2) | 0;
    }
    H0 = (H0 + a) | 0; H1 = (H1 + b) | 0; H2 = (H2 + c) | 0; H3 = (H3 + d) | 0;
    H4 = (H4 + e) | 0; H5 = (H5 + f) | 0; H6 = (H6 + g) | 0; H7 = (H7 + h) | 0;
  }
  return new Uint8Array([
    (H0 >>> 24) & 0xff, (H0 >>> 16) & 0xff, (H0 >>> 8) & 0xff, H0 & 0xff,
    (H1 >>> 24) & 0xff, (H1 >>> 16) & 0xff, (H1 >>> 8) & 0xff, H1 & 0xff,
  ]);
}

function shipCells(s: Ship): number[] {
  const out: number[] = [];
  for (let i = 0; i < s.len; i++) {
    out.push((s.y + (s.horiz ? 0 : i)) * 10 + (s.x + (s.horiz ? i : 0)));
  }
  return out;
}

function canPlace(ships: Ship[], cand: Ship): boolean {
  if (cand.horiz && cand.x + cand.len > 10) return false;
  if (!cand.horiz && cand.y + cand.len > 10) return false;
  const blocked = new Set<number>();
  for (const s of ships) {
    for (const c of shipCells(s)) {
      const sx = c % 10, sy = Math.floor(c / 10);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const nx = sx + dx, ny = sy + dy;
          if (nx >= 0 && nx < 10 && ny >= 0 && ny < 10) blocked.add(ny * 10 + nx);
        }
      }
    }
  }
  return shipCells(cand).every((c) => !blocked.has(c));
}

function randomFleet(): Ship[] {
  for (let attempt = 0; attempt < 200; attempt++) {
    const placed: Ship[] = [];
    let ok = true;
    for (const len of FLEET_LENS) {
      const cands: Ship[] = [];
      for (const horiz of [true, false]) {
        const maxX = horiz ? 10 - len : 9;
        const maxY = horiz ? 9 : 10 - len;
        for (let y = 0; y <= maxY; y++) {
          for (let x = 0; x <= maxX; x++) {
            const c = { x, y, len, horiz };
            if (canPlace(placed, c)) cands.push(c);
          }
        }
      }
      if (cands.length === 0) { ok = false; break; }
      placed.push(cands[Math.floor(Math.random() * cands.length)]!);
    }
    if (ok) {
      return placed.sort((a, b) => (b.len !== a.len ? b.len - a.len : (a.y * 10 + a.x) - (b.y * 10 + b.x)));
    }
  }
  return [];
}

function packShipByte(s: Ship): number {
  return ((s.y * 10 + s.x) & 0x7f) | (s.horiz ? 0x80 : 0);
}

interface DemoBsGame {
  ships: Ship[];
  fleetBytes: Uint8Array;
  salt: Uint8Array;
  commit: Uint8Array;
  seq: number;
  playerHitsOnBot: Set<number>;
  botFired: Set<number>;
  botExcluded: Set<number>;
  targetQueue: number[];
  finished: boolean;
}

export interface DemoBattleshipReply {
  delayMs: number;
  payload: Uint8Array;
}

export class DemoBattleshipBot {
  private games = new Map<number, DemoBsGame>();
  private chatReplyIdx = 0;

  private createGame(gid: number): DemoBsGame {
    const ships = randomFleet();
    const fleetBytes = new Uint8Array(ships.map(packShipByte));
    const salt = new Uint8Array(8);
    for (let i = 0; i < 8; i++) salt[i] = Math.floor(Math.random() * 256);
    const msg = new Uint8Array(18);
    msg.set(fleetBytes, 0);
    msg.set(salt, 10);
    const commit = sha256First8(msg);
    const g: DemoBsGame = {
      ships, fleetBytes, salt, commit, seq: 0,
      playerHitsOnBot: new Set(), botFired: new Set(), botExcluded: new Set(), targetQueue: [], finished: false,
    };
    this.games.set(gid, g);
    return g;
  }

  private encodeReveal(gid: number, g: DemoBsGame): Uint8Array {
    const out = new Uint8Array(21);
    out[0] = OP_REVEAL;
    out[1] = gid & 0xff;
    out[2] = (gid >> 8) & 0xff;
    out.set(g.fleetBytes, 3);
    out.set(g.salt, 13);
    return out;
  }

  private pickNextTarget(g: DemoBsGame): number | null {
    while (g.targetQueue.length > 0) {
      const c = g.targetQueue.shift()!;
      if (!g.botFired.has(c) && !g.botExcluded.has(c)) return c;
    }
    const checker: number[] = [];
    const rest: number[] = [];
    for (let c = 0; c < 100; c++) {
      if (g.botFired.has(c) || g.botExcluded.has(c)) continue;
      const x = c % 10, y = Math.floor(c / 10);
      if (((x + y) & 1) === 0) checker.push(c);
      else rest.push(c);
    }
    const pool = checker.length > 0 ? checker : rest;
    if (pool.length === 0) return null;
    return pool[Math.floor(Math.random() * pool.length)]!;
  }

  private enqueueNeighbors(g: DemoBsGame, cell: number): void {
    const x = cell % 10, y = Math.floor(cell / 10);
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;
    for (const [dx, dy] of dirs) {
      const nx = x + dx, ny = y + dy;
      if (nx >= 0 && nx < 10 && ny >= 0 && ny < 10) {
        const idx = ny * 10 + nx;
        if (!g.botFired.has(idx) && !g.botExcluded.has(idx)) g.targetQueue.push(idx);
      }
    }
  }

  private markSunkHalo(g: DemoBsGame, sunkShipByte: number, sunkLen: number): void {
    const cell = sunkShipByte & 0x7f;
    const horiz = (sunkShipByte & 0x80) !== 0;
    const s: Ship = { x: cell % 10, y: Math.floor(cell / 10), len: sunkLen, horiz };
    for (const c of shipCells(s)) {
      const sx = c % 10, sy = Math.floor(c / 10);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const nx = sx + dx, ny = sy + dy;
          if (nx >= 0 && nx < 10 && ny >= 0 && ny < 10) g.botExcluded.add(ny * 10 + nx);
        }
      }
    }
    g.targetQueue = g.targetQueue.filter((c) => !g.botExcluded.has(c));
  }

  private makeBotShot(gid: number, g: DemoBsGame): Uint8Array | null {
    if (g.finished) return null;
    const target = this.pickNextTarget(g);
    if (target === null) return null;
    g.botFired.add(target);
    g.seq++;
    return new Uint8Array([OP_SHOT, gid & 0xff, (gid >> 8) & 0xff, g.seq & 0xff, (g.seq >> 8) & 0xff, target]);
  }

  /** Handles an outgoing `ommesh.battleship` packet and returns delayed opponent packets. */
  onOutgoing(payload: Uint8Array): DemoBattleshipReply[] {
    if (payload.length < 3) return [];
    const op = payload[0]! & 0x1f;
    const gid = payload[1]! | (payload[2]! << 8);

    if (op === OP_INVITE) {
      const g = this.createGame(gid);
      const ready = new Uint8Array(11);
      ready[0] = OP_READY;
      ready[1] = gid & 0xff;
      ready[2] = (gid >> 8) & 0xff;
      ready.set(g.commit, 3);
      return [
        { delayMs: 700, payload: new Uint8Array([OP_ACCEPT, gid & 0xff, (gid >> 8) & 0xff, 0]) },
        { delayMs: 1450, payload: ready },
      ];
    }

    if (op === OP_READY) {
      let g = this.games.get(gid);
      if (!g) {
        g = this.createGame(gid);
        const ready = new Uint8Array(11);
        ready[0] = OP_READY;
        ready[1] = gid & 0xff;
        ready[2] = (gid >> 8) & 0xff;
        ready.set(g.commit, 3);
        return [{ delayMs: 800, payload: ready }];
      }
      return [];
    }

    if (op === OP_SHOT && payload.length >= 6) {
      const seq = payload[3]! | (payload[4]! << 8);
      const cell = payload[5]!;
      let g = this.games.get(gid);
      if (!g) g = this.createGame(gid);
      if (seq > g.seq) g.seq = seq;

      let hitShip: Ship | null = null;
      for (const s of g.ships) {
        if (shipCells(s).includes(cell)) { hitShip = s; break; }
      }
      let res = RES_MISS;
      let sunkShip = 0;
      let sunkLen = 0;
      if (hitShip) {
        g.playerHitsOnBot.add(cell);
        const shipSunk = shipCells(hitShip).every((c) => g.playerHitsOnBot.has(c));
        if (!shipSunk) {
          res = RES_HIT;
        } else {
          sunkShip = packShipByte(hitShip);
          sunkLen = hitShip.len;
          const allSunk = g.ships.every((s) => shipCells(s).every((c) => g.playerHitsOnBot.has(c)));
          res = allSunk ? RES_WIN : RES_SUNK;
          if (allSunk) g.finished = true;
        }
      }

      const resPkt = (res === RES_SUNK || res === RES_WIN)
        ? new Uint8Array([OP_RESULT, gid & 0xff, (gid >> 8) & 0xff, seq & 0xff, (seq >> 8) & 0xff, cell, res, sunkShip, sunkLen])
        : new Uint8Array([OP_RESULT, gid & 0xff, (gid >> 8) & 0xff, seq & 0xff, (seq >> 8) & 0xff, cell, res]);

      const replies: DemoBattleshipReply[] = [{ delayMs: 650, payload: resPkt }];
      if (res === RES_WIN) {
        replies.push({ delayMs: 1100, payload: this.encodeReveal(gid, g) });
      } else if (res === RES_MISS) {
        const botShot = this.makeBotShot(gid, g);
        if (botShot) replies.push({ delayMs: 1450, payload: botShot });
      }
      return replies;
    }

    if (op === OP_RESULT && payload.length >= 7) {
      const seq = payload[3]! | (payload[4]! << 8);
      const cell = payload[5]!;
      const res = payload[6]!;
      const g = this.games.get(gid);
      if (!g) return [];
      if (seq > g.seq) g.seq = seq;
      if (res === RES_HIT) {
        this.enqueueNeighbors(g, cell);
        const nextShot = this.makeBotShot(gid, g);
        return nextShot ? [{ delayMs: 1100, payload: nextShot }] : [];
      }
      if (res === RES_SUNK) {
        const sunkShip = payload[7] ?? 0;
        const sunkLen = payload[8] ?? 0;
        if (sunkLen > 0) this.markSunkHalo(g, sunkShip, sunkLen);
        const nextShot = this.makeBotShot(gid, g);
        return nextShot ? [{ delayMs: 1200, payload: nextShot }] : [];
      }
      if (res === RES_WIN) {
        g.finished = true;
        return [{ delayMs: 850, payload: this.encodeReveal(gid, g) }];
      }
      return [];
    }

    if (op === OP_ACTION && payload.length >= 6) {
      const g = this.games.get(gid);
      if (!g) return [];
      g.finished = true;
      return [{ delayMs: 700, payload: this.encodeReveal(gid, g) }];
    }

    if (op === OP_SYNC_REQ && payload.length >= 6) {
      const g = this.games.get(gid);
      if (!g) return [];
      const replies: DemoBattleshipReply[] = [];
      const ready = new Uint8Array(11);
      ready[0] = OP_READY;
      ready[1] = gid & 0xff;
      ready[2] = (gid >> 8) & 0xff;
      ready.set(g.commit, 3);
      replies.push({ delayMs: 600, payload: ready });
      if (g.finished) replies.push({ delayMs: 900, payload: this.encodeReveal(gid, g) });
      return replies;
    }

    if (op === OP_CHAT && payload.length > 3) {
      const incoming = new TextDecoder().decode(payload.subarray(3)).trim();
      const ru = /[а-яёА-ЯЁ]/.test(incoming);
      const pool = ru
        ? ["Попутного ветра! ⚓", "Есть пробитие или мимо? 😄", "Принято по LoRa 📡", "Отличный залп!"]
        : ["Fair winds! ⚓", "Hit or miss? 😄", "Copy over LoRa 📡", "Great salvo!"];
      const text = incoming.includes("👋") ? pool[0]! : pool[1 + (this.chatReplyIdx++ % (pool.length - 1))]!;
      const enc = new TextEncoder().encode(text);
      const out = new Uint8Array(3 + enc.length);
      out[0] = OP_CHAT;
      out[1] = gid & 0xff;
      out[2] = (gid >> 8) & 0xff;
      out.set(enc, 3);
      return [{ delayMs: 950, payload: out }];
    }

    return [];
  }
}
