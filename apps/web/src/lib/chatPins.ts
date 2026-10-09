/**
 * Chats pinned to the top of the chat list. Kept on this device and apart for
 * each radio, as drafts are: a channel's slot names a different channel on
 * another radio. The radio knows nothing of them and nothing goes on the air,
 * so a phone and a computer on the same radio each pin their own.
 *
 * A radio nobody has pinned anything for has Public pinned, the channel most
 * radios talk on. Once the reader pins or unpins anything, the radio's pins
 * are written down whole, Public among them or not, so an unpinned Public
 * stays unpinned.
 */

import { useSyncExternalStore } from "react";
import { channelConversation, type ChannelRecord } from "@meshnet/meshcore";
import { isPublicChannel } from "./channels.js";
import type { ConversationSummary } from "./conversations.js";
import { readSetting, writeSetting } from "./storage.js";

export interface Pin {
  /** When it was pinned: the latest pinned stands first. */
  at: number;
  /** A channel's name when it was pinned: another channel written into the slot is not pinned. */
  name?: string;
}

/** One radio's pins, by conversation. */
export type RadioPins = Record<string, Pin>;

type PinRow = Pick<ConversationSummary, "id" | "channel">;

const KEY = "meshnet.pins";
let pins: Record<string, RadioPins> = readSetting<Record<string, RadioPins>>(KEY, {});
const listeners = new Set<() => void>();

/** A radio's pins: the ones written down, or Public alone for a radio nobody has pinned anything for. */
export function radioPins(stored: RadioPins | undefined, channels: readonly ChannelRecord[]): RadioPins {
  if (stored) return stored;
  const pub = channels.find(isPublicChannel);
  return pub ? { [channelConversation(pub.index)]: { at: 0, name: pub.name } } : {};
}

/** When a row was pinned, or null. A channel's pin holds while its slot keeps the name it had. */
export function pinnedAt(pins: RadioPins, row: PinRow): number | null {
  const pin = pins[row.id];
  if (!pin) return null;
  if (pin.name !== undefined && row.channel?.name !== pin.name) return null;
  return pin.at;
}

export function getPins(radio: string, channels: readonly ChannelRecord[]): RadioPins {
  return radioPins(pins[radio], channels);
}

export function setPinned(radio: string, channels: readonly ChannelRecord[], row: PinRow, on: boolean): void {
  const mine = { ...radioPins(pins[radio], channels) };
  if (on) mine[row.id] = row.channel ? { at: Date.now(), name: row.channel.name } : { at: Date.now() };
  else delete mine[row.id];
  pins = { ...pins, [radio]: mine };
  writeSetting(KEY, pins);
  for (const listener of listeners) listener();
}

export function subscribePins(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Every radio's pins as written down; `radioPins` reads one radio's out of them. */
export function usePinStore(): Record<string, RadioPins> {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => pins,
  );
}
