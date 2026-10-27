/** Channels as the chats see them: where a new one goes, the key it starts with, and who can read it. */

import { channelConversation, KEYLESS_CONVERSATION, toHex, type ChannelRecord, type SessionState } from "@meshnet/meshcore";
import { sha256 } from "./sha256.js";

/** The key of "Public", the channel every radio starts with. */
const PUBLIC_SECRET = "8b3387e9c5cdea6ac9e5edbaa115cd72";

/** Whether a channel is Public itself, told by its key: a rename keeps it Public. */
export function isPublicChannel(channel: Pick<ChannelRecord, "secret">): boolean {
  return channel.secret.toLowerCase() === PUBLIC_SECRET;
}

/**
 * The slot a new channel goes to, or -1 when the radio has none free. A chat
 * is its channel's slot, and a channel taken off leaves its history there: the
 * channel's own slot is taken when it comes back, else one with nothing left
 * in it, so a new channel seldom pushes out another's history.
 */
export function freeChannelIndex(state: Pick<SessionState, "channels" | "device" | "chatKeys" | "messages">, secret?: string): number {
  const used = new Set(state.channels.map((c) => c.index));
  const max = state.device?.maxChannels ?? 8;
  const free = Array.from({ length: max }, (_, i) => i).filter((i) => !used.has(i));
  if (!free.length) return -1;
  const own = secret ? free.find((i) => state.chatKeys[channelConversation(i)] === secret.toLowerCase()) : undefined;
  if (own !== undefined) return own;
  const written = new Set(state.messages.map((m) => m.conversation));
  return free.find((i) => !written.has(channelConversation(i))) ?? free[0]!;
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

/** Who can read a channel: anyone, only those it was handed to, or any radio at all for messages without a key. */
export type ChannelAccess = "public" | "private" | "keyless";

/**
 * "public" for Public and for a channel keyed by its name, as "#berlin" is,
 * since anyone who knows the name has the key; "private" for a key that was
 * made up and passed round. A channel the radio no longer lists counts as
 * public, the safer thing to tell the reader.
 */
export function channelAccess(channel: Pick<ChannelRecord, "name" | "secret"> | null | undefined): ChannelAccess {
  if (!channel) return "public";
  if (isPublicChannel(channel)) return "public";
  const secret = channel.secret.toLowerCase();
  // Folded as this app keys a name, or with its case as another app may have kept it; a rename keeps the key, so "#" may be gone.
  const bare = channel.name.trim().replace(/^#+/, "");
  const names = [`#${bare}`, hashtagName(bare)];
  return names.some((name) => name !== null && hashtagSecret(name) === secret) ? "public" : "private";
}

/** A channel chat's access: by its channel, but for the chat without a key, which has none to tell by. */
export function chatAccess(conversation: string, channel: Pick<ChannelRecord, "name" | "secret"> | null | undefined): ChannelAccess {
  return conversation === KEYLESS_CONVERSATION ? "keyless" : channelAccess(channel);
}

/** The same, the channel looked up among the radio's. */
export function conversationAccess(conversation: string, channels: readonly ChannelRecord[]): ChannelAccess {
  return chatAccess(conversation, channels.find((c) => channelConversation(c.index) === conversation));
}
