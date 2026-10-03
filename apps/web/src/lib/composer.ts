/**
 * What a message costs before it goes: its bytes once the lookalike letters
 * are packed, where the radio would cut it, how many 16-byte blocks the
 * cipher makes of it and how long its packet holds the air. Pure, so the
 * composer's numbers are testable without a radio.
 *
 * The layout is the firmware's (BaseChatMesh::composeMsgPacket and
 * sendGroupMessage): four bytes of time and one of flags before the text, a
 * channel message's `name: ` too, the whole encrypted in AES blocks of 16 and
 * sealed with a two-byte MAC.
 */

import { MAX_TEXT_LEN } from "@meshnet/meshcore";
import { textWithPlaces } from "./place.js";

const encoder = new TextEncoder();
const bytes = (text: string) => encoder.encode(text).length;

/** The cipher's block: past each boundary the packet grows by another 16 bytes of air. */
export const BLOCK = 16;

/** Time and flags, before the text. */
const STAMP = 5;

export interface RadioShape {
  spreadingFactor: number;
  bandwidthHz: number;
  /** The denominator of 4/5 … 4/8. */
  codingRate: number;
}

/**
 * Semtech's time on air for `size` bytes, explicit header and CRC on, with
 * the preamble MeshCore sets: 32 symbols up to SF8, 16 above
 * (RadioLibWrapper::preambleLengthForSF).
 */
export function airtimeMs(size: number, radio: RadioShape): number {
  const sf = radio.spreadingFactor;
  const symbol = (2 ** sf / radio.bandwidthHz) * 1000;
  const lowRate = symbol >= 16 ? 1 : 0;
  const preamble = sf <= 8 ? 32 : 16;
  const payload = 8 + Math.max(Math.ceil((8 * size - 4 * sf + 28 + 16) / (4 * (sf - 2 * lowRate))) * radio.codingRate, 0);
  return (preamble + 4.25 + payload) * symbol;
}

/**
 * The bytes of a packet outside its cipher text: header and path length, the
 * path a direct message is sent along (`pathBytes`), the two one-byte hashes
 * of its ends or a channel's hash, and the MAC.
 */
export function headerBytes(kind: "direct" | "channel", pathBytes = 0): number {
  return kind === "channel" ? 1 + 1 + 1 + 2 : 1 + 1 + pathBytes + 1 + 1 + 2;
}

/** The bytes of a contact's route in a packet: its hops, each a hash of one to three bytes. */
export function pathBytes(outPathLen: number): number {
  return outPathLen === 0xff ? 0 : (outPathLen & 63) * ((outPathLen >> 6) + 1);
}

export interface Cost {
  /** As typed. */
  typed: number;
  /** As it goes, lookalikes packed. */
  used: number;
  /** Bytes before the text: a channel's `name: `, a reply's mention. */
  prefix: number;
  /** What the text may take. */
  budget: number;
  /** Past the budget; 0 when it fits. */
  over: number;
  /** Time, flags, prefix and text: what the cipher is given. */
  plain: number;
  blocks: number;
  packet: number;
  /** Null when the radio's settings are not known. */
  airMs: number | null;
}

export function costOf(text: string, options: { pack: (text: string) => string; prefix: string; header: number; radio: RadioShape | null }): Cost {
  const typed = bytes(text);
  const used = bytes(options.pack(text));
  const prefix = bytes(options.prefix);
  const budget = MAX_TEXT_LEN - prefix;
  const plain = STAMP + prefix + used;
  const blocks = Math.ceil(plain / BLOCK);
  const packet = options.header + blocks * BLOCK;
  return {
    typed,
    used,
    prefix,
    budget,
    over: Math.max(0, used - budget),
    plain,
    blocks,
    packet,
    airMs: options.radio ? airtimeMs(packet, options.radio) : null,
  };
}

/** Where on a scale of MAX_TEXT_LEN bytes of prefix and text another block begins: the meter's ticks. */
export function blockEdges(): number[] {
  const edges: number[] = [];
  for (let at = BLOCK - STAMP; at < MAX_TEXT_LEN; at += BLOCK) edges.push(at);
  return edges;
}

/** A run of the typed text as the layer under the field marks it. */
export interface Segment {
  text: string;
  mention: boolean;
  over: boolean;
}

export const MENTION = /@\[([^\]\n]{1,32})\]/g;

