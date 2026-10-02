/**
 * Finding words in messages (#42): in every chat from the field over the chat
 * list, in one chat from its own field. Case and ё aside, so "мост" finds
 * "Моста". Pure, over the session's messages, which are all in memory.
 */

import type { MessageRecord } from "@meshnet/meshcore";
import { placedAt } from "./conversations.js";
import { TWINS } from "./lookalikes.js";

/** A shorter query finds too much to be of use; two code units still let one emoji through. */
export const MIN_QUERY = 2;

// Russian goes out with its Latin lookalikes (lookalikes.ts), from this app and from others, so
// a Cyrillic letter and its twin are read as the twin: "мост" finds "Mocт". A capital's twin
// counts for its small letter too, as В goes out as B and so в is read as b.
const SAME: Record<string, string> = { ё: "e" };
for (const [cyrillic, latin] of Object.entries(TWINS)) SAME[cyrillic.toLowerCase()] = latin.toLowerCase();

/**
 * Lower case, ё as е, a lookalike as its Latin twin; letter for letter, so a
 * place in the result is the same place in the text.
 */
export function fold(text: string): string {
  let out = "";
  for (const ch of text) {
    const low = ch.toLowerCase();
    out += low.length === ch.length ? (SAME[low] ?? low) : ch;
  }
  return out;
}

/** The query as it is matched, or null while it is too short to search. */
export function searchTerm(query: string): string | null {
  const q = fold(query.trim());
  return q.length >= MIN_QUERY ? q : null;
}

// A record is replaced, never changed, when anything about the message changes.
const folded = new WeakMap<MessageRecord, string>();
function foldedText(m: MessageRecord): string {
  let text = folded.get(m);
  if (text === undefined) {
    text = fold(m.text);
    folded.set(m, text);
  }
  return text;
}

/** The messages holding the query, the newest first. */
export function findMessages(messages: readonly MessageRecord[], query: string): MessageRecord[] {
  const q = searchTerm(query);
  if (!q) return [];
  return messages.filter((m) => foldedText(m).includes(q)).sort((a, b) => placedAt(b) - placedAt(a));
}

/**
 * One sender's messages in a channel or a room, the newest first: all of them, or with a query
 * long enough to search, those holding it (#64).
 */
export function messagesFrom(messages: readonly MessageRecord[], sender: string, query: string): MessageRecord[] {
  const q = searchTerm(query);
  return messages.filter((m) => m.direction === "in" && m.sender === sender && (!q || foldedText(m).includes(q))).sort((a, b) => placedAt(b) - placedAt(a));
}

/** Where the query stands in a text: start and end of each place, in order, none overlapping. */
export function matchRanges(text: string, query: string): [number, number][] {
  const q = searchTerm(query);
  if (!q) return [];
  const hay = fold(text);
  const out: [number, number][] = [];
  for (let i = hay.indexOf(q); i >= 0; i = hay.indexOf(q, i + q.length)) out.push([i, i + q.length]);
  return out;
}

/**
 * A result's text, from a word or two before its first match, so the one
 * line the list gives it shows the word.
 */
export function snippet(text: string, query: string, lead = 24): string {
  const first = matchRanges(text, query)[0]?.[0];
  if (first === undefined || first <= lead) return text;
  const back = first - 16;
  const space = text.slice(back, first).search(/\s\S/);
  let from = space >= 0 ? back + space + 1 : back;
  // Not in the middle of an emoji.
  const code = text.charCodeAt(from);
  if (code >= 0xdc00 && code <= 0xdfff) from++;
  return `…${text.slice(from)}`;
}
