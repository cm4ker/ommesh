/**
 * The radio's private key in a file of its own, `ommesh-key`, and read back
 * from one or from the bare hex the MeshCore app and a repeater's
 * `get prv.key` give. With its key back, a radio wiped by a crash or a flash
 * is the same node to the mesh again, and this device opens its chats.
 *
 * The key is kept apart from the history file on purpose: a history is
 * passed on to others, a key never should be.
 */

import { fromHex, privateKeyFault, publicKeyOf, toHex } from "@meshnet/meshcore";

export const KEY_FORMAT = "ommesh-key";
export const KEY_VERSION = 1;
/** A private key in hex. */
export const KEY_DIGITS = 128;

export interface KeyFile {
  format: typeof KEY_FORMAT;
  version: number;
  saved: string;
  by: string;
  /** The radio's name when it was saved, so the key can come back with it. */
  name: string;
  publicKey: string;
  privateKey: string;
}

export function writeKeyFile(radio: { name: string; key: string }, privateKey: Uint8Array, by: string, now: number): KeyFile {
  return { format: KEY_FORMAT, version: KEY_VERSION, saved: new Date(now).toISOString(), by, name: radio.name, publicKey: radio.key, privateKey: toHex(privateKey) };
}

export function keyFileName(radioName: string, now: number): string {
  const name = radioName.replace(/[\\/:*?"<>|\s.]+/g, "-").replace(/^-+|-+$/g, "") || "radio";
  const day = new Date(now);
  const date = [day.getFullYear(), day.getMonth() + 1, day.getDate()].map((n) => String(n).padStart(2, "0")).join("-");
  return `ommesh-key-${name}-${date}.json`;
}

export interface FoundKey {
  privateKey: Uint8Array;
  /** Worked out from the private key, never taken from the file. */
  publicKey: string;
  /** The radio's name, when a file of ours said it. */
  name: string | null;
  /** When the file was saved, ms; null for bare hex. */
  saved: number | null;
}

/**
 * Why a text is no key: nothing in it; a file that is not ours or is a newer
 * version; hex with other characters in it, or the wrong number of digits
 * (`digits` says how many); a key the radio would refuse.
 */
export type KeyFault = { fault: "empty" | "notKey" | "newer" | "notHex" | "shape" | "prefix" } | { fault: "length"; digits: number };

/** The hex digits of a pasted key: spaces and line breaks dropped, as copying from a console leaves them. */
export function keyDigits(text: string): string {
  return text.replace(/\s+/g, "").replace(/^0x/i, "");
}

/** The key in a file's text or in pasted text. */
export function readKey(text: string): FoundKey | KeyFault {
  const trimmed = text.trim();
  if (!trimmed) return { fault: "empty" };
  if (trimmed.startsWith("{")) return readKeyFile(trimmed);
  return fromDigits(keyDigits(trimmed), null, null);
}

function readKeyFile(text: string): FoundKey | KeyFault {
  let file: unknown;
  try {
    file = JSON.parse(text);
  } catch {
    return { fault: "notKey" };
  }
  if (!file || typeof file !== "object") return { fault: "notKey" };
  // A copy of the whole radio carries the key as this file does, beside the rest.
  if ((file as { format?: unknown }).format === "ommesh-backup") {
    const { key, saved } = file as { key?: unknown; saved?: unknown };
    if (!key || typeof key !== "object") return { fault: "notKey" };
    file = { ...key, format: KEY_FORMAT, saved };
  }
  const { format, version, privateKey, name, saved } = file as Partial<Record<keyof KeyFile, unknown>>;
  if (format !== KEY_FORMAT || typeof privateKey !== "string") return { fault: "notKey" };
  if (typeof version === "number" && version > KEY_VERSION) return { fault: "newer" };
  const at = typeof saved === "string" ? Date.parse(saved) : NaN;
  return fromDigits(keyDigits(privateKey), typeof name === "string" && name ? name : null, Number.isFinite(at) ? at : null);
}

/** A key from its hex digits, checked as the radio checks one; a radio's copy carries its key so. */
export function fromDigits(digits: string, name: string | null, saved: number | null): FoundKey | KeyFault {
  if (!/^[0-9a-f]*$/i.test(digits)) return { fault: "notHex" };
  if (digits.length !== KEY_DIGITS) return { fault: "length", digits: digits.length };
  const privateKey = fromHex(digits.toLowerCase());
  const fault = privateKeyFault(privateKey);
  if (fault) return { fault };
  return { privateKey, publicKey: toHex(publicKeyOf(privateKey)), name, saved };
}

export function isFault(found: FoundKey | KeyFault): found is KeyFault {
  return "fault" in found;
}
