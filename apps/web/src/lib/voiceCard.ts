/**
 * A voice card (#89): some ten seconds of someone reading a set phrase, from
 * which a listener's computer clones their voice. It is handed over as a
 * file, not over the air: a plain WAV any player plays, with what Ommesh
 * needs in a chunk of its own (`omsh`) that players pass over: whose voice it
 * is, by name and by the first bytes of their radio's key, and what they read,
 * which a cloning model may want alongside the sound.
 *
 * A card is told by its print, the first four bytes of SHA-256 over its
 * samples: the announce carries it, so a listener knows whether the card
 * they hold is the one the speaker means.
 */

import { sha256 } from "./sha256.js";

/** What a card says besides the sound. */
export interface CardInfo {
  /** The speaker's name, as on their messages. */
  name: string;
  /** Hex of the first four bytes of their radio's key. */
  speaker: string;
  /** What they read. */
  text: string;
}

export interface VoiceCard extends CardInfo {
  /** Mono samples, -1 to 1. */
  pcm: Float32Array;
  sampleRate: number;
  /** Hex of the first four bytes of SHA-256 over the 16-bit samples as stored. */
  print: string;
}

/** The phrase a card is read from: some ten seconds, with most of the sounds of Russian in it. */
export const CARD_PHRASE =
  "Мы стоим на высоком берегу. Внизу шумит быстрая река, за тёмным лесом встаёт солнце, и до вышки ещё два часа пути. Возьми рацию, проверь связь и скажи, что слышишь.";

/** The rate a card is recorded and stored at: what the cloning model's conditioning reads. */
export const CARD_RATE = 24_000;

const CHUNK = "omsh";
const VERSION = 1;

function samples16(pcm: Float32Array): Uint8Array {
  const out = new Uint8Array(pcm.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < pcm.length; i++) view.setInt16(i * 2, Math.round(Math.max(-1, Math.min(1, pcm[i]!)) * 32767), true);
  return out;
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** A card's print, from its 16-bit samples. */
export function cardPrint(data16: Uint8Array): string {
  return hex(sha256(data16).subarray(0, 4));
}

/** A card as a WAV file's bytes. */
export function encodeCard(pcm: Float32Array, sampleRate: number, info: CardInfo): Uint8Array {
  const data = samples16(pcm);
  const meta = new TextEncoder().encode(JSON.stringify({ app: "ommesh", card: VERSION, name: info.name, speaker: info.speaker, text: info.text }));
  const metaPadded = meta.length + (meta.length % 2);
  const size = 4 + (8 + 16) + (8 + metaPadded) + (8 + data.length);
  const out = new Uint8Array(8 + size);
  const view = new DataView(out.buffer);
  const ascii = (at: number, s: string) => [...s].forEach((c, i) => (out[at + i] = c.charCodeAt(0)));
  ascii(0, "RIFF");
  view.setUint32(4, size, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, CHUNK);
  view.setUint32(40, meta.length, true);
  out.set(meta, 44);
  const dataAt = 44 + metaPadded;
  ascii(dataAt, "data");
  view.setUint32(dataAt + 4, data.length, true);
  out.set(data, dataAt + 8);
  return out;
}

/** A card read from a file's bytes; null for a WAV that is not one, or for anything else. */
export function decodeCard(bytes: Uint8Array): VoiceCard | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));
  if (bytes.length < 12 || ascii(0) !== "RIFF" || ascii(8) !== "WAVE") return null;
  let rate = 0;
  let format = 0;
  let channels = 0;
  let bits = 0;
  let info: CardInfo | null = null;
  let data: Uint8Array | null = null;
  for (let at = 12; at + 8 <= bytes.length; ) {
    const id = ascii(at);
    const size = view.getUint32(at + 4, true);
    const body = bytes.subarray(at + 8, Math.min(bytes.length, at + 8 + size));
    if (id === "fmt " && body.length >= 16) {
      const fmt = new DataView(body.buffer, body.byteOffset, body.byteLength);
      format = fmt.getUint16(0, true);
      channels = fmt.getUint16(2, true);
      rate = fmt.getUint32(4, true);
      bits = fmt.getUint16(14, true);
    } else if (id === CHUNK) {
      try {
        const meta = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)) as Record<string, unknown>;
        if (meta.app === "ommesh" && typeof meta.name === "string" && typeof meta.speaker === "string" && /^[0-9a-f]{8}$/.test(meta.speaker)) {
          info = { name: meta.name, speaker: meta.speaker, text: typeof meta.text === "string" ? meta.text : "" };
        }
      } catch {
        return null;
      }
    } else if (id === "data") {
      data = body;
    }
    at += 8 + size + (size % 2);
  }
  if (!info || !data || format !== 1 || channels !== 1 || bits !== 16 || rate < 8000) return null;
  const pcm = new Float32Array(Math.floor(data.length / 2));
  const samples = new DataView(data.buffer, data.byteOffset, data.byteLength);
  for (let i = 0; i < pcm.length; i++) pcm[i] = samples.getInt16(i * 2, true) / 32767;
  return { ...info, pcm, sampleRate: rate, print: cardPrint(data.subarray(0, pcm.length * 2)) };
}

/** The file a card is saved as: whose it is, plainly. */
export function cardFileName(info: CardInfo): string {
  const name = info.name.replace(/[\\/:*?"<>|]+/g, "").trim() || "voice";
  return `ommesh-voice-${name}-${info.speaker}.wav`;
}
