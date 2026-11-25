/**
 * First isolated Ommesh mini-app: Peer-to-Peer LoRa Chess (`ommesh.chess`,
 * `appId = 0x0100`), packaged strictly as a `.omapp` bundle consuming only
 * `@ommesh/miniapp-sdk` (`window.ommeshReady` + headless `workerJs`).
 *
 * Wire format (`app_id = 0x0100`):
 * - `0x01` INVITE:     `[0x01, gid(u16 LE), flags(u8: bit0=challengerBlack), 0]` (5 B -> 1 AES block)
 * - `0x02` ACCEPT:     `[0x02, gid(u16 LE), flags(u8)]` (4 B -> 1 AES block)
 * - `0x03` DECLINE:    `[0x03, gid(u16 LE)]` (3 B -> 1 AES block)
 * - `0x04` MOVE:       `[0x04, gid(u16 LE), ply(u16 LE), moveBits(u16 LE), posHash8(u8)]` (8 B -> 1 AES block)
 * - `0x05` ACTION:     `[0x05, gid(u16 LE), ply(u16 LE), action(u8: 1=resign,2=drawOffer,3=drawAccept,4=drawDecline)]` (6 B)
 * - `0x06` SYNC_REQ:   `[0x06, gid(u16 LE), fromPly(u16 LE)]` (5 B)
 * - `0x07` SYNC_MOVES: `[0x07, gid(u16 LE), fromPly(u16 LE), count(u8), ...moves(u16 LE)]` (up to 72 plies/packet)
 * - `0x08` CHAT:       `[0x08, gid(u16 LE), ...utf8]` (up to 147 B UTF-8 in-game chat message)
 */

import type { MiniAppPackage } from "@ommesh/miniapp-sdk";

export const CHESS_APP_ID = 0x0100;

const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="6" r="2.5"/><path d="M9.5 10.5h5l1 5.5H8.5l1-5.5Z"/><path d="M7 18.5h10v2H7z"/></svg>`;

/** Shared deterministic FIDE chess rules + binary wire codec used inside both UI iframe and background worker. */
const CHESS_ENGINE_JS = `
var OP_INVITE = 1, OP_ACCEPT = 2, OP_DECLINE = 3, OP_MOVE = 4, OP_ACTION = 5, OP_SYNC_REQ = 6, OP_SYNC_MOVES = 7, OP_CHAT = 8;
var MAX_CHAT_UTF8 = 147;
var ACT_RESIGN = 1, ACT_DRAW_OFFER = 2, ACT_DRAW_ACCEPT = 3, ACT_DRAW_DECLINE = 4;
var PROMO_MAP = ["", "n", "b", "r", "q"];

function sqName(sq) {
  return "abcdefgh"[sq & 7] + String((sq >> 3) + 1);
}

function packMove(from, to, promoIdx, offerDraw) {
  return (from & 63) | ((to & 63) << 6) | ((promoIdx & 7) << 12) | (offerDraw ? 0x8000 : 0);
}

function unpackMove(bits) {
  return {
    from: bits & 63,
    to: (bits >> 6) & 63,
    promo: (bits >> 12) & 7,
    offerDraw: (bits & 0x8000) !== 0
  };
}

function initialState() {
  var b = new Array(64).fill("");
  var back = ["r", "n", "b", "q", "k", "b", "n", "r"];
  for (var f = 0; f < 8; f++) {
    b[f] = back[f].toUpperCase();
    b[8 + f] = "P";
    b[48 + f] = "p";
    b[56 + f] = back[f];
  }
  return { board: b, turn: "w", castle: 15, ep: -1, half: 0, ply: 0 };
}

function clonePos(p) {
  return { board: p.board.slice(), turn: p.turn, castle: p.castle, ep: p.ep, half: p.half, ply: p.ply };
}

function pieceColor(ch) {
  if (!ch) return "";
  return ch === ch.toUpperCase() ? "w" : "b";
}

function posHash8(p) {
  var h = 2166136261 >>> 0;
  for (var i = 0; i < 64; i++) {
    var c = p.board[i] ? p.board[i].charCodeAt(0) : 46;
    h = Math.imul(h ^ c, 16777619) >>> 0;
  }
  h = Math.imul(h ^ (p.turn === "w" ? 1 : 2), 16777619) >>> 0;
  h = Math.imul(h ^ p.castle, 16777619) >>> 0;
  h = Math.imul(h ^ (p.ep + 2), 16777619) >>> 0;
  return h & 0xff;
}

function isAttacked(board, sq, byColor) {
  var f = sq & 7, r = sq >> 3;
  var pawnDir = byColor === "w" ? -1 : 1;
  var pr = r + pawnDir;
  var enemyP = byColor === "w" ? "P" : "p";
  if (pr >= 0 && pr < 8) {
    if (f > 0 && board[(pr << 3) | (f - 1)] === enemyP) return true;
    if (f < 7 && board[(pr << 3) | (f + 1)] === enemyP) return true;
  }
  var enemyN = byColor === "w" ? "N" : "n";
  var kd = [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]];
  for (var i = 0; i < kd.length; i++) {
    var nf = f + kd[i][0], nr = r + kd[i][1];
    if (nf >= 0 && nf < 8 && nr >= 0 && nr < 8 && board[(nr << 3) | nf] === enemyN) return true;
  }
  var enemyK = byColor === "w" ? "K" : "k";
  for (var df = -1; df <= 1; df++) {
    for (var dr = -1; dr <= 1; dr++) {
      if (!df && !dr) continue;
      var kf = f + df, kr = r + dr;
      if (kf >= 0 && kf < 8 && kr >= 0 && kr < 8 && board[(kr << 3) | kf] === enemyK) return true;
    }
  }
  var enemyB = byColor === "w" ? "B" : "b";
  var enemyR = byColor === "w" ? "R" : "r";
  var enemyQ = byColor === "w" ? "Q" : "q";
  var diag = [[-1,-1],[-1,1],[1,-1],[1,1]];
  for (var d = 0; d < 4; d++) {
    var cf = f + diag[d][0], cr = r + diag[d][1];
    while (cf >= 0 && cf < 8 && cr >= 0 && cr < 8) {
      var pc = board[(cr << 3) | cf];
      if (pc) { if (pc === enemyB || pc === enemyQ) return true; break; }
      cf += diag[d][0]; cr += diag[d][1];
    }
  }
  var ortho = [[-1,0],[1,0],[0,-1],[0,1]];
  for (var o = 0; o < 4; o++) {
    var of = f + ortho[o][0], or = r + ortho[o][1];
    while (of >= 0 && of < 8 && or >= 0 && or < 8) {
      var pc2 = board[(or << 3) | of];
      if (pc2) { if (pc2 === enemyR || pc2 === enemyQ) return true; break; }
      of += ortho[o][0]; or += ortho[o][1];
    }
  }
  return false;
}

function kingSquare(board, color) {
  var k = color === "w" ? "K" : "k";
  for (var i = 0; i < 64; i++) if (board[i] === k) return i;
  return -1;
}

function inCheck(p, color) {
  var ks = kingSquare(p.board, color);
  return ks >= 0 && isAttacked(p.board, ks, color === "w" ? "b" : "w");
}

function applyMoveUnchecked(p, from, to, promoIdx) {
  var next = clonePos(p);
  var b = next.board;
  var pc = b[from];
  var type = pc.toLowerCase();
  var color = pieceColor(pc);
  var captured = b[to];
  b[to] = pc;
  b[from] = "";
  next.ep = -1;
  if (type === "p") {
    next.half = 0;
    if (to === p.ep) {
      var capSq = color === "w" ? to - 8 : to + 8;
      b[capSq] = "";
      captured = color === "w" ? "p" : "P";
    }
    if (Math.abs((to >> 3) - (from >> 3)) === 2) {
      next.ep = (from + to) >> 1;
    }
    var rank = to >> 3;
    if (rank === 0 || rank === 7) {
      var pr = PROMO_MAP[promoIdx || 4] || "q";
      b[to] = color === "w" ? pr.toUpperCase() : pr;
    }
  } else {
    next.half = captured ? 0 : p.half + 1;
  }
  if (type === "k") {
    if (color === "w") next.castle &= ~3; else next.castle &= ~12;
    if (to - from === 2) { b[to - 1] = b[to + 1]; b[to + 1] = ""; }
    else if (from - to === 2) { b[to + 1] = b[to - 2]; b[to - 2] = ""; }
  }
  if (from === 0 || to === 0) next.castle &= ~2;
  if (from === 7 || to === 7) next.castle &= ~1;
  if (from === 56 || to === 56) next.castle &= ~8;
  if (from === 63 || to === 63) next.castle &= ~4;
  next.turn = color === "w" ? "b" : "w";
  next.ply = p.ply + 1;
  return { pos: next, captured: captured };
}

