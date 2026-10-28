/**
 * Frames between the two apps sharing one radio through a phone: the phone's
 * own and a computer connected to it. The phone's relay (`mux.rs` in
 * meshcore-core) passes them from one app to the other and never writes them
 * to the radio. With them the two keep alike what the reader has read and the
 * settings they share.
 *
 *   0xf1, 0, version, side   the relay's hello, right after the radio said who
 *                            it is: this app shares the radio, as the phone's
 *                            own (side 0) or as a computer (side 1)
 *   0xf1, 1, n, key, value   an entry: n bytes of key in UTF-8, then its value
 *   0xf1, 2, flags           to the relay, from hello version 2: this app tells
 *                            when it has saved the messages it takes, and the
 *                            relay keeps each until then and hands it again
 *                            should the app go first; said at each connect.
 *                            Flag 1: the mirrors it is told are counted too,
 *                            and kept so (a relay before that reads no flags)
 *   0xf1, 3, n, m (u32 LE)   to the relay: the first n messages taken since are
 *                            saved, and the first m mirrors told
 *
 * An entry stands for every one before it with its key, and an app away from
 * the phone gets only the latest of each. A read mark's key is `r:` and the
 * conversation; a setting's is `s:` and its name.
 *
 * A radio reached directly sends no hello, and an app sends no entry without one.
 */
import { Push } from "./codes.js";
import { concat, utf8 } from "./bytes.js";

export const PEER_HELLO = 0;
export const PEER_ENTRY = 1;
export const PEER_KEEP = 2;
export const PEER_SAVED = 3;
/** In `PEER_KEEP`'s flags: this app counts the mirrors it is told as well. */
export const KEEP_MIRRORS = 1;
/** The first hello version whose relay takes `PEER_KEEP` and `PEER_SAVED`. */
export const KEEP_VERSION = 2;

/** To the relay: this app tells when it has saved what it takes, mirrors too. */
export function peerKeep(): Uint8Array {
  return new Uint8Array([Push.Peer, PEER_KEEP, KEEP_MIRRORS]);
}

/** To the relay: the first `n` messages taken since `peerKeep` are saved, and the first `m` mirrors told. */
export function peerSaved(n: number, m = 0): Uint8Array {
  const out = new Uint8Array(10);
  out.set([Push.Peer, PEER_SAVED]);
  const view = new DataView(out.buffer);
  view.setUint32(2, n >>> 0, true);
  view.setUint32(6, m >>> 0, true);
  return out;
}

/** Which app this is on a radio shared through a phone. */
export type PeerSide = "phone" | "computer";

export const READ_MARK_PREFIX = "r:";
export const SETTING_PREFIX = "s:";

export function peerEntry(key: string, value: Uint8Array): Uint8Array {
  const name = utf8(key);
  if (name.length > 255) throw new Error(`an entry's key is ${name.length} bytes, longer than 255`);
  return concat(new Uint8Array([Push.Peer, PEER_ENTRY, name.length]), name, value);
}

/**
 * The newest message of a chat an app has read. Each app keeps its own copy of
 * a message, under an id of its own, so the two name it by what both copies
 * share: its sender's stamp and a hash of its text.
 */
export interface ReadMark {
  timestamp: number;
  hash: number;
}

/** The stamp, then the hash, little-endian. */
export function readMarkValue(mark: ReadMark): Uint8Array {
  const out = new Uint8Array(8);
  const view = new DataView(out.buffer);
  view.setUint32(0, mark.timestamp >>> 0, true);
  view.setUint32(4, mark.hash >>> 0, true);
  return out;
}

export function readMarkOf(value: Uint8Array): ReadMark | null {
  if (value.length < 8) return null;
  const view = new DataView(value.buffer, value.byteOffset, value.byteLength);
  return { timestamp: view.getUint32(0, true), hash: view.getUint32(4, true) };
}

/** FNV-1a over the text as UTF-8, as `text_hash` in meshcore-core's `frames.rs`. */
export function textHash(text: string): number {
  let hash = 0x811c9dc5;
  for (const byte of utf8(text)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
