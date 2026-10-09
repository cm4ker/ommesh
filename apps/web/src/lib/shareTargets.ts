/**
 * Which chats the phone's share sheet offers by name (#88): the pinned ones,
 * the latest pinned first as in the list, then the ones last written in. Only
 * chats that take a message: a channel in a slot of the radio, a person or a
 * room the radio knows.
 */

import { AdvType, type MessageRecord } from "@meshnet/meshcore";
import { pinnedAt, type RadioPins } from "./chatPins.js";
import { placedAt, type ConversationSummary } from "./conversations.js";

/** As many as both share sheets show in their row of people. */
export const SHARE_TARGETS = 4;

function writable(row: ConversationSummary): boolean {
  if (row.kind === "channel") return row.channel !== null;
  if (row.kind === "contact") return row.contact !== null && (row.contact.type === AdvType.Chat || row.contact.type === AdvType.Room);
  return false;
}

export function shareTargets(rows: readonly ConversationSummary[], pins: RadioPins, messages: readonly MessageRecord[], max = SHARE_TARGETS): ConversationSummary[] {
  const sent = new Map<string, number>();
  for (const m of messages) {
    if (m.direction !== "out") continue;
    const at = placedAt(m);
    if (at > (sent.get(m.conversation) ?? 0)) sent.set(m.conversation, at);
  }
  const open = rows.filter(writable);
  const pinned = open
    .map((row) => ({ row, at: pinnedAt(pins, row) }))
    .filter((p): p is { row: ConversationSummary; at: number } => p.at !== null)
    .sort((a, b) => b.at - a.at)
    .map((p) => p.row);
  const written = open.filter((row) => sent.has(row.id) && !pinned.includes(row)).sort((a, b) => sent.get(b.id)! - sent.get(a.id)!);
  return [...pinned, ...written].slice(0, max);
}
