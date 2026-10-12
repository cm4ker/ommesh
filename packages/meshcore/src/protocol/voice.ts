/**
 * Voice messages (#89), tried in one public channel, #voice. What travels is
 * not sound but the words: the sender's app recognises the speech, packs the
 * text with a dictionary trained on Russian speech, and the listener's app
 * shows it and reads it out. Ten seconds of speech fit one part.
 *
 * Both kinds go as channel datagrams under a type from the range MeshCore
 * leaves for testing, next to the reactions' 0xFF0E, so an app that does not
 * know them shows nothing. After the type and length the firmware puts
 * before it, a datagram is:
 *
 * The announce, sent only when its sender presses the button for it:
 *
 *   0       kind: 1
 *   1–4     who speaks: the first four bytes of their radio's public key
 *   5       their voice (`VoiceGender`)
 *   6       the packings they read, one bit each (`VoiceCodec`)
 *   7–10    the first four bytes of a hash of their voice card; zeros for none
 *   11…     their name, UTF-8, as on their channel messages
 *
 * A part of a voice message:
 *
 *   0       kind: 2
 *   1–4     who speaks, as above
 *   5–6     the message's number, little-endian, so parts find each other
 *   7       the part's place, high four bits, and the count less one, low four
 *   8       the packing, high four bits, and the try, low four: a part sent
 *           again differs by it, or every repeater that carried it drops it
 *   9       the message's length in quarter seconds
 *   10…     the part's text, packed
 *
 * A part carries no name: it is the announce's to give, and a radio heard
 * before is found among the contacts by its key. Each part is cut at a space
 * and packed alone, so one that arrives reads and sounds by itself when its
 * neighbour is lost.
 */
import { concat, utf8 } from "./bytes.js";

/** The datagram type voice messages travel under. */
export const VOICE_DATA_TYPE = 0xff0f;

const KIND_ANNOUNCE = 1;
const KIND_PART = 2;

/** The bytes of a key that name who speaks. */
export const VOICE_SPEAKER_SIZE = 4;
/** Before a part's text: kind, speaker, number, place, packing and try, length. */
const PART_HEAD = 1 + VOICE_SPEAKER_SIZE + 2 + 1 + 1 + 1;
/**
 * The most a part's datagram carries. A heard packet reaches the app only
 * when it fits `MAX_FRAME_SIZE` (see `CHANNEL_TEXT_LEN`): with three bytes of
 * type and length, 157 seal into ten cipher blocks, and a repeater's copy can
 * still be told apart from silence.
 */
export const VOICE_DATAGRAM_MAX = 157;
/** The most packed text one part carries. */
export const VOICE_PART_TEXT_MAX = VOICE_DATAGRAM_MAX - PART_HEAD;
/** Parts in one message at most: the count has four bits. */
export const VOICE_MAX_PARTS = 16;
/** The longest a message says it is, seconds: a byte of quarter seconds. */
export const VOICE_MAX_SECONDS = 255 / 4;
/** A node's name field. */
const MAX_NAME_BYTES = 32;

/** How a part's text is packed. */
export const VoiceCodec = {
  /** zstd with the MeshSpeech dictionary of Russian speech, version 1, frame without magic, dictionary id or checksum. */
  ZstdRuV1: 1,
} as const;
export type VoiceCodec = (typeof VoiceCodec)[keyof typeof VoiceCodec];

/** The voice a sender asks to be read in, where the listener's voices are the computer's own. */
export const VoiceGender = {
  Any: 0,
  Female: 1,
  Male: 2,
} as const;
export type VoiceGender = (typeof VoiceGender)[keyof typeof VoiceGender];

export interface VoiceAnnounce {
  kind: "announce";
  /** Hex of the first four key bytes. */
  speaker: string;
  gender: VoiceGender;
  /** The packings read, as `VoiceCodec` bits. */
  codecs: number;
  /** Hex of four bytes; null without a voice card. */
  card: string | null;
  name: string;
}

export interface VoicePart {
  kind: "part";
  speaker: string;
  /** The message's number, 0–65535. */
  message: number;
  /** This part's place, from 0. */
  index: number;
  count: number;
  codec: number;
  /** 0 the first time, 1 and on when sent again. */
  attempt: number;
  /** The whole message's length, seconds, to a quarter. */
  seconds: number;
  /** The packed text. */
  data: Uint8Array;
}

export type VoiceDatagram = VoiceAnnounce | VoicePart;

const strict = new TextDecoder("utf-8", { fatal: true });

