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

import { CHANNEL_TEXT_LEN, DIRECT_TEXT_LEN, ROOM_TEXT_LEN } from "@meshnet/meshcore";
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

/** `ceiling` is what the prefix and the text may take together (`ceilingOf`). */
export function costOf(text: string, options: { pack: (text: string) => string; prefix: string; ceiling: number; header: number; radio: RadioShape | null }): Cost {
  const typed = bytes(text);
  const used = bytes(options.pack(text));
  const prefix = bytes(options.prefix);
  const budget = options.ceiling - prefix;
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

/**
 * What the prefix and the text may take together. On a channel, ten blocks,
 * so that a repeater's copy can be heard; in a direct message, room for the
 * attempt number later attempts carry; in a room, what the room keeps of a post.
 */
export function ceilingOf(kind: "direct" | "room" | "channel"): number {
  return kind === "channel" ? CHANNEL_TEXT_LEN : kind === "room" ? ROOM_TEXT_LEN : DIRECT_TEXT_LEN;
}

/** Where on a scale of `ceiling` bytes of prefix and text another block begins: the meter's ticks. */
export function blockEdges(ceiling: number): number[] {
  const edges: number[] = [];
  for (let at = BLOCK - STAMP; at < ceiling; at += BLOCK) edges.push(at);
  return edges;
}

/** A run of the typed text as the layer under the field marks it. */
export interface Segment {
  text: string;
  mention: boolean;
  over: boolean;
  /** Letters that go out looking different, when asked to mark them. */
  swapped: boolean;
}

export const MENTION = /@\[([^\]\n]{1,32})\]/g;

/**
 * The typed text cut into runs: mentions, what lies past the budget once packed, and, with
 * `swapped`, the letters it picks out. A mention goes as typed.
 */
export function segments(text: string, pack: (text: string) => string, budget: number, swapped?: (c: string) => boolean): Segment[] {
  const mentions: [number, number][] = [];
  for (const m of text.matchAll(MENTION)) mentions.push([m.index ?? 0, (m.index ?? 0) + m[0].length]);
  const out: Segment[] = [];
  let used = 0;
  let at = 0;
  for (const c of text) {
    const mention = mentions.some(([a, b]) => at >= a && at < b);
    used += bytes(mention ? c : pack(c));
    const over = used > budget;
    const marked = !mention && !over && (swapped?.(c) ?? false);
    const last = out[out.length - 1];
    if (last && last.mention === mention && last.over === over && last.swapped === marked) last.text += c;
    else out.push({ text: c, mention, over, swapped: marked });
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
/** How far a quote may run to tell its message from the sender's later ones, in bytes on the air (#32). */
const QUOTE_BYTES = 30;
/**
 * Where a quote stops short of its message. Three dots, as MCO Advanced cuts its quotes: it
 * finds the message a reply answers by the quote, and takes the dots off before it looks.
 * They cost the bytes "…" did.
 */
export const QUOTE_CUT = "...";
/**
 * A reply's head, as the composer writes it: the mention, then the quoted line. MeshCore One
 * puts the quote on a line of its own under the mention.
 */
const QUOTE_HEAD = /^(?:@\[[^\]\n]{1,32}\][ \n])?>[^\n]*\n/;

/** How long the head a reply puts before its own words is: 0 for a message that answers nothing. */
export function quoteHeadLength(text: string): number {
  return QUOTE_HEAD.exec(text)?.[0].length ?? 0;
}

/**
 * What of a message a quote is taken from: its own quote and the names it opens with left
 * out, a place in words, the spaces and line breaks run into single spaces.
 */
export function quoteSource(text: string): string {
  return textWithPlaces(text.replace(QUOTE_HEAD, "").replace(/^(?:@\[[^\]\n]{1,32}\] ?)+/, ""))
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The start of a message, for the line a reply puts at the head of the field:
 * cut at a word, and "..." where something was cut. A place is quoted in words:
 * cut, its numbers would read as another place, far from the first.
 *
 * Whoever reads the reply looks for the latest message of its sender that
 * starts with the quote, so a quote that also starts one of the sender's
 * `later` messages would lead there. It runs on to where the two differ, to
 * the end of that word if the bytes allow.
 */
export function quoteOf(text: string, later: readonly string[] = []): string {
  const said = quoteSource(text);
  const chars = Array.from(said);
  // How far the quote must run to part from each later message. One that runs on past this one's
  // end asks for all of it: a quote with no dots is the whole message, which tells it from a longer one.
  let need = 0;
  for (const other of later) need = Math.max(need, sharedStart(chars, Array.from(quoteSource(other))) + 1);
  const fits = (n: number) => bytes(chars.slice(0, n).join("")) <= QUOTE_BYTES;
  const reach = Math.min(need, chars.length);
  let n: number;
  if (need > QUOTE_CHARS && fits(reach)) {
    // To the end of the word they part in, if the bytes allow.
    n = reach;
    let end = n;
    while (end < chars.length && chars[end] !== " ") end++;
    if (fits(end)) n = end;
    if (n >= chars.length) return said;
  } else {
    // Alike for longer than the bytes allow, the later message cannot be told from this one anyway.
    const floor = need <= QUOTE_CHARS ? need : 0;
    if (chars.length <= QUOTE_CHARS) return said;
    n = QUOTE_CHARS;
    const space = chars.lastIndexOf(" ", n - 1);
    // Cut inside a word: back to the space before it, unless that leaves too little.
    if (chars[n] !== " " && space >= Math.max(8, floor)) n = space;
  }
  return `${chars.slice(0, n).join("").replace(/[\s.,;:!?-]+$/, "")}${QUOTE_CUT}`;
}

/** How many characters two texts start with alike. */
function sharedStart(a: string[], b: string[]): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
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

