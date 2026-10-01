/** Channels as the chats see them: where a new one goes, the key it starts with, and who can read it. */

import { toHex, type ChannelRecord, type SessionState } from "@meshnet/meshcore";
import { sha256 } from "./sha256.js";

/** The key of "Public", the channel every radio starts with. */
const PUBLIC_SECRET = "8b3387e9c5cdea6ac9e5edbaa115cd72";

/** The first slot the radio has free, or -1. */
export function freeChannelIndex(state: SessionState): number {
  const used = new Set(state.channels.map((c) => c.index));
  const max = state.device?.maxChannels ?? 8;
  for (let i = 0; i < max; i++) if (!used.has(i)) return i;
  return -1;
}

export function randomSecret(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** A key as typed or pasted: spaces and dashes dropped, lower case; null unless it is 32 hex digits. */
export function parseSecret(text: string): string | null {
  const hex = text.replace(/[\s-]+/g, "").toLowerCase();
  return /^[0-9a-f]{32}$/.test(hex) ? hex : null;
}

/**
 * A public channel's name as it is keyed: one leading "#", lower case, no
 * spaces; null when nothing is left. Everyone who types "#Berlin" or "berlin"
 * lands on the same channel.
 */
export function hashtagName(text: string): string | null {
  const bare = text.trim().replace(/^#+/, "").replace(/\s+/g, "").toLowerCase();
  return bare ? `#${bare}` : null;
}

/** A public channel's key: the first 16 bytes of SHA-256 of its name, "#" included, as MeshCore derives it. */
export function hashtagSecret(name: string): string {
  return toHex(sha256(new TextEncoder().encode(name)).subarray(0, 16));
}

/** Who can read a channel: anyone, or only those it was handed to. */
export type ChannelAccess = "public" | "private";

/**
 * "public" for Public and for a channel keyed by its name, as "#berlin" is,
 * since anyone who knows the name has the key; "private" for a key that was
 * made up and passed round. A channel the radio no longer lists counts as
 * public, the safer thing to tell the reader.
 */
export function channelAccess(channel: Pick<ChannelRecord, "name" | "secret"> | null | undefined): ChannelAccess {
  if (!channel) return "public";
  const secret = channel.secret.toLowerCase();
  if (secret === PUBLIC_SECRET) return "public";
  // Folded as this app keys a name, or with its case as another app may have kept it; a rename keeps the key, so "#" may be gone.
  const bare = channel.name.trim().replace(/^#+/, "");
  const names = [`#${bare}`, hashtagName(bare)];
  return names.some((name) => name !== null && hashtagSecret(name) === secret) ? "public" : "private";
}
