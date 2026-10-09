/**
 * Reactions: an emoji put on a channel message.
 *
 * MeshCore has no field for them. Ommesh sends one as a channel datagram
 * (`PAYLOAD_TYPE_GRP_DATA`, sent with `CMD_SEND_CHANNEL_DATA`): one flood,
 * as a text reaction would be, but an app that does not know it shows
 * nothing rather than a line of code under the emoji. Its type is in the
 * range MeshCore leaves for testing (`docs/number_allocations.md`) until
 * Ommesh registers one of its own.
 *
 * A message is named by MeshCore One's hash: the first five bytes of SHA-256
 * over its text and its sender's stamp
 * (https://github.com/Avi0n/MeshCoreOne/blob/main/docs/Reactions.md). Every
 * radio that heard the message can work it out, and MeshCore One's text
 * reactions name a message the same way, so both kinds meet on it.
 *
 * The datagram, after the type and length the firmware puts before it:
 *
 *   0       kind: 1, a reaction
 *   1–5     the message's hash
 *   6       n, the emoji's length in bytes; 0 takes the reaction back
 *   7       the emoji, n bytes of UTF-8
 *   7 + n   who reacts, by the name on their channel messages: a datagram carries no sender
 *
 * A reaction stands for everything its sender has put on the message: a new
 * one replaces the last.
 */
import { concat, utf8 } from "./bytes.js";

/** The datagram type Ommesh's reactions travel under. */
export const REACTION_DATA_TYPE = 0xff0e;

const KIND_REACTION = 1;
export const MESSAGE_HASH_SIZE = 5;
/** Longer than any one emoji, family and skin tone included. */
const MAX_EMOJI_BYTES = 32;
/** A node's name field. */
const MAX_NAME_BYTES = 32;

export interface Reaction {
  /** The message's hash (`messageHash`). */
  target: Uint8Array;
  /** Empty when the reaction is taken back. */
  emoji: string;
  /** Who reacts. */
  by: string;
}

const strict = new TextDecoder("utf-8", { fatal: true });

/** MeshCore One's name for a message: the first five bytes of SHA-256 over its text and the sender's stamp, little-endian. */
export async function messageHash(text: string, timestamp: number): Promise<Uint8Array> {
  const stamp = new Uint8Array(4);
  new DataView(stamp.buffer).setUint32(0, timestamp >>> 0, true);
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("WebCrypto is not available here");
  const digest = await subtle.digest("SHA-256", new Uint8Array(concat(utf8(text), stamp)));
  return new Uint8Array(digest, 0, MESSAGE_HASH_SIZE);
}

export function encodeReaction(reaction: Reaction): Uint8Array {
  if (reaction.target.length !== MESSAGE_HASH_SIZE) throw new Error(`a message hash is ${MESSAGE_HASH_SIZE} bytes`);
  const emoji = utf8(reaction.emoji);
  const by = utf8(reaction.by);
  if (emoji.length > MAX_EMOJI_BYTES) throw new Error("not one emoji");
  if (by.length === 0 || by.length > MAX_NAME_BYTES) throw new Error("a reaction needs its sender's name");
  return concat(new Uint8Array([KIND_REACTION]), reaction.target, new Uint8Array([emoji.length]), emoji, by);
}

/** A reaction read from a datagram, or null for anything else sent under the type: the testing range is shared. */
export function decodeReaction(data: Uint8Array): Reaction | null {
  if (data.length < 1 + MESSAGE_HASH_SIZE + 1 + 1 || data[0] !== KIND_REACTION) return null;
  const length = data[1 + MESSAGE_HASH_SIZE]!;
  const start = 2 + MESSAGE_HASH_SIZE;
  const nameLength = data.length - start - length;
  if (length > MAX_EMOJI_BYTES || nameLength < 1 || nameLength > MAX_NAME_BYTES) return null;
  try {
    const emoji = strict.decode(data.subarray(start, start + length));
    const by = strict.decode(data.subarray(start + length));
    if (by.includes("\0") || (emoji && !looksLikeEmoji(emoji))) return null;
    return { target: data.slice(1, 1 + MESSAGE_HASH_SIZE), emoji, by };
  } catch {
    return null;
  }
}

