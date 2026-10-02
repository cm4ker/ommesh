/**
 * Who writes in a channel (#64). A channel has no list of members: a message
 * on it carries only the name before the colon, under the channel's key, and
 * whoever only reads sends nothing. So the list is of those who wrote, from
 * the history this device holds, one row per name. Two people under one name
 * are one row; a person who changed their name is two.
 */

import type { MessageRecord } from "@meshnet/meshcore";
import { placedAt } from "./conversations.js";
import { fold } from "./messageSearch.js";

export interface Writer {
  name: string;
  /** Written from this radio: our own messages, under the name it had when each went. */
  mine: boolean;
  /** How many of their messages the history holds. */
  count: number;
  /** When their latest came in, or ours went, local ms. */
  lastAt: number;
  /** Their latest message: how far it came, how loud, and the way it took. */
  last: MessageRecord;
}

/**
 * Everyone who wrote among these messages, the latest to write first, this
 * radio among them. Someone else heard under our name is a row of their own.
 */
export function writersIn(messages: readonly MessageRecord[]): Writer[] {
  const rows = new Map<string, Writer>();
  for (const m of messages) {
    if (!m.sender) continue;
    const mine = m.direction === "out";
    const key = `${mine ? "out" : "in"}:${m.sender}`;
    const at = placedAt(m);
    const seen = rows.get(key);
    if (!seen) rows.set(key, { name: m.sender, mine, count: 1, lastAt: at, last: m });
    else {
      seen.count++;
      if (at >= seen.lastAt) {
        seen.lastAt = at;
        seen.last = m;
      }
    }
  }
  return [...rows.values()].sort((a, b) => b.lastAt - a.lastAt);
}

/** The writers whose name holds the query, read as the message search reads, lookalike letters and all. */
export function findWriters(writers: readonly Writer[], query: string): Writer[] {
  const q = fold(query.trim());
  return q ? writers.filter((w) => fold(w.name).includes(q)) : [...writers];
}