function legalMoves(p) {
  var moves = [];
  var color = p.turn;
  var enemy = color === "w" ? "b" : "w";
  var b = p.board;
  function tryPush(from, to, promo) {
    var res = applyMoveUnchecked(p, from, to, promo);
    if (!inCheck(res.pos, color)) moves.push({ from: from, to: to, promo: promo || 0 });
  }
  for (var sq = 0; sq < 64; sq++) {
    var pc = b[sq];
    if (!pc || pieceColor(pc) !== color) continue;
    var type = pc.toLowerCase();
    var f = sq & 7, r = sq >> 3;
    if (type === "p") {
      var dir = color === "w" ? 1 : -1;
      var startR = color === "w" ? 1 : 6;
      var promoR = color === "w" ? 7 : 0;
      var r1 = r + dir;
      if (r1 >= 0 && r1 < 8) {
        var fwd = (r1 << 3) | f;
        if (!b[fwd]) {
          if (r1 === promoR) { for (var pr = 1; pr <= 4; pr++) tryPush(sq, fwd, pr); }
          else {
            tryPush(sq, fwd, 0);
            if (r === startR) {
              var fwd2 = ((r + 2 * dir) << 3) | f;
              if (!b[fwd2]) tryPush(sq, fwd2, 0);
            }
          }
        }
        var caps = [-1, 1];
        for (var ci = 0; ci < 2; ci++) {
          var cf = f + caps[ci];
          if (cf < 0 || cf > 7) continue;
          var tsq = (r1 << 3) | cf;
          if ((b[tsq] && pieceColor(b[tsq]) === enemy) || tsq === p.ep) {
            if (r1 === promoR) { for (var pr2 = 1; pr2 <= 4; pr2++) tryPush(sq, tsq, pr2); }
            else tryPush(sq, tsq, 0);
          }
        }
      }
    } else if (type === "n") {
      var nd = [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]];
      for (var ni = 0; ni < 8; ni++) {
        var nf = f + nd[ni][0], nr = r + nd[ni][1];
        if (nf < 0 || nf > 7 || nr < 0 || nr > 7) continue;
        var nsq = (nr << 3) | nf;
        if (!b[nsq] || pieceColor(b[nsq]) === enemy) tryPush(sq, nsq, 0);
      }
    } else if (type === "k") {
      for (var df = -1; df <= 1; df++) {
        for (var dr = -1; dr <= 1; dr++) {
          if (!df && !dr) continue;
          var kf = f + df, kr = r + dr;
          if (kf < 0 || kf > 7 || kr < 0 || kr > 7) continue;
          var ksq = (kr << 3) | kf;
          if (!b[ksq] || pieceColor(b[ksq]) === enemy) tryPush(sq, ksq, 0);
        }
      }
      if (!inCheck(p, color)) {
        if (color === "w" && sq === 4) {
          if ((p.castle & 1) && !b[5] && !b[6] && b[7] === "R" && !isAttacked(b, 5, "b") && !isAttacked(b, 6, "b")) tryPush(4, 6, 0);
          if ((p.castle & 2) && !b[3] && !b[2] && !b[1] && b[0] === "R" && !isAttacked(b, 3, "b") && !isAttacked(b, 2, "b")) tryPush(4, 2, 0);
        } else if (color === "b" && sq === 60) {
          if ((p.castle & 4) && !b[61] && !b[62] && b[63] === "r" && !isAttacked(b, 61, "w") && !isAttacked(b, 62, "w")) tryPush(60, 62, 0);
          if ((p.castle & 8) && !b[59] && !b[58] && !b[57] && b[56] === "r" && !isAttacked(b, 59, "w") && !isAttacked(b, 58, "w")) tryPush(60, 58, 0);
        }
      }
    } else {
      var dirs = type === "b" ? [[-1,-1],[-1,1],[1,-1],[1,1]]
               : type === "r" ? [[-1,0],[1,0],[0,-1],[0,1]]
               : [[-1,-1],[-1,1],[1,-1],[1,1],[-1,0],[1,0],[0,-1],[0,1]];
      for (var di = 0; di < dirs.length; di++) {
        var sf = f + dirs[di][0], sr = r + dirs[di][1];
        while (sf >= 0 && sf < 8 && sr >= 0 && sr < 8) {
          var ssq = (sr << 3) | sf;
          if (!b[ssq]) { tryPush(sq, ssq, 0); }
          else { if (pieceColor(b[ssq]) === enemy) tryPush(sq, ssq, 0); break; }
          sf += dirs[di][0]; sr += dirs[di][1];
        }
      }
    }
  }
  return moves;
}

function formatMoveLabel(p, move, nextPos) {
  var pc = p.board[move.from];
  var type = pc.toLowerCase();
  var cap = !!p.board[move.to] || (type === "p" && move.to === p.ep);
  var s = "";
  if (type === "k" && move.to - move.from === 2) s = "O-O";
  else if (type === "k" && move.from - move.to === 2) s = "O-O-O";
  else {
    if (type !== "p") s += type.toUpperCase();
    else if (cap) s += "abcdefgh"[move.from & 7];
    if (cap) s += "x";
    s += sqName(move.to);
    if (move.promo) s += "=" + PROMO_MAP[move.promo].toUpperCase();
  }
  var nextLegal = legalMoves(nextPos);
  var chk = inCheck(nextPos, nextPos.turn);
  if (chk && nextLegal.length === 0) s += "#";
  else if (chk) s += "+";
  return s;
}

function replayMoves(moveBitsList) {
  var pos = initialState();
  var labels = [];
  for (var i = 0; i < moveBitsList.length; i++) {
    var u = unpackMove(moveBitsList[i]);
    var legal = legalMoves(pos);
    var match = null;
    for (var j = 0; j < legal.length; j++) {
      if (legal[j].from === u.from && legal[j].to === u.to && legal[j].promo === u.promo) { match = legal[j]; break; }
    }
    if (!match) return null;
    var res = applyMoveUnchecked(pos, match.from, match.to, match.promo);
    labels.push(formatMoveLabel(pos, match, res.pos));
    pos = res.pos;
  }
  var legalEnd = legalMoves(pos);
  var check = inCheck(pos, pos.turn);
  var outcome = null;
  if (legalEnd.length === 0) outcome = check ? (pos.turn === "w" ? "black" : "white") : "draw";
  return { pos: pos, labels: labels, legal: legalEnd, check: check, outcome: outcome };
}

function encodePacket(op, gameId, extra) {
  var out = new Uint8Array(3 + (extra ? extra.length : 0));
  out[0] = op & 0x1f;
  out[1] = gameId & 0xff;
  out[2] = (gameId >> 8) & 0xff;
  if (extra) out.set(extra, 3);
  return out;
}

function encodeInvite(gameId, myColor) {
  return encodePacket(OP_INVITE, gameId, [myColor === "b" ? 1 : 0, 0]);
}
function encodeAccept(gameId, myColor) {
  return encodePacket(OP_ACCEPT, gameId, [myColor === "b" ? 1 : 0]);
}
function encodeDecline(gameId) {
  return encodePacket(OP_DECLINE, gameId, []);
}
function encodeMovePkt(gameId, ply, moveBits, hash8) {
  return encodePacket(OP_MOVE, gameId, [ply & 0xff, (ply >> 8) & 0xff, moveBits & 0xff, (moveBits >> 8) & 0xff, hash8 & 0xff]);
}
function encodeActionPkt(gameId, ply, action) {
  return encodePacket(OP_ACTION, gameId, [ply & 0xff, (ply >> 8) & 0xff, action & 0xff]);
}
function encodeSyncReq(gameId, fromPly) {
  return encodePacket(OP_SYNC_REQ, gameId, [fromPly & 0xff, (fromPly >> 8) & 0xff]);
}
function encodeSyncMoves(gameId, fromPly, movesSlice) {
  var count = Math.min(72, movesSlice.length);
  var buf = new Uint8Array(3 + count * 2);
  buf[0] = fromPly & 0xff;
  buf[1] = (fromPly >> 8) & 0xff;
  buf[2] = count;
  for (var i = 0; i < count; i++) {
    buf[3 + i * 2] = movesSlice[i] & 0xff;
    buf[4 + i * 2] = (movesSlice[i] >> 8) & 0xff;
  }
  return encodePacket(OP_SYNC_MOVES, gameId, buf);
}
function encodeUtf8Limited(text, maxBytes) {
  var enc = new TextEncoder();
  var bytes = enc.encode(String(text || "").trim());
  if (bytes.length <= maxBytes) return bytes;
  var cut = maxBytes;
  while (cut > 0 && (bytes[cut] & 0xc0) === 0x80) cut--;
  return bytes.slice(0, cut);
}
function encodeChatPkt(gameId, text) {
  return encodePacket(OP_CHAT, gameId, encodeUtf8Limited(text, MAX_CHAT_UTF8));
}

function decodePacket(bytes) {
  if (!bytes || bytes.length < 3) return null;
  var op = bytes[0] & 0x1f;
  var gameId = bytes[1] | (bytes[2] << 8);
  if (op === OP_INVITE && bytes.length >= 4) return { op: op, gameId: gameId, challengerColor: (bytes[3] & 1) ? "b" : "w" };
  if (op === OP_ACCEPT && bytes.length >= 4) return { op: op, gameId: gameId, accepterColor: (bytes[3] & 1) ? "b" : "w" };
  if (op === OP_DECLINE) return { op: op, gameId: gameId };
  if (op === OP_MOVE && bytes.length >= 8) return { op: op, gameId: gameId, ply: bytes[3] | (bytes[4] << 8), moveBits: bytes[5] | (bytes[6] << 8), hash8: bytes[7] };
  if (op === OP_ACTION && bytes.length >= 6) return { op: op, gameId: gameId, ply: bytes[3] | (bytes[4] << 8), action: bytes[5] };
  if (op === OP_SYNC_REQ && bytes.length >= 5) return { op: op, gameId: gameId, fromPly: bytes[3] | (bytes[4] << 8) };
  if (op === OP_SYNC_MOVES && bytes.length >= 6) {
    var fromPly = bytes[3] | (bytes[4] << 8);
    var count = bytes[5];
    var moves = [];
    for (var i = 0; i < count && 6 + i * 2 + 1 < bytes.length; i++) {
      moves.push(bytes[6 + i * 2] | (bytes[7 + i * 2] << 8));
    }
    return { op: op, gameId: gameId, fromPly: fromPly, moves: moves };
  }
  if (op === OP_CHAT && bytes.length > 3) {
    var txt = new TextDecoder().decode(bytes.subarray(3)).trim();
    if (!txt) return null;
    return { op: op, gameId: gameId, text: txt };
  }
  return null;
}

function buildActivities(games, locale) {
  var ru = locale === "ru";
  return Object.values(games)
    .filter(function (g) { return g.status !== "declined"; })
    .sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); })
    .map(function (g) {
      var rep = replayMoves(g.moves || []) || { pos: initialState(), labels: [], outcome: null };
      var myTurn = g.status === "active" && rep.pos.turn === g.myColor;
      var lastMove = rep.labels.length ? rep.labels[rep.labels.length - 1] : "";
      var badge = null;
      var subtitle = "";
      var attention = false;
      if (g.status === "invited_in") {
        badge = { text: ru ? "Вызов" : "Invite", tone: "accent" };
        subtitle = ru ? "Приглашение в партию" : "Game invitation";
        attention = true;
      } else if (g.status === "invited_out") {
        badge = { text: ru ? "Ожидание" : "Pending", tone: "neutral" };
        subtitle = ru ? "Ждём подтверждения" : "Waiting for reply";
      } else if (g.status === "finished") {
        var win = g.winner === g.myColor;
        badge = g.winner === "draw"
          ? { text: ru ? "Ничья" : "Draw", tone: "neutral" }
          : { text: win ? (ru ? "Победа" : "Won") : (ru ? "Поражение" : "Lost"), tone: win ? "success" : "danger" };
        subtitle = lastMove ? (ru ? "Завершена • " : "Finished • ") + lastMove : (ru ? "Партия завершена" : "Game over");
      } else if (myTurn) {
        badge = { text: ru ? "Ваш ход" : "Your turn", tone: "success" };
        subtitle = lastMove ? (ru ? "Последний ход: " : "Last move: ") + lastMove : (ru ? "Партия началась" : "Game started");
        attention = true;
      } else {
        badge = { text: ru ? "Ход соперника" : "Waiting", tone: "neutral" };
        subtitle = lastMove ? (ru ? "Ваш ход: " : "Your move: ") + lastMove : (ru ? "Ждём первый ход" : "Waiting for move");
      }
      if ((g.unreadChat || 0) > 0) attention = true;
      return {
        id: g.id,
        peerKeyPrefix: g.peerPrefix,
        title: g.peerName || g.peerPrefix.slice(0, 8),
        subtitle: subtitle,
        badge: badge,
        needsAttention: attention,
        updatedAt: g.updatedAt || Date.now()
      };
    });
}