function speakerBytes(speaker: string): Uint8Array {
  if (!/^[0-9a-f]{8}$/i.test(speaker)) throw new Error("a speaker is four bytes of hex");
  return new Uint8Array(speaker.match(/../g)!.map((b) => parseInt(b, 16)));
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function encodeVoiceAnnounce(announce: Omit<VoiceAnnounce, "kind">): Uint8Array {
  const name = utf8(announce.name);
  if (name.length === 0 || name.length > MAX_NAME_BYTES) throw new Error("an announce needs its sender's name");
  const card = announce.card ? speakerBytes(announce.card) : new Uint8Array(4);
  return concat(new Uint8Array([KIND_ANNOUNCE]), speakerBytes(announce.speaker), new Uint8Array([announce.gender, announce.codecs & 0xff]), card, name);
}

export function encodeVoicePart(part: Omit<VoicePart, "kind">): Uint8Array {
  if (part.count < 1 || part.count > VOICE_MAX_PARTS || part.index < 0 || part.index >= part.count) throw new Error("a part's place is out of range");
  if (part.data.length === 0 || part.data.length > VOICE_PART_TEXT_MAX) throw new Error(`a part carries 1 to ${VOICE_PART_TEXT_MAX} bytes of text`);
  const quarters = Math.min(255, Math.max(0, Math.round(part.seconds * 4)));
  const head = new Uint8Array(PART_HEAD);
  head[0] = KIND_PART;
  head.set(speakerBytes(part.speaker), 1);
  head[5] = part.message & 0xff;
  head[6] = (part.message >>> 8) & 0xff;
  head[7] = (part.index << 4) | (part.count - 1);
  head[8] = ((part.codec & 0x0f) << 4) | (part.attempt & 0x0f);
  head[9] = quarters;
  return concat(head, part.data);
}

/** A voice datagram read, or null for anything else sent under the type: the testing range is shared. */
export function decodeVoice(data: Uint8Array): VoiceDatagram | null {
  if (data[0] === KIND_ANNOUNCE) {
    if (data.length < 12 || data.length > 11 + MAX_NAME_BYTES) return null;
    const gender = data[5]!;
    if (gender !== VoiceGender.Any && gender !== VoiceGender.Female && gender !== VoiceGender.Male) return null;
    const card = data.subarray(7, 11);
    try {
      const name = strict.decode(data.subarray(11));
      if (name.includes("\0")) return null;
      return { kind: "announce", speaker: hex(data.subarray(1, 5)), gender, codecs: data[6]!, card: card.some((b) => b !== 0) ? hex(card) : null, name };
    } catch {
      return null;
    }
  }
  if (data[0] === KIND_PART) {
    if (data.length <= PART_HEAD || data.length > VOICE_DATAGRAM_MAX) return null;
    const index = data[7]! >>> 4;
    const count = (data[7]! & 0x0f) + 1;
    if (index >= count) return null;
    return {
      kind: "part",
      speaker: hex(data.subarray(1, 5)),
      message: data[5]! | (data[6]! << 8),
      index,
      count,
      codec: data[8]! >>> 4,
      attempt: data[8]! & 0x0f,
      seconds: data[9]! / 4,
      data: data.slice(PART_HEAD),
    };
  }
  return null;
}

/**
 * Text cut into parts at spaces so that each part, packed, fits one
 * datagram: words are added to a part while its packing still fits. A single
 * word too long for a part is cut by letters. Null when even the cut text
 * needs more parts than a message may have.
 */
export async function splitVoiceText(text: string, pack: (text: string) => Promise<Uint8Array>): Promise<{ text: string; data: Uint8Array }[] | null> {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const parts: { text: string; data: Uint8Array }[] = [];
  let current = "";
  let packed: Uint8Array | null = null;
  const fits = async (candidate: string) => {
    const data = await pack(candidate);
    return data.length <= VOICE_PART_TEXT_MAX ? data : null;
  };
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!;
    const candidate = current ? `${current} ${word}` : word;
    const data = await fits(candidate);
    if (data) {
      current = candidate;
      packed = data;
      continue;
    }
    if (current && packed) {
      parts.push({ text: current, data: packed });
      current = "";
      packed = null;
      i--;
      continue;
    }
    // One word that does not fit alone: cut it by letters.
    const letters = [...word];
    let cut = letters.length;
    let piece: Uint8Array | null = null;
    while (cut > 1 && !(piece = await fits(letters.slice(0, cut).join("")))) cut = Math.floor(cut * 0.8);
    if (!piece) return null;
    parts.push({ text: letters.slice(0, cut).join(""), data: piece });
    words[i] = letters.slice(cut).join("");
    i--;
    if (parts.length > VOICE_MAX_PARTS) return null;
  }
  if (current && packed) parts.push({ text: current, data: packed });
  return parts.length <= VOICE_MAX_PARTS ? parts : null;
}