/** A reaction MeshCore One sent as text on a channel. */
export interface TextReaction {
  emoji: string;
  /** Whose message it is on: the name in the mention. */
  to: string;
  target: Uint8Array;
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Five bytes as eight letters of Crockford's base 32, as MeshCore One writes a hash. */
export function crockford(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = ((value << 8) | b) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += CROCKFORD[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += CROCKFORD[(value << (5 - bits)) & 31];
  return out.toLowerCase();
}

/** Eight letters of Crockford's base 32 back into five bytes, the lookalike letters read as the digits they stand for. */
function fromCrockford(text: string): Uint8Array | null {
  const out = new Uint8Array(MESSAGE_HASH_SIZE);
  let bits = 0;
  let value = 0;
  let at = 0;
  for (const c of text.toUpperCase().replace(/O/g, "0").replace(/[IL]/g, "1")) {
    const digit = CROCKFORD.indexOf(c);
    if (digit < 0) return null;
    value = ((value << 5) | digit) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      out[at++] = (value >>> (bits - 8)) & 0xff;
      bits -= 8;
    }
  }
  return at === MESSAGE_HASH_SIZE ? out : null;
}

// `@[Name]👍` and a hash on the next line; until MeshCore One 1.4.1 the emoji came first.
const TEXT_REACTION = /^@\[([^\]\n]{1,32})\]([^\n]{1,32})\n([0-9a-z]{8})$/i;
const OLD_TEXT_REACTION = /^([^\n]{1,32}?)@\[([^\]\n]{1,32})\]\n([0-9a-z]{8})$/i;

/** MeshCore One's channel reaction, read from a message's text; null for a message. */
export function parseTextReaction(text: string): TextReaction | null {
  const now = TEXT_REACTION.exec(text);
  const old = now ? null : OLD_TEXT_REACTION.exec(text);
  const [to, emoji, hash] = now ? [now[1]!, now[2]!, now[3]!] : old ? [old[2]!, old[1]!, old[3]!] : [];
  if (to === undefined || emoji === undefined || hash === undefined || !looksLikeEmoji(emoji)) return null;
  const target = fromCrockford(hash);
  return target ? { emoji, to, target } : null;
}

/**
 * A reaction in a direct message, tried out: a direct message has no
 * datagram, so it goes as console data (`TXT_TYPE_CLI_DATA`), which the
 * radio sends to any contact and hands up on the other side as a message of
 * that type. The text is MeshCore One's for a direct message, the emoji and
 * the message's hash on the next line; no emoji takes the reaction back.
 * The firmware acknowledges no console data, so it goes once.
 */
export function directReactionText(emoji: string, target: Uint8Array): string {
  return `${emoji}\n${crockford(target)}`;
}

const DIRECT_REACTION = /^([^\n]{0,32})\n([0-9a-z]{8})$/i;

/** A reaction read from console data a contact sent; null for anything else. */
export function parseDirectReaction(text: string): { emoji: string; target: Uint8Array } | null {
  const match = DIRECT_REACTION.exec(text);
  if (!match || (match[1] && !looksLikeEmoji(match[1]))) return null;
  const target = fromCrockford(match[2]!);
  return target ? { emoji: match[1]!, target } : null;
}

const graphemes = typeof Intl !== "undefined" && "Segmenter" in Intl ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;

/**
 * One emoji and nothing else, by MeshCore One's test: a single grapheme that
 * starts at U+2000 or above, or carries the emoji variation selector or a
 * keycap. "Ok" fails it, so a short line of text is never taken for one.
 */
export function looksLikeEmoji(text: string): boolean {
  const count = graphemes ? [...graphemes.segment(text)].length : [...text].length;
  if (count !== 1) return false;
  const points = [...text].map((c) => c.codePointAt(0)!);
  return points[0]! >= 0x2000 || points.some((p) => p === 0xfe0f || p === 0x20e3);
}