/** The typed text cut into runs: mentions, and what lies past the budget once packed. */
export function segments(text: string, pack: (text: string) => string, budget: number): Segment[] {
  const mentions: [number, number][] = [];
  for (const m of text.matchAll(MENTION)) mentions.push([m.index ?? 0, (m.index ?? 0) + m[0].length]);
  const out: Segment[] = [];
  let used = 0;
  let at = 0;
  for (const c of text) {
    used += bytes(pack(c));
    const mention = mentions.some(([a, b]) => at >= a && at < b);
    const over = used > budget;
    const last = out[out.length - 1];
    if (last && last.mention === mention && last.over === over) last.text += c;
    else out.push({ text: c, mention, over });
    at += c.length;
  }
  return out;
}

/** The mention being typed before the caret: `@` at the start or after a space, and a few letters. */
export function mentionQuery(value: string, caret: number): { start: number; query: string } | null {
  const m = /(^|\s)@([^\s@[\]]{0,24})$/.exec(value.slice(0, caret));
  return m ? { start: caret - m[2]!.length - 1, query: m[2]! } : null;
}

export function mentionOf(name: string): string {
  return `@[${name}] `;
}

/** How much of a message a reply quotes: a few words, enough to tell which message it was. */
const QUOTE_CHARS = 15;
/** A reply's head, as the composer writes it: the mention, then the quoted line. */
const QUOTE_HEAD = /^(?:@\[[^\]\n]{1,32}\] )?>[^\n]*\n/;

/** How long the head a reply puts before its own words is: 0 for a message that answers nothing. */
export function quoteHeadLength(text: string): number {
  return QUOTE_HEAD.exec(text)?.[0].length ?? 0;
}

/**
 * The start of a message, for the line a reply puts at the head of the field:
 * its own quote and the names it opens with left out, cut at a word, and "…"
 * where something was cut. A place is quoted in words: cut, its numbers would
 * read as another place, far from the first.
 */
export function quoteOf(text: string): string {
  const said = textWithPlaces(text.replace(QUOTE_HEAD, "").replace(/^(?:@\[[^\]\n]{1,32}\] ?)+/, ""))
    .replace(/\s+/g, " ")
    .trim();
  const chars = Array.from(said);
  if (chars.length <= QUOTE_CHARS) return said;
  let cut = chars.slice(0, QUOTE_CHARS).join("");
  const space = cut.lastIndexOf(" ");
  // Cut inside a word: back to the space before it, unless that leaves too little.
  if (chars[QUOTE_CHARS] !== " " && space >= 8) cut = cut.slice(0, space);
  return `${cut.replace(/[\s.,;:!?-]+$/, "")}…`;
}

/**
 * A text too long for one message, cut between words into parts that each
 * fit `budget` with their ` (1/2)` mark. Words longer than a part are cut
 * where they must be.
 */
export function splitParts(text: string, budget: number): string[] {
  for (let n = 2; n < 16; n++) {
    const parts: string[] = [];
    let current = "";
    const room = () => budget - bytes(` (${parts.length + 1}/${n})`);
    for (const word of text.split(/(\s+)/)) {
      if (bytes(current + word) <= room()) {
        current += word;
        continue;
      }
      if (current.trim()) parts.push(current.trim());
      current = word.trim() ? word : "";
      while (bytes(current) > room()) {
        let piece = "";
        for (const c of current) {
          if (bytes(piece + c) > room()) break;
          piece += c;
        }
        parts.push(piece);
        current = current.slice(piece.length);
      }
    }
    if (current.trim()) parts.push(current.trim());
    if (parts.length <= n) return parts.map((p, i) => `${p} (${i + 1}/${parts.length})`);
  }
  return [text];
}

const TRANSLIT: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "yo", ж: "zh", з: "z", и: "i", й: "y",
  к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f",
  х: "h", ц: "c", ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
};

/** Russian in Latin letters, a byte each instead of two. */
export function translit(text: string): string {
  let out = "";
  for (const c of text) {
    const lower = c.toLowerCase();
    const latin = TRANSLIT[lower];
    if (latin === undefined) out += c;
    else out += c !== lower && latin ? latin[0]!.toUpperCase() + latin.slice(1) : latin;
  }
  return out;
}

export function hasCyrillic(text: string): boolean {
  return /[Ѐ-ӿ]/.test(text);
}