function applyIncomingPacket(games, packet, locale) {
  var ru = locale === "ru";
  var decoded = decodePacket(packet.payload);
  if (!decoded) return { changed: false, notify: null, replies: [] };
  var gid = decoded.gameId;
  var key = "g:" + gid.toString(16).padStart(4, "0");
  var g = games[key];
  var now = Date.now();
  var replies = [];
  var notify = null;
  var peerName = packet.peerName || packet.peerPrefix.slice(0, 8);

  if (decoded.op === OP_INVITE) {
    if (!g) {
      games[key] = {
        id: key,
        gameId: gid,
        peerPrefix: packet.peerPrefix,
        peerName: peerName,
        myColor: decoded.challengerColor === "w" ? "b" : "w",
        status: packet.mirrored ? "invited_out" : "invited_in",
        moves: [],
        drawOfferedBy: null,
        winner: null,
        updatedAt: now
      };
      if (!packet.mirrored) notify = { body: ru ? "Приглашение в шахматы" : "Chess invitation", tag: "game:" + key, peerPrefix: packet.peerPrefix };
      return { changed: true, notify: notify, replies: replies, gameKey: key };
    }
    return { changed: false, notify: null, replies: [] };
  }

  if (!g) {
    // Unknown gameId (e.g. fresh device) -> create placeholder and ask for full history sync!
    if (decoded.op === OP_MOVE || decoded.op === OP_SYNC_MOVES) {
      games[key] = {
        id: key, gameId: gid, peerPrefix: packet.peerPrefix, peerName: peerName,
        myColor: "b", status: "active", moves: [], drawOfferedBy: null, winner: null, updatedAt: now
      };
      g = games[key];
    } else {
      return { changed: false, notify: null, replies: [] };
    }
  }
  if (peerName && !packet.mirrored) g.peerName = peerName;

  if (decoded.op === OP_ACCEPT) {
    if (g.status === "invited_out" || g.status === "invited_in") {
      g.status = "active";
      g.updatedAt = now;
      if (!packet.mirrored) notify = { body: ru ? "Приглашение принято — можно ходить" : "Invite accepted", tag: "game:" + key, peerPrefix: packet.peerPrefix };
      return { changed: true, notify: notify, replies: replies, gameKey: key };
    }
  } else if (decoded.op === OP_DECLINE) {
    g.status = "declined";
    g.updatedAt = now;
    if (!packet.mirrored) notify = { body: ru ? "Приглашение отклонено" : "Invite declined", tag: "game:" + key, peerPrefix: packet.peerPrefix };
    return { changed: true, notify: notify, replies: replies, gameKey: key };
  } else if (decoded.op === OP_MOVE) {
    var expectedPly = g.moves.length + 1;
    if (decoded.ply <= g.moves.length) {
      // Idempotent duplicate retry
      return { changed: false, notify: null, replies: [] };
    }
    if (decoded.ply > expectedPly) {
      replies.push({ peerPrefix: packet.peerPrefix, payload: Array.from(encodeSyncReq(gid, g.moves.length)), retry: true });
      return { changed: false, notify: null, replies: replies, gameKey: key };
    }
    var candidate = g.moves.concat([decoded.moveBits]);
    var rep = replayMoves(candidate);
    if (!rep || posHash8(rep.pos) !== decoded.hash8) {
      replies.push({ peerPrefix: packet.peerPrefix, payload: Array.from(encodeSyncReq(gid, 0)), retry: true });
      return { changed: false, notify: null, replies: replies, gameKey: key };
    }
    g.moves = candidate;
    g.status = rep.outcome ? "finished" : "active";
    if (rep.outcome) g.winner = rep.outcome === "white" ? "w" : rep.outcome === "black" ? "b" : "draw";
    var u = unpackMove(decoded.moveBits);
    g.drawOfferedBy = u.offerDraw ? (packet.mirrored ? g.myColor : (g.myColor === "w" ? "b" : "w")) : null;
    g.updatedAt = now;
    var label = rep.labels[rep.labels.length - 1] || "";
    if (!packet.mirrored) {
      notify = {
        body: (ru ? "Ваш ход: " : "Your turn: ") + label,
        tag: "game:" + key,
        peerPrefix: packet.peerPrefix
      };
    }
    return { changed: true, notify: notify, replies: replies, gameKey: key };
  } else if (decoded.op === OP_ACTION) {
    if (decoded.action === ACT_RESIGN) {
      g.status = "finished";
      g.winner = packet.mirrored ? (g.myColor === "w" ? "b" : "w") : g.myColor;
      g.updatedAt = now;
      if (!packet.mirrored) notify = { body: ru ? "Соперник сдался — вы победили!" : "Opponent resigned — you win!", tag: "game:" + key, peerPrefix: packet.peerPrefix };
      return { changed: true, notify: notify, replies: replies, gameKey: key };
    } else if (decoded.action === ACT_DRAW_OFFER) {
      g.drawOfferedBy = packet.mirrored ? g.myColor : (g.myColor === "w" ? "b" : "w");
      g.updatedAt = now;
      if (!packet.mirrored) notify = { body: ru ? "Предложена ничья" : "Draw offered", tag: "game:" + key, peerPrefix: packet.peerPrefix };
      return { changed: true, notify: notify, replies: replies, gameKey: key };
    } else if (decoded.action === ACT_DRAW_ACCEPT) {
      g.status = "finished";
      g.winner = "draw";
      g.drawOfferedBy = null;
      g.updatedAt = now;
      if (!packet.mirrored) notify = { body: ru ? "Партия завершена вничью" : "Game drawn", tag: "game:" + key, peerPrefix: packet.peerPrefix };
      return { changed: true, notify: notify, replies: replies, gameKey: key };
    } else if (decoded.action === ACT_DRAW_DECLINE) {
      g.drawOfferedBy = null;
      g.updatedAt = now;
      return { changed: true, notify: null, replies: replies, gameKey: key };
    }
  } else if (decoded.op === OP_SYNC_REQ) {
    if (decoded.fromPly < g.moves.length) {
      var slice = g.moves.slice(decoded.fromPly);
      replies.push({ peerPrefix: packet.peerPrefix, payload: Array.from(encodeSyncMoves(gid, decoded.fromPly, slice)), retry: true });
    }
    return { changed: false, notify: null, replies: replies, gameKey: key };
  } else if (decoded.op === OP_SYNC_MOVES) {
    var base = g.moves.slice(0, decoded.fromPly);
    var merged = base.concat(decoded.moves);
    var repSync = replayMoves(merged);
    if (repSync && merged.length >= g.moves.length) {
      g.moves = merged;
      g.status = repSync.outcome ? "finished" : "active";
      if (repSync.outcome) g.winner = repSync.outcome === "white" ? "w" : repSync.outcome === "black" ? "b" : "draw";
      g.updatedAt = now;
      return { changed: true, notify: null, replies: replies, gameKey: key };
    }
  } else if (decoded.op === OP_CHAT) {
    if (!Array.isArray(g.chat)) g.chat = [];
    var fromSide = packet.mirrored ? "me" : "opp";
    var ts = packet.timestamp || Math.floor(now / 1000);
    var dup = g.chat.some(function (m) {
      return m.from === fromSide && m.text === decoded.text && Math.abs((m.ts || 0) - ts) <= 5;
    });
    if (dup) return { changed: false, notify: null, replies: [] };
    g.chat.push({
      id: "m:" + ts + ":" + Math.random().toString(36).slice(2, 7),
      from: fromSide,
      text: decoded.text,
      at: now,
      ts: ts,
      status: "delivered"
    });
    if (g.chat.length > 80) g.chat = g.chat.slice(-80);
    g.updatedAt = now;
    if (!packet.mirrored) {
      g.unreadChat = (g.unreadChat || 0) + 1;
      notify = { body: decoded.text, tag: "game:" + key, peerPrefix: packet.peerPrefix };
    }
    return { changed: true, notify: notify, replies: replies, gameKey: key, isChat: true };
  }
  return { changed: false, notify: null, replies: replies };
}
`;

const WORKER_JS = `
${CHESS_ENGINE_JS}
self.onPacket = function (input) {
  var games = (input.storage && input.storage.games && typeof input.storage.games === "object")
    ? JSON.parse(JSON.stringify(input.storage.games))
    : {};
  var res = applyIncomingPacket(games, input.packet, input.locale || "ru");
  var out = {};
  if (res.changed) {
    out.storageSet = { games: games };
    out.activities = buildActivities(games, input.locale || "ru");
  }
  if (res.notify) out.notify = res.notify;
  if (res.replies && res.replies.length) out.send = res.replies;
  return out;
};
`;

const HTML = `
<style>
  :root {
    --sq-light: color-mix(in oklab, var(--elevated) 92%, var(--bg));
    --sq-dark: color-mix(in oklab, var(--accent) 28%, var(--panel));
    --coord-on-light: color-mix(in oklab, var(--text) 52%, transparent);
    --coord-on-dark: color-mix(in oklab, var(--text) 72%, transparent);
    --piece-w-fill: #ffffff;
    --piece-w-stroke: #1b2029;
    --piece-b-fill: #1f2430;
    --piece-b-stroke: #101319;
    --piece-b-detail: #e2e7f0;
    --piece-shadow: drop-shadow(0 1.5px 1.5px rgba(0, 0, 0, 0.28));
  }
  :root[data-appearance="dark"] {
    --sq-light: color-mix(in oklab, var(--text) 24%, var(--panel));
    --sq-dark: color-mix(in oklab, var(--accent) 16%, var(--bg));
    --coord-on-light: color-mix(in oklab, var(--bg) 80%, var(--text));
    --coord-on-dark: color-mix(in oklab, var(--text) 62%, transparent);
    --piece-w-fill: color-mix(in oklab, var(--text) 35%, #ffffff);
    --piece-w-stroke: #14171f;
    --piece-b-fill: color-mix(in oklab, var(--bg) 55%, #12151d);
    --piece-b-stroke: color-mix(in oklab, var(--text) 62%, transparent);
    --piece-b-detail: color-mix(in oklab, var(--text) 82%, transparent);
    --piece-shadow: drop-shadow(0 2px 2px rgba(0, 0, 0, 0.48));
  }
  :root[data-look="lcd"] {
    --sq-light: var(--bg);
    --sq-dark: color-mix(in oklab, var(--text) 24%, var(--bg));
    --coord-on-light: var(--text);
    --coord-on-dark: var(--text);
    --piece-w-fill: var(--bg);
    --piece-w-stroke: var(--text);
    --piece-b-fill: var(--text);
    --piece-b-stroke: var(--text);
    --piece-b-detail: var(--bg);
    --piece-shadow: none;
  }
  :root[data-look="classic"] {
    --sq-light: var(--elevated);
    --sq-dark: color-mix(in oklab, var(--accent) 28%, var(--panel));
    --coord-on-light: var(--text-muted);
    --coord-on-dark: var(--text);
    --piece-shadow: none;
  }

  .layout { display: grid; grid-template-columns: minmax(0, 1fr) 312px; gap: 20px; max-width: 960px; margin: 0 auto; padding: 16px; min-height: 100%; align-items: start; }
  @media (max-width: 760px) { .layout { grid-template-columns: 1fr; padding: 12px; gap: 14px; } }
  .board-col { display: flex; flex-direction: column; gap: 10px; align-items: center; }
  .bar { width: 100%; max-width: 448px; display: flex; justify-content: space-between; align-items: center; font-size: 13px; color: var(--text-muted); }
  .bar strong { color: var(--text); font-weight: 600; }
  .bar .turn { color: var(--accent); font-weight: 700; }

  .board {
    width: 100%;
    max-width: 448px;
    aspect-ratio: 1 / 1;
    display: grid;
    grid-template-columns: repeat(8, minmax(0, 1fr));
    grid-template-rows: repeat(8, minmax(0, 1fr));
    border-radius: 10px;
    overflow: hidden;
    border: 1.5px solid var(--border-strong);
    box-shadow: 0 4px 18px color-mix(in srgb, var(--bg) 45%, rgba(0, 0, 0, 0.25));
    user-select: none;
    touch-action: manipulation;
  }
  :root[data-look="lcd"] .board {
    border: 2px solid var(--text);
    box-shadow: none;
  }
  :root[data-look="classic"] .board {
    border: 2px solid;
    border-color: var(--border-strong) var(--elevated) var(--elevated) var(--border-strong);
    box-shadow: inset 1px 1px 0 var(--border);
  }

  .sq {
    position: relative;
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    border: 0;
    padding: 0;
    margin: 0;
    line-height: 1;
    appearance: none;
  }
  .sq.light { background: var(--sq-light); }
  .sq.dark { background: var(--sq-dark); }
  .sq.last { box-shadow: inset 0 0 0 99px color-mix(in oklab, var(--success) 30%, transparent); }
  .sq.sel { box-shadow: inset 0 0 0 99px color-mix(in oklab, var(--accent) 42%, transparent); }
  .sq.chk { background-image: radial-gradient(circle, color-mix(in oklab, var(--danger) 82%, transparent) 0%, color-mix(in oklab, var(--danger) 45%, transparent) 55%, transparent 82%); }

  .piece-svg {
    width: 82%;
    height: 82%;
    display: block;
    pointer-events: none;
    filter: var(--piece-shadow);
    transition: transform 110ms ease;
  }
  .sq.sel .piece-svg { transform: translateY(-1.5px) scale(1.06); }
  .piece-svg.pw .p-fill { fill: var(--piece-w-fill); }
  .piece-svg.pw .p-stroke { stroke: var(--piece-w-stroke); }
  .piece-svg.pw .p-detail { stroke: var(--piece-w-stroke); fill: none; }
  .piece-svg.pb .p-fill { fill: var(--piece-b-fill); }
  .piece-svg.pb .p-stroke { stroke: var(--piece-b-stroke); }
  .piece-svg.pb .p-detail { stroke: var(--piece-b-detail); fill: none; }
  .piece-svg.pb .p-dot { fill: var(--piece-b-detail); }
  .piece-svg.pw .p-dot { fill: var(--piece-w-stroke); }

  .dot { position: absolute; width: 28%; height: 28%; border-radius: 50%; background: color-mix(in oklab, var(--accent) 80%, var(--text)); opacity: 0.72; pointer-events: none; }
  .ring { position: absolute; inset: 6%; border-radius: 50%; border: 3.5px solid color-mix(in oklab, var(--accent) 85%, var(--text)); opacity: 0.88; pointer-events: none; }
  .coord { position: absolute; font-size: 10px; font-weight: 600; pointer-events: none; line-height: 1; }
  .sq.light .coord { color: var(--coord-on-light); }
  .sq.dark .coord { color: var(--coord-on-dark); }
  .coord.file { right: 3px; bottom: 2px; }
  .coord.rank { left: 3px; top: 2px; }

  .status-pill { width: 100%; max-width: 448px; background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 9px 12px; font-size: 12px; color: var(--text-muted); display: flex; justify-content: space-between; align-items: center; gap: 8px; }
  .status-pill.ok { border-color: color-mix(in oklab, var(--success) 55%, var(--border)); color: var(--success); }
  .status-pill.warn { border-color: color-mix(in oklab, var(--warning) 55%, var(--border)); color: var(--warning); }
  .status-pill.err { border-color: color-mix(in oklab, var(--danger) 55%, var(--border)); color: var(--danger); }

  .actions { width: 100%; max-width: 448px; display: flex; gap: 8px; flex-wrap: wrap; }
  .btn { flex: 1; min-width: 90px; padding: 9px 12px; border-radius: 9px; border: 1px solid var(--border-strong); background: var(--panel); color: var(--text); font: inherit; font-size: 12.5px; font-weight: 600; cursor: pointer; }
  .btn:hover { background: var(--hover); }
  .btn.primary { background: var(--accent); color: var(--accent-contrast); border-color: transparent; }
  .btn.primary:hover { filter: brightness(1.06); }
  .btn.danger { color: var(--danger); border-color: color-mix(in oklab, var(--danger) 45%, var(--border)); }
  .btn:disabled { opacity: 0.45; cursor: default; }
  :root[data-look="classic"] .btn {
    border: 2px solid;
    border-color: var(--elevated) var(--border-strong) var(--border-strong) var(--elevated);
    box-shadow: inset -1px -1px 0 var(--border);
  }
  :root[data-look="classic"] .btn:active:not(:disabled) {
    border-color: var(--border-strong) var(--elevated) var(--elevated) var(--border-strong);
    box-shadow: inset 1px 1px 0 var(--border);
  }
  :root[data-look="lcd"] .btn { border: 2px solid var(--text); }

  .side {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 14px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    min-width: 0;
  }
  :root[data-look="lcd"] .side { border: 2px solid var(--border-strong); }
  .side-section { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
  .side-divider { height: 1px; background: var(--border); margin: 0 -14px; }
  .side-head { display: flex; justify-content: space-between; align-items: center; gap: 10px; }
  .side-title {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin: 0;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--text-muted);
  }
  .side-count {
    font-size: 10.5px;
    font-weight: 600;
    padding: 1px 6px;
    border-radius: 99px;
    background: color-mix(in oklab, var(--text) 9%, transparent);
    color: var(--text-muted);
    letter-spacing: 0;
  }
  .btn-new {
    flex: none;
    white-space: nowrap;
    height: 28px;
    padding: 0 11px;
    border-radius: 8px;
    border: 0;
    background: var(--accent);
    color: var(--accent-contrast);
    font: inherit;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }
  .btn-new:hover { filter: brightness(1.07); }
  :root[data-look="classic"] .btn-new {
    border: 2px solid;
    border-color: var(--elevated) var(--border-strong) var(--border-strong) var(--elevated);
  }
  :root[data-look="lcd"] .btn-new { border: 2px solid var(--text); }

  .games {
    display: flex;
    flex-direction: column;
    gap: 6px;
    max-height: 252px;
    overflow-y: auto;
    padding: 1px;
  }
  .games-empty {
    padding: 14px 10px;
    text-align: center;
    font-size: 12px;
    color: var(--text-faint);
    border: 1px dashed var(--border);
    border-radius: 8px;
  }
  .g-row {
    position: relative;
    text-align: left;
    width: 100%;
    padding: 9px 10px;
    border-radius: 9px;
    border: 1px solid var(--border);
    background: color-mix(in oklab, var(--bg) 72%, var(--panel));
    color: var(--text);
    cursor: pointer;
    display: flex;
    flex-direction: column;
    gap: 5px;
    font: inherit;
    transition: background 100ms ease, border-color 100ms ease;
  }
  .g-row:hover {
    background: var(--hover);
    border-color: var(--border-strong);
  }
  .g-row.on {
    border-color: var(--accent);
    background: color-mix(in oklab, var(--accent) 13%, var(--bg));
    box-shadow: inset 3px 0 0 var(--accent);
  }
  .g-row .top { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-width: 0; }
  .g-row .peer-wrap { display: inline-flex; align-items: center; gap: 6px; min-width: 0; flex: 1; }
  .g-row .peer-name { font-size: 13px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .side-dot { width: 9px; height: 9px; border-radius: 50%; flex: none; border: 1.5px solid var(--piece-w-stroke); }
  .side-dot.w { background: var(--piece-w-fill); }
  .side-dot.b { background: var(--piece-b-fill); border-color: var(--piece-b-detail); }
  .g-row .bot { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-width: 0; }
  .g-row .sub { font-size: 11.5px; color: var(--text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .g-row .gid { font-family: ui-monospace, Consolas, monospace; font-size: 10.5px; color: var(--text-faint); flex: none; }
  .g-row .top-right { display: inline-flex; align-items: center; gap: 4px; flex: none; }
  .g-del {
    width: 18px;
    height: 18px;
    border-radius: 5px;
    border: 0;
    background: transparent;
    color: var(--text-faint);
    font-size: 13px;
    line-height: 1;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0;
  }
  .g-del:hover { background: color-mix(in oklab, var(--danger) 18%, transparent); color: var(--danger); }

  .badge { font-size: 10.5px; font-weight: 600; padding: 2px 7px; border-radius: 99px; white-space: nowrap; line-height: 1.25; }
  .badge.success { background: color-mix(in oklab, var(--success) 20%, transparent); color: var(--success); }
  .badge.accent { background: color-mix(in oklab, var(--accent) 20%, transparent); color: var(--accent); }
  .badge.neutral { background: color-mix(in oklab, var(--text) 10%, transparent); color: var(--text-muted); }
  .badge.danger { background: color-mix(in oklab, var(--danger) 20%, transparent); color: var(--danger); }

  .moves {
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 9px;
    padding: 4px 0;
    font-family: ui-monospace, "Cascadia Mono", Consolas, monospace;
    font-size: 12px;
    max-height: 210px;
    overflow-y: auto;
  }
  .moves-empty {
    padding: 16px 10px;
    text-align: center;
    font-family: inherit;
    font-size: 12px;
    color: var(--text-faint);
  }
  .move-row {
    display: grid;
    grid-template-columns: 34px minmax(0, 1fr) minmax(0, 1fr);
    align-items: center;
    padding: 3px 8px 3px 4px;
    gap: 4px;
  }
  .move-row:nth-child(even) {
    background: color-mix(in oklab, var(--text) 3.5%, transparent);
  }
  .move-num {
    text-align: right;
    padding-right: 6px;
    color: var(--text-faint);
    font-size: 11px;
    user-select: none;
  }
  .move-ply {
    padding: 2px 6px;
    border-radius: 5px;
    color: var(--text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .move-ply.latest {
    background: color-mix(in oklab, var(--accent) 18%, transparent);
    color: var(--accent);
    font-weight: 700;
  }

  .seg-tabs {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 4px;
    padding: 3px;
    border-radius: 9px;
    background: var(--bg);
    border: 1px solid var(--border);
  }
  .seg-tab {
    height: 28px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--text-muted);
    font: inherit;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 0 8px;
  }
  .seg-tab:hover { color: var(--text); }
  .seg-tab.on {
    background: var(--panel);
    color: var(--text);
    box-shadow: 0 1px 2px color-mix(in srgb, var(--bg) 45%, rgba(0, 0, 0, 0.2));
  }
  :root[data-look="lcd"] .seg-tab.on {
    background: var(--text);
    color: var(--bg);
    box-shadow: none;
  }
  .seg-pill {
    font-size: 10px;
    font-weight: 700;
    padding: 1px 5px;
    border-radius: 99px;
    background: color-mix(in oklab, var(--text) 10%, transparent);
    color: var(--text-muted);
    line-height: 1.2;
  }
  .seg-pill.hot {
    background: var(--accent);
    color: var(--accent-contrast);
  }
  :root[data-look="lcd"] .seg-tab.on .seg-pill {
    background: var(--bg);
    color: var(--text);
  }

  .chat-pane { display: flex; flex-direction: column; gap: 8px; }
  .chat-list {
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 9px;
    padding: 8px;
    height: 196px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .chat-msg {
    max-width: 86%;
    padding: 6px 9px;
    border-radius: 10px;
    font-size: 12.5px;
    line-height: 1.38;
    word-break: break-word;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .chat-msg.in {
    align-self: flex-start;
    background: var(--bubble-in, var(--panel));
    color: var(--bubble-text, var(--text));
    border: 1px solid var(--border);
    border-bottom-left-radius: 3px;
  }
  .chat-msg.out {
    align-self: flex-end;
    background: var(--bubble-out, color-mix(in oklab, var(--accent) 22%, var(--panel)));
    color: var(--bubble-text, var(--text));
    border: 1px solid color-mix(in oklab, var(--accent) 26%, var(--border));
    border-bottom-right-radius: 3px;
  }
  :root[data-look="lcd"] .chat-msg { border: 1.5px solid var(--text); }
  .chat-meta {
    display: inline-flex;
    align-items: center;
    justify-content: flex-end;
    gap: 4px;
    font-size: 10px;
    color: var(--bubble-text-muted, var(--text-faint));
    line-height: 1;
  }
  .chat-meta .st-ok { color: var(--success); font-weight: 700; }
  .chat-meta .st-err { color: var(--danger); font-weight: 700; }
  .quick-row {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }
  .quick-chip {
    border: 1px solid var(--border);
    background: var(--bg);
    color: var(--text-muted);
    border-radius: 99px;
    padding: 3px 8px;
    font: inherit;
    font-size: 11px;
    cursor: pointer;
    white-space: nowrap;
  }
  .quick-chip:hover { background: var(--hover); color: var(--text); border-color: var(--border-strong); }
  .quick-chip:disabled { opacity: 0.45; cursor: default; }
  .chat-form {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .chat-input {
    flex: 1;
    min-width: 0;
    height: 32px;
    padding: 0 10px;
    border-radius: 8px;
    border: 1px solid var(--border-strong);
    background: var(--bg);
    color: var(--text);
    font: inherit;
    font-size: 12.5px;
    outline: none;
  }
  .chat-input:focus { border-color: var(--accent); }
  .chat-input:disabled { opacity: 0.45; }
  .chat-send {
    flex: none;
    height: 32px;
    padding: 0 11px;
    border-radius: 8px;
    border: 0;
    background: var(--accent);
    color: var(--accent-contrast);
    font: inherit;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
  }
  .chat-send:disabled { opacity: 0.45; cursor: default; }
  .chat-bytes { font-size: 10.5px; color: var(--text-faint); text-align: right; }
  .chat-bytes.warn { color: var(--warning); }
  .hidden { display: none !important; }
  .empty { width: 100%; max-width: 448px; padding: 28px 18px; text-align: center; background: var(--panel); border: 1px dashed var(--border-strong); border-radius: 14px; display: flex; flex-direction: column; align-items: center; gap: 10px; }
  .empty p { margin: 0; color: var(--text-muted); font-size: 13px; line-height: 1.45; }
  .empty-icon { width: 56px; height: 56px; display: flex; align-items: center; justify-content: center; }
  .promo-bar { width: 100%; max-width: 448px; background: var(--chrome); border: 1px solid var(--accent); border-radius: 10px; padding: 8px 10px; display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .promo-bar .promo-btns { display: flex; gap: 6px; }
  .promo-bar button { width: 42px; height: 42px; display: inline-flex; align-items: center; justify-content: center; background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 4px; cursor: pointer; }
  .promo-bar button:hover { background: var(--hover); border-color: var(--accent); }
</style>
<div class="layout">
  <div class="board-col" id="main"></div>
  <aside class="side">
    <div class="side-section">
      <div class="side-head">
        <h3 class="side-title"><span id="hGames">Games</span><span class="side-count" id="cGames">0</span></h3>
        <button class="btn-new" id="newBtn">+ New</button>
      </div>
      <div class="games" id="gamesList"></div>
    </div>
    <div class="side-divider"></div>
    <div class="side-section">
      <div class="seg-tabs" role="tablist">
        <button type="button" class="seg-tab on" id="tabMoves" role="tab" aria-selected="true"><span id="hMoves">Moves</span><span class="seg-pill" id="cMoves">0</span></button>
        <button type="button" class="seg-tab" id="tabChat" role="tab" aria-selected="false"><span id="hChat">Chat</span><span class="seg-pill" id="cChat">0</span></button>
      </div>
      <div class="moves" id="movesBox"></div>
      <div class="chat-pane hidden" id="chatPane">
        <div class="chat-list" id="chatList"></div>
        <div class="quick-row" id="quickRow"></div>
        <div class="chat-form" id="chatForm">
          <input class="chat-input" id="chatInput" type="text" autocomplete="off" />
          <button type="button" class="chat-send" id="chatSend">→</button>
        </div>
        <div class="chat-bytes hidden" id="chatBytes"></div>
      </div>
    </div>
  </aside>
</div>
<script>
${CHESS_ENGINE_JS}
var PIECE_PATHS = {
  p: '<path class="p-fill p-stroke" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" d="M22.5 9c-2.21 0-4 1.79-4 4 0 .89.29 1.71.78 2.38C17.33 16.5 16 18.59 16 21c0 2.03.94 3.84 2.41 5.03-3 1.06-7.41 5.55-7.41 13.47h23c0-7.92-4.41-12.41-7.41-13.47 1.47-1.19 2.41-3 2.41-5.03 0-2.41-1.33-4.5-3.28-5.62.49-.67.78-1.49.78-2.38 0-2.21-1.79-4-4-4z"/>',
  r: '<g class="p-fill p-stroke" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9 39h27v-3H9v3zM12 36v-4h21v4H12zM11 14V9h4v2h5V9h5v2h5V9h4v5"/><path d="M34 14l-3 3H14l-3-3"/><path d="M31 17v12.5H14V17"/><path d="M31 29.5l1.5 2.5h-20l1.5-2.5"/></g><path class="p-detail" stroke-width="1.2" stroke-linecap="round" d="M14 17h17M14 29.5h17M12 36h21"/>',
  n: '<g class="p-fill p-stroke" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M22 10c10.5 1 16.5 8 16 29H15c0-9 10-6.5 8-21"/><path d="M24 18c.38 2.91-5.55 7.37-8 9-3 2-2.82 4.34-5 4-1.042-.94 1.41-3.04 0-3-1 0 .19 1.23-1 2-1 0-4.003 1-4-4 0-2 6-12 6-12s1.89-1.9 2-3.5c-.73-.994-.5-2-.5-3 1-1 3 2.5 3 2.5h2s.78-1.992 2.5-3c1 0 1 3 1 3"/></g><circle class="p-dot" cx="15" cy="15.5" r="1.1"/><path class="p-detail" stroke-width="1.2" stroke-linecap="round" d="M24.5 11.5c5.5 1.8 9.2 7.2 9.5 24"/>',
  b: '<g class="p-fill p-stroke" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9 36c3.39-.97 10.11.43 13.5-2 3.39 2.43 10.11 1.03 13.5 2 0 0 1.65.54 3 2-.68.97-1.65.99-3 .5-3.39-.97-10.11.46-13.5-1-3.39 1.46-10.11.03-13.5 1-1.35.49-2.32.47-3-.5 1.35-1.46 3-2 3-2z"/><path d="M15 32c2.5 2.5 12.5 2.5 15 0 .5-1.5 0-2 0-2 0-2.5-2.5-4-2.5-4 5.5-1.5 6-11.5-5-15.5-11 4-10.5 14-5 15.5 0 0-2.5 1.5-2.5 4 0 0-.5.5 0 2z"/><circle cx="22.5" cy="8" r="2.5"/></g><path class="p-detail" stroke-width="1.4" stroke-linecap="round" d="M17.5 26h10M15 30h15M22.5 15.5v5M20 18h5"/>',
  q: '<g class="p-fill p-stroke" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="12" r="2.4"/><circle cx="14" cy="9" r="2.4"/><circle cx="22.5" cy="8" r="2.4"/><circle cx="31" cy="9" r="2.4"/><circle cx="39" cy="12" r="2.4"/><path d="M9 26c8.5-1.5 21-1.5 27 0l2.5-12.5L31 25l-.3-14.1-5.2 13.6-3-14.5-3 14.5-5.2-13.6L14 25 6.5 13.5 9 26z"/><path d="M9 26c0 2 1.5 2 2.5 4 1 1.5 1 1 .5 3.5-1.5 1-1.5 2.5-1.5 2.5-1.5 1.5.5 2.5.5 2.5 6.5 1 16.5 1 23 0 0 0 1.5-1 0-2.5 0 0 .5-1.5-1-2.5-.5-2.5-.5-2 .5-3.5 1-2 2.5-2 2.5-4-8.5-1.5-18.5-1.5-27 0z"/></g><path class="p-detail" stroke-width="1.3" stroke-linecap="round" d="M11.5 30c3.5-1 18.5-1 22 0M12 33.5c6-1 15-1 21 0M11 38.5a35 35 1 0 0 23 0"/>',
  k: '<g class="p-fill p-stroke" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M22.5 11.63V6M20 8h5" fill="none"/><path d="M22.5 25s4.5-7.5 3-10.5c0 0-1-2.5-3-2.5s-3 2.5-3 2.5c-1.5 3 3 10.5 3 10.5"/><path d="M11.5 37c5.5 3.5 15.5 3.5 21 0v-7s9-4.5 6-10.5c-4-6.5-13.5-3.5-16 4V27v-3.5c-3.5-7.5-13-10.5-16-4-3 6 5 10 5 10V37z"/></g><path class="p-detail" stroke-width="1.3" stroke-linecap="round" d="M11.5 30c5.5-3 15.5-3 21 0M11.5 33.5c5.5-3 15.5-3 21 0M11.5 37c5.5-3 15.5-3 21 0"/>'
};

function pieceSvg(ch) {
  var isW = pieceColor(ch) === "w";
  var body = PIECE_PATHS[ch.toLowerCase()] || "";
  return '<svg class="piece-svg ' + (isW ? "pw" : "pb") + '" viewBox="0 0 45 45" aria-hidden="true">' + body + '</svg>';
}

window.ommeshReady.then(async function (app) {
  var ru = app.context.locale === "ru";
  var T = ru ? {
    games: "Партии", newGame: "+ Новая", moves: "Ходы", chat: "Чат",
    noGames: "Партий пока нет", noMoves: "Ходов пока нет", noChat: "Напишите сопернику — сообщения уйдут по LoRa внутри партии",
    chatPlaceholder: "Сообщение в партию…", chatQuick: ["👋", "👍", "Хороший ход!", "Думаю…"],
    deleteGame: "Убрать из списка",
    emptyTitle: "Нет активных партий",
    emptyDesc: "Выберите собеседника с прошивкой meshcore-rs (MCRS v2) — каждый ход уходит одним AES-блоком (20 Б в эфире) с подтверждением ACK.",
    startBtn: "Выбрать соперника", yourTurn: "Ваш ход", waitTurn: "Ход соперника",
    white: "Белые", black: "Чёрные", you: "Вы", accept: "Принять", decline: "Отклонить",
    draw: "Ничья", acceptDraw: "Принять ничью", declineDraw: "Продолжить",
    sync: "Синхр.", resign: "Сдаться", promote: "Превратить пешку:",
    sending: "Отправка по LoRa…", delivered: "Доставлено ✓", retrying: "Повторная отправка…",
    unconfirmed: "Нет ACK — проверьте, что у соперника meshcore-rs", failed: "Ошибка отправки",
    inviteSent: "Приглашение отправлено", inviteIn: "Приглашает сыграть в шахматы",
    won: "Вы победили!", lost: "Вы проиграли", drawn: "Ничья", noRadio: "Нет поддержки MCRS v2 на радио"
  } : {
    games: "Games", newGame: "+ New", moves: "Moves", chat: "Chat",
    noGames: "No games yet", noMoves: "No moves yet", noChat: "Say hi — messages stay inside this game over LoRa",
    chatPlaceholder: "Message in this game…", chatQuick: ["👋", "👍", "Nice move!", "Thinking…"],
    deleteGame: "Remove from list",
    emptyTitle: "No active games",
    emptyDesc: "Pick a peer running meshcore-rs (MCRS v2) — every move fits in one AES block (20 B on air) with LoRa ACK.",
    startBtn: "Pick opponent", yourTurn: "Your turn", waitTurn: "Opponent's turn",
    white: "White", black: "Black", you: "You", accept: "Accept", decline: "Decline",
    draw: "Offer draw", acceptDraw: "Accept draw", declineDraw: "Decline",
    sync: "Sync", resign: "Resign", promote: "Promote pawn:",
    sending: "Sending over LoRa…", delivered: "Delivered ✓", retrying: "Retrying…",
    unconfirmed: "No ACK — opponent may need meshcore-rs", failed: "Send failed",
    inviteSent: "Invitation sent", inviteIn: "Invited you to play chess",
    won: "You won!", lost: "You lost", drawn: "Draw", noRadio: "Radio lacks MCRS v2 peerData"
  };

  document.getElementById("hGames").textContent = T.games;
  document.getElementById("newBtn").textContent = T.newGame;
  document.getElementById("hMoves").textContent = T.moves;
  document.getElementById("hChat").textContent = T.chat;
  document.getElementById("chatInput").placeholder = T.chatPlaceholder;

  var games = (await app.storage.get("games")) || {};
  var selectedKey = app.context.initialActivityId && games[app.context.initialActivityId]
    ? app.context.initialActivityId
    : (Object.keys(games).find(function (k) { return games[k].status !== "declined"; }) || null);
  var sideTab = "moves";
  var selectedSq = null;
  var pendingPromo = null;
  var deliveryByGame = {};
  var packetToGame = {};
  var packetToChat = {};

  async function persist() {
    await app.storage.set("games", games);
    await app.ui.setActivities(buildActivities(games, app.context.locale));
  }

  async function sendForGame(g, bytes, label) {
    deliveryByGame[g.id] = { tone: "", text: label || T.sending };
    render();
    try {
      var res = await app.transport.send(g.peerPrefix, bytes, { retry: true });
      packetToGame[res.packetId] = g.id;
      deliveryByGame[g.id] = { tone: "", text: (label || T.sending) + " (" + (res.flood ? "flood" : "direct") + ")" };
    } catch (err) {
      deliveryByGame[g.id] = { tone: "err", text: T.failed + ": " + (err && err.message ? err.message : String(err)) };
    }
    render();
  }

  async function startNewGame() {
    var peer = await app.peers.pick({ requirePeerData: true });
    if (!peer) return;
    var gid = Math.floor(Math.random() * 65534) + 1;
    var key = "g:" + gid.toString(16).padStart(4, "0");
    var g = {
      id: key, gameId: gid, peerPrefix: peer.keyPrefix, peerName: peer.name,
      myColor: "w", status: "invited_out", moves: [], drawOfferedBy: null, winner: null, updatedAt: Date.now()
    };
    games[key] = g;
    selectedKey = key;
    selectedSq = null;
    pendingPromo = null;
    await persist();
    await sendForGame(g, encodeInvite(gid, "w"), T.inviteSent);
  }

  document.getElementById("newBtn").addEventListener("click", startNewGame);

  function setSideTab(next) {
    sideTab = next;
    if (sideTab === "chat" && selectedKey && games[selectedKey] && games[selectedKey].unreadChat) {
      games[selectedKey].unreadChat = 0;
      void persist();
    }
    render();
    if (sideTab === "chat") {
      var ci = document.getElementById("chatInput");
      if (ci && !ci.disabled) ci.focus();
    }
  }
  document.getElementById("tabMoves").addEventListener("click", function () { setSideTab("moves"); });
  document.getElementById("tabChat").addEventListener("click", function () { setSideTab("chat"); });

  async function sendChatText(raw) {
    var g = selectedKey ? games[selectedKey] : null;
    var text = String(raw || "").trim();
    if (!g || g.status === "declined" || !text) return;
    var pktBytes = encodeChatPkt(g.gameId, text);
    var actualText = new TextDecoder().decode(pktBytes.subarray(3));
    if (!actualText) return;
    if (!Array.isArray(g.chat)) g.chat = [];
    var now = Date.now();
    var msgId = "m:" + now + ":" + Math.random().toString(36).slice(2, 7);
    var msg = { id: msgId, from: "me", text: actualText, at: now, ts: Math.floor(now / 1000), status: "sending" };
    g.chat.push(msg);
    if (g.chat.length > 80) g.chat = g.chat.slice(-80);
    g.updatedAt = now;
    g.unreadChat = 0;
    await persist();
    render();
    try {
      var res = await app.transport.send(g.peerPrefix, pktBytes, { retry: true });
      packetToChat[res.packetId] = { gameKey: g.id, msgId: msgId };
      packetToGame[res.packetId] = g.id;
    } catch (err) {
      msg.status = "failed";
      await persist();
      render();
    }
  }

  var chatInputEl = document.getElementById("chatInput");
  var chatBytesEl = document.getElementById("chatBytes");
  function updateBytesHint() {
    var used = new TextEncoder().encode(chatInputEl.value.trim()).length;
    var left = MAX_CHAT_UTF8 - used;
    if (used > 0 && left <= 40) {
      chatBytesEl.classList.remove("hidden");
      chatBytesEl.classList.toggle("warn", left <= 12);
      chatBytesEl.textContent = left >= 0 ? (used + " / " + MAX_CHAT_UTF8 + " B") : (MAX_CHAT_UTF8 + " / " + MAX_CHAT_UTF8 + " B");
    } else {
      chatBytesEl.classList.add("hidden");
    }
  }
  chatInputEl.addEventListener("input", updateBytesHint);
  function submitChatInput() {
    var val = chatInputEl.value;
    if (!val.trim()) return;
    chatInputEl.value = "";
    updateBytesHint();
    void sendChatText(val);
  }
  document.getElementById("chatSend").addEventListener("click", submitChatInput);
  chatInputEl.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submitChatInput();
    }
  });

  var quickRowEl = document.getElementById("quickRow");
  T.chatQuick.forEach(function (phrase) {
    var qb = document.createElement("button");
    qb.type = "button";
    qb.className = "quick-chip";
    qb.textContent = phrase;
    qb.onclick = function () { void sendChatText(phrase); };
    quickRowEl.appendChild(qb);
  });

  app.ui.onOpenActivity(function (actId) {
    if (games[actId]) {
      selectedKey = actId;
      selectedSq = null;
      pendingPromo = null;
      if (sideTab === "chat" && games[actId].unreadChat) {
        games[actId].unreadChat = 0;
        void persist();
      }
      render();
    }
  });

  app.transport.onDelivery(function (ev) {
    var chatRef = packetToChat[ev.packetId];
    if (chatRef && games[chatRef.gameKey] && Array.isArray(games[chatRef.gameKey].chat)) {
      var found = games[chatRef.gameKey].chat.find(function (m) { return m.id === chatRef.msgId; });
      if (found) {
        if (ev.status === "delivered") { found.status = "delivered"; void persist(); }
        else if (ev.status === "failed" || ev.status === "unconfirmed") { found.status = "failed"; void persist(); }
      }
    }
    var gk = packetToGame[ev.packetId];
    if (!gk) return;
    if (ev.status === "delivered") {
      var rtt = ev.rttMs ? " (" + (ev.rttMs / 1000).toFixed(1) + (ru ? "с" : "s") + ")" : "";
      deliveryByGame[gk] = { tone: "ok", text: T.delivered + rtt + " • LoRa" };
    } else if (ev.status === "retrying") {
      deliveryByGame[gk] = { tone: "warn", text: T.retrying + " #" + (ev.attempt + 1) };
    } else if (ev.status === "unconfirmed") {
      deliveryByGame[gk] = { tone: "warn", text: T.unconfirmed };
    } else if (ev.status === "failed") {
      deliveryByGame[gk] = { tone: "err", text: T.failed + (ev.error ? ": " + ev.error : "") };
    }
    render();
  });

  app.transport.onPacket(async function (pkt) {
    var res = applyIncomingPacket(games, pkt, app.context.locale);
    if (res.changed) {
      if (!selectedKey && res.gameKey) selectedKey = res.gameKey;
      if (res.isChat && res.gameKey === selectedKey && sideTab === "chat" && games[res.gameKey]) {
        games[res.gameKey].unreadChat = 0;
      }
      await persist();
      if (res.notify && !(res.isChat && res.gameKey === selectedKey && sideTab === "chat")) {
        void app.ui.notify(res.notify);
      }
      render();
    }
    if (res.replies && res.replies.length) {
      for (var i = 0; i < res.replies.length; i++) {
        var r = res.replies[i];
        void app.transport.send(r.peerPrefix, new Uint8Array(r.payload), { retry: true }).catch(function () {});
      }
    }
  });

  async function commitMove(g, move) {
    var candidate = g.moves.concat([packMove(move.from, move.to, move.promo, false)]);
    var rep = replayMoves(candidate);
    if (!rep) return;
    g.moves = candidate;
    g.drawOfferedBy = null;
    if (rep.outcome) {
      g.status = "finished";
      g.winner = rep.outcome === "white" ? "w" : rep.outcome === "black" ? "b" : "draw";
    }
    g.updatedAt = Date.now();
    selectedSq = null;
    pendingPromo = null;
    await persist();
    var pkt = encodeMovePkt(g.gameId, g.moves.length, g.moves[g.moves.length - 1], posHash8(rep.pos));
    await sendForGame(g, pkt, T.sending);
  }

  function fmtTime(ms) {
    var d = new Date(ms || Date.now());
    return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  }

  function renderSideTabs(g, movePairs) {
    var tabMoves = document.getElementById("tabMoves");
    var tabChat = document.getElementById("tabChat");
    var movesBox = document.getElementById("movesBox");
    var chatPane = document.getElementById("chatPane");
    var cMovesEl = document.getElementById("cMoves");
    var cChatEl = document.getElementById("cChat");
    var chatList = document.getElementById("chatList");
    var chatSend = document.getElementById("chatSend");

    tabMoves.classList.toggle("on", sideTab === "moves");
    tabMoves.setAttribute("aria-selected", String(sideTab === "moves"));
    tabChat.classList.toggle("on", sideTab === "chat");
    tabChat.setAttribute("aria-selected", String(sideTab === "chat"));
    movesBox.classList.toggle("hidden", sideTab !== "moves");
    chatPane.classList.toggle("hidden", sideTab !== "chat");

    cMovesEl.textContent = String(movePairs);
    var msgs = (g && Array.isArray(g.chat)) ? g.chat : [];
    var unread = (g && g.unreadChat) || 0;
    cChatEl.textContent = String(unread > 0 ? unread : msgs.length);
    cChatEl.classList.toggle("hot", unread > 0);

    var canChat = !!g && g.status !== "declined";
    chatInputEl.disabled = !canChat;
    chatSend.disabled = !canChat;
    var qChips = quickRowEl.querySelectorAll("button");
    for (var q = 0; q < qChips.length; q++) qChips[q].disabled = !canChat;

    if (sideTab === "chat") {
      if (msgs.length === 0) {
        chatList.innerHTML = '<div class="moves-empty">' + esc(T.noChat) + '</div>';
      } else {
        var html = "";
        for (var i = 0; i < msgs.length; i++) {
          var m = msgs[i];
          var cls = m.from === "me" ? "out" : "in";
          var st = "";
          if (m.from === "me") {
            if (m.status === "delivered") st = '<span class="st-ok">✓</span>';
            else if (m.status === "failed") st = '<span class="st-err">!</span>';
            else st = '<span>…</span>';
          }
          html += '<div class="chat-msg ' + cls + '"><span>' + esc(m.text) + '</span><span class="chat-meta"><span>' + fmtTime(m.at) + '</span>' + st + '</span></div>';
        }
        chatList.innerHTML = html;
        chatList.scrollTop = chatList.scrollHeight;
      }
    }
  }

  function render() {
    var listEl = document.getElementById("gamesList");
    var movesEl = document.getElementById("movesBox");
    var cGamesEl = document.getElementById("cGames");
    var mainEl = document.getElementById("main");
    var acts = buildActivities(games, app.context.locale);
    cGamesEl.textContent = String(acts.length);

    listEl.innerHTML = "";
    if (acts.length === 0) {
      listEl.innerHTML = '<div class="games-empty">' + esc(T.noGames) + '</div>';
    } else {
      acts.forEach(function (a) {
        var gm = games[a.id];
        var row = document.createElement("div");
        row.className = "g-row" + (a.id === selectedKey ? " on" : "");
        row.setAttribute("role", "button");
        row.tabIndex = 0;
        var gidHex = gm ? "#" + gm.gameId.toString(16).padStart(4, "0") : "";
        var colorCls = gm && gm.myColor === "b" ? "b" : "w";
        var canDel = gm && (gm.status === "finished" || gm.status === "invited_out");
        var unreadDot = (gm && gm.unreadChat > 0) ? '<span class="seg-pill hot">💬 ' + gm.unreadChat + '</span>' : '';
        row.innerHTML =
          '<div class="top">' +
            '<span class="peer-wrap"><span class="side-dot ' + colorCls + '"></span><span class="peer-name">' + esc(a.title) + '</span></span>' +
            '<span class="top-right">' +
              unreadDot +
              (a.badge ? '<span class="badge ' + a.badge.tone + '">' + esc(a.badge.text) + '</span>' : '') +
              (canDel ? '<button type="button" class="g-del" title="' + esc(T.deleteGame) + '">×</button>' : '') +
            '</span>' +
          '</div>' +
          '<div class="bot"><span class="sub">' + esc(a.subtitle) + '</span><span class="gid">' + esc(gidHex) + '</span></div>';
        row.onclick = function () {
          selectedKey = a.id; selectedSq = null; pendingPromo = null;
          if (sideTab === "chat" && gm && gm.unreadChat) { gm.unreadChat = 0; void persist(); }
          render();
        };
        row.onkeydown = function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); row.click(); } };
        var delBtn = row.querySelector(".g-del");
        if (delBtn) {
          delBtn.onclick = async function (e) {
            e.stopPropagation();
            delete games[a.id];
            if (selectedKey === a.id) {
              selectedKey = Object.keys(games).find(function (k) { return games[k].status !== "declined"; }) || null;
            }
            await persist();
            render();
          };
        }
        listEl.appendChild(row);
      });
    }

    var g = selectedKey ? games[selectedKey] : null;
    if (!g || g.status === "declined") {
      movesEl.innerHTML = '<div class="moves-empty">' + esc(T.noMoves) + '</div>';
      renderSideTabs(null, 0);
      mainEl.innerHTML = '<div class="empty"><div class="empty-icon">' + pieceSvg("N") + '</div><strong>' + esc(T.emptyTitle) +
        '</strong><p>' + esc(T.emptyDesc) + '</p><button class="btn primary" id="emptyStart">' + esc(T.startBtn) + '</button></div>';
      document.getElementById("emptyStart").onclick = startNewGame;
      return;
    }

    var rep = replayMoves(g.moves) || { pos: initialState(), labels: [], legal: [], check: false, outcome: null };
    if (rep.labels.length === 0) {
      movesEl.innerHTML = '<div class="moves-empty">' + esc(T.noMoves) + '</div>';
    } else {
      var rowsHtml = "";
      var lastIdx = rep.labels.length - 1;
      for (var i = 0; i < rep.labels.length; i += 2) {
        var wMove = rep.labels[i] || "";
        var bMove = rep.labels[i + 1] || "";
        rowsHtml +=
          '<div class="move-row">' +
            '<span class="move-num">' + (Math.floor(i / 2) + 1) + '.</span>' +
            '<span class="move-ply' + (i === lastIdx ? " latest" : "") + '">' + esc(wMove) + '</span>' +
            '<span class="move-ply' + (i + 1 === lastIdx ? " latest" : "") + '">' + esc(bMove) + '</span>' +
          '</div>';
      }
      movesEl.innerHTML = rowsHtml;
      movesEl.scrollTop = movesEl.scrollHeight;
    }
    renderSideTabs(g, Math.ceil(rep.labels.length / 2));

    mainEl.innerHTML = "";
    var oppColor = g.myColor === "w" ? "b" : "w";
    var oppBar = document.createElement("div");
    oppBar.className = "bar";
    oppBar.innerHTML = '<strong>' + esc(g.peerName) + ' (' + (oppColor === "w" ? T.white : T.black) + ')</strong><span>#' + g.gameId.toString(16).padStart(4, "0") + '</span>';
    mainEl.appendChild(oppBar);

    if (g.status === "invited_in") {
      var inv = document.createElement("div");
      inv.className = "status-pill ok";
      inv.innerHTML = '<span>' + esc(g.peerName + ": " + T.inviteIn) + '</span>';
      mainEl.appendChild(inv);
      var invBtns = document.createElement("div");
      invBtns.className = "actions";
      var acc = document.createElement("button");
      acc.className = "btn primary"; acc.textContent = T.accept;
      acc.onclick = async function () {
        g.status = "active"; g.updatedAt = Date.now();
        await persist();
        await sendForGame(g, encodeAccept(g.gameId, g.myColor), T.accept);
      };
      var dec = document.createElement("button");
      dec.className = "btn danger"; dec.textContent = T.decline;
      dec.onclick = async function () {
        g.status = "declined"; g.updatedAt = Date.now();
        await persist();
        await sendForGame(g, encodeDecline(g.gameId), T.decline);
      };
      invBtns.appendChild(acc); invBtns.appendChild(dec);
      mainEl.appendChild(invBtns);
    }

    // Chessboard
    var boardEl = document.createElement("div");
    boardEl.className = "board";
    var flip = g.myColor === "b";
    var myTurn = g.status === "active" && rep.pos.turn === g.myColor;
    var lastUnpacked = g.moves.length ? unpackMove(g.moves[g.moves.length - 1]) : null;
    var targets = selectedSq !== null ? rep.legal.filter(function (m) { return m.from === selectedSq; }) : [];
    var checkKing = rep.check ? kingSquare(rep.pos.board, rep.pos.turn) : -1;

    for (var vr = 0; vr < 8; vr++) {
      for (var vf = 0; vf < 8; vf++) {
        var r = flip ? vr : 7 - vr;
        var f = flip ? 7 - vf : vf;
        var sq = (r << 3) | f;
        var cell = document.createElement("button");
        var isLight = ((r + f) & 1) === 1;
        var cls = "sq " + (isLight ? "light" : "dark");
        if (lastUnpacked && (sq === lastUnpacked.from || sq === lastUnpacked.to)) cls += " last";
        if (sq === selectedSq) cls += " sel";
        if (sq === checkKing) cls += " chk";
        cell.className = cls;

        var pc = rep.pos.board[sq];
        if (pc) {
          cell.insertAdjacentHTML("beforeend", pieceSvg(pc));
        }
        var tMoves = targets.filter(function (m) { return m.to === sq; });
        if (tMoves.length) {
          var mark = document.createElement("span");
          mark.className = pc ? "ring" : "dot";
          cell.appendChild(mark);
        }
        if (vr === 7) {
          var fl = document.createElement("span");
          fl.className = "coord file"; fl.textContent = "abcdefgh"[f];
          cell.appendChild(fl);
        }
        if (vf === 0) {
          var rk = document.createElement("span");
          rk.className = "coord rank"; rk.textContent = String(r + 1);
          cell.appendChild(rk);
        }

        (function (sqIdx, cellTargets) {
          cell.onclick = function () {
            if (!myTurn) return;
            if (cellTargets.length === 1) {
              void commitMove(g, cellTargets[0]);
              return;
            }
            if (cellTargets.length > 1) {
              pendingPromo = { moves: cellTargets };
              render();
              return;
            }
            var piece = rep.pos.board[sqIdx];
            if (piece && pieceColor(piece) === g.myColor) {
              selectedSq = selectedSq === sqIdx ? null : sqIdx;
              pendingPromo = null;
              render();
            } else {
              selectedSq = null;
              pendingPromo = null;
              render();
            }
          };
        })(sq, tMoves);

        boardEl.appendChild(cell);
      }
    }
    mainEl.appendChild(boardEl);

    if (pendingPromo) {
      var pbar = document.createElement("div");
      pbar.className = "promo-bar";
      var plbl = document.createElement("span"); plbl.textContent = T.promote;
      pbar.appendChild(plbl);
      var pwrap = document.createElement("div");
      pwrap.className = "promo-btns";
      pendingPromo.moves.forEach(function (mv) {
        var b = document.createElement("button");
        var ch = PROMO_MAP[mv.promo];
        b.innerHTML = pieceSvg(g.myColor === "w" ? ch.toUpperCase() : ch);
        b.onclick = function () { void commitMove(g, mv); };
        pwrap.appendChild(b);
      });
      pbar.appendChild(pwrap);
      mainEl.appendChild(pbar);
    }

    var selfBar = document.createElement("div");
    selfBar.className = "bar";
    var stateText = g.status === "finished"
      ? (g.winner === "draw" ? T.drawn : g.winner === g.myColor ? T.won : T.lost)
      : g.status === "invited_out" ? T.inviteSent
      : g.status === "invited_in" ? T.inviteIn
      : myTurn ? T.yourTurn : T.waitTurn;
    selfBar.innerHTML = '<strong>' + esc(T.you + ' (' + (g.myColor === "w" ? T.white : T.black) + ')') + '</strong><span class="' + (myTurn ? "turn" : "") + '">' + esc(stateText) + '</span>';
    mainEl.appendChild(selfBar);

    var del = deliveryByGame[g.id];
    if (del || !app.context.radio.supportsPeerData) {
      var pill = document.createElement("div");
      pill.className = "status-pill " + (del ? del.tone : "warn");
      pill.textContent = del ? del.text : T.noRadio;
      mainEl.appendChild(pill);
    }

    if (g.status === "active") {
      var actsEl = document.createElement("div");
      actsEl.className = "actions";
      if (g.drawOfferedBy && g.drawOfferedBy !== g.myColor) {
        var aDraw = document.createElement("button");
        aDraw.className = "btn primary"; aDraw.textContent = T.acceptDraw;
        aDraw.onclick = async function () {
          g.status = "finished"; g.winner = "draw"; g.drawOfferedBy = null; g.updatedAt = Date.now();
          await persist();
          await sendForGame(g, encodeActionPkt(g.gameId, g.moves.length, ACT_DRAW_ACCEPT), T.drawn);
        };
        var dDraw = document.createElement("button");
        dDraw.className = "btn"; dDraw.textContent = T.declineDraw;
        dDraw.onclick = async function () {
          g.drawOfferedBy = null; g.updatedAt = Date.now();
          await persist();
          await sendForGame(g, encodeActionPkt(g.gameId, g.moves.length, ACT_DRAW_DECLINE), T.declineDraw);
        };
        actsEl.appendChild(aDraw); actsEl.appendChild(dDraw);
      } else {
        var drawBtn = document.createElement("button");
        drawBtn.className = "btn"; drawBtn.textContent = T.draw;
        drawBtn.onclick = async function () {
          g.drawOfferedBy = g.myColor; g.updatedAt = Date.now();
          await persist();
          await sendForGame(g, encodeActionPkt(g.gameId, g.moves.length, ACT_DRAW_OFFER), T.draw);
        };
        actsEl.appendChild(drawBtn);
      }
      var syncBtn = document.createElement("button");
      syncBtn.className = "btn"; syncBtn.textContent = T.sync;
      syncBtn.onclick = function () { void sendForGame(g, encodeSyncReq(g.gameId, 0), T.sync); };
      var resBtn = document.createElement("button");
      resBtn.className = "btn danger"; resBtn.textContent = T.resign;
      resBtn.onclick = async function () {
        g.status = "finished"; g.winner = oppColor; g.updatedAt = Date.now();
        await persist();
        await sendForGame(g, encodeActionPkt(g.gameId, g.moves.length, ACT_RESIGN), T.resign);
      };
      actsEl.appendChild(syncBtn); actsEl.appendChild(resBtn);
      mainEl.appendChild(actsEl);
    }
  }

  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  await app.ui.setActivities(buildActivities(games, app.context.locale));
  render();
});
</script>
`;

export const chessPackage: MiniAppPackage = {
  format: "omapp-v1",
  manifest: {
    schema: 1,
    id: "ommesh.chess",
    appId: CHESS_APP_ID,
    version: "1.3.1",
    name: { ru: "Шахматы", en: "Chess" },
    description: {
      ru: "Шахматы по LoRa с подтверждением ходов (1 AES-блок на ход, авто-ресинк и фоновые уведомления)",
      en: "LoRa chess with delivery ACKs (1 AES block per move, auto-resync and background notifications)",
    },
    author: "Ommesh",
    scope: "p2p",
    minProtocol: 2,
    permissions: ["peerData", "storage", "notifications"],
    backgroundNotices: {
      opcodeMask: 0x1f,
      fallback: { ru: "Событие в шахматах", en: "Chess update" },
      labels: {
        "1": { ru: "Приглашение в партию", en: "Game invitation" },
        "2": { ru: "Приглашение принято", en: "Invitation accepted" },
        "3": { ru: "Приглашение отклонено", en: "Invitation declined" },
        "4": { ru: "Ваш ход", en: "Your turn" },
        "5": { ru: "Событие в партии", en: "Game action" },
        "8": { ru: "Сообщение в партии", en: "Game chat message" },
      },
    },
  },
  iconSvg: ICON_SVG,
  html: HTML,
  workerJs: WORKER_JS,
};
