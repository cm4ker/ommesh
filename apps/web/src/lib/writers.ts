/**
 * Who writes in a channel (#64). A channel has no list of members: a message
 * on it carries only the name before the colon, under the channel's key, and
 * whoever only reads sends nothing. So the list is of those who wrote, from
 * the history this device holds, one row per name. Two people under one name
 * are one row; a person who changed their name is two.
 */

import type { MessageRecord } from "@meshnet/meshcore";
import { fold } from "./messageSearch.js";

export interface Writer {
  name: string;
  /** How many of their messages the history holds. */
  count: number;
  /** When their latest came in, local ms. */
  lastAt: number;
  /** Their latest message: how far it came, how loud, and the way it took. */
  last: MessageRecord;
}

/** Everyone who wrote among these messages, the latest to write first; `me` is left out. */
export function writersIn(messages: readonly MessageRecord[], me: string | null): Writer[] {
  const byName = new Map<string, Writer>();
  for (const m of messages) {
    if (m.direction !== "in" || !m.sender || m.sender === me) continue;
    const seen = byName.get(m.sender);
    if (!seen) byName.set(m.sender, { name: m.sender, count: 1, lastAt: m.receivedAt, last: m });
    else {
      seen.count++;
      if (m.receivedAt >= seen.lastAt) {
        seen.lastAt = m.receivedAt;
        seen.last = m;
      }
    }
  }
  return [...byName.values()].sort((a, b) => b.lastAt - a.lastAt);
}

/** The writers whose name holds the query, read as the message search reads, lookalike letters and all. */
export function findWriters(writers: readonly Writer[], query: string): Writer[] {
  const q = fold(query.trim());
  return q ? writers.filter((w) => fold(w.name).includes(q)) : [...writers];
}
