/**
 * The message a reply answers (#32). MeshCore has no field for it, so a reply
 * names it in its text: whom it answers, by the mention it opens with, and the
 * start of what they said, on a line that begins with ">". Ommesh and MCO
 * Advanced write `@[Name] >start...` and the reply under it; MeshCore One and
 * MeshTrax put the quote on a line of its own under the mention and cut it
 * with two dots; the official app sends the mention alone.
 *
 * The message answered is the latest one of that sender, before the reply,
 * that starts with the quote, as MCO Advanced finds it. A quote with no dots
 * is a whole message. A mention alone says only whom: their latest message is
 * a guess, and the reader is shown their others to pick from.
 */

import { TxtType, type MessageRecord } from "@meshnet/meshcore";
import { quoteSource, translit } from "./composer.js";
import { fold } from "./messageSearch.js";

export interface ReplyHead {
  /** Whom the reply answers: the name in its mention. */
  name: string;
  /** What stands between the mention and the quote, or the rest after a mention alone. */
  gap: string;
  /** The start of the message answered, as quoted; null for a mention alone. */
  quote: string | null;
  /** How much of the text the head takes: a quote's line break with it. */
  length: number;
}

const QUOTED = /^@\[([^\]\n]{1,32})\]([ \n])>([^\n]+)\n/;
// MeshMonitor puts a colon after the mention.
const NAMED = /^@\[([^\]\n]{1,32})\](:? ?)(?=\S)/;

/** How a reply opens, or null for a message that does not open with a mention. */
export function replyHead(text: string): ReplyHead | null {
  const quoted = QUOTED.exec(text);
  if (quoted) return { name: quoted[1]!, gap: quoted[2]!, quote: quoted[3]!, length: quoted[0].length };
  const named = NAMED.exec(text);
  return named ? { name: named[1]!, gap: named[2]!, quote: null, length: named[0].length } : null;
}

export type Source =
  /** The message answered, as named by the quote, or as we wrote the reply. */
  | { kind: "found"; id: string }
  /** No quote to go by: the latest message of the one named before the reply, and whose they are. */
  | { kind: "guess"; id: string; name: string; mine: boolean }
  /** Nothing of theirs here fits; `theirs` when they have other messages to look through. */
  | { kind: "missing"; name: string; mine: boolean; theirs: boolean };

// Where a quote stops short: our three dots, MeshCore One's two, and the "…" Ommesh cut with before.
const CUT = /(?:\.{2,3}|…)$/;
// Left off both sides before a whole message is compared: a quote drops them before its dots.
const TRAILING = /[\s.,;:!?+-]+$/;

/**
 * Where a reply leads. `me` is this radio's name, for a reply to one of ours.
 * Null for a message that answers nobody.
 */
export function sourceOf(messages: readonly MessageRecord[], reply: MessageRecord, me: string | null): Source | null {
  if (reply.replyTo && messages.some((m) => m.id === reply.replyTo)) return { kind: "found", id: reply.replyTo };
  const head = replyHead(reply.text);
  if (!head) return null;
  const mine = me !== null && same(head.name, me);
  const at = messages.findIndex((m) => m.id === reply.id);
  const theirs: MessageRecord[] = [];
  for (let i = (at < 0 ? messages.length : at) - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.txtType === TxtType.CliCommand) continue;
    if (m.direction === "out" ? mine : m.sender !== null && same(m.sender, head.name)) theirs.push(m);
  }
  const quote = head.quote?.replace(/\s+/g, " ").trim() ?? "";
  const cut = CUT.test(quote);
  const needle = fold(quote.replace(CUT, "").replace(TRAILING, ""));
  if (!needle) {
    const latest = theirs[0];
    if (latest) return { kind: "guess", id: latest.id, name: latest.sender ?? head.name, mine: latest.direction === "out" };
    return { kind: "missing", name: head.name, mine, theirs: false };
  }
  // A cut quote starts its message; a whole one is all of it. One shortened by hand, or by a
  // client that marks no cut, still starts it, and is tried that way last.
  const tries: ((text: string) => boolean)[] = cut ? [(text) => text.startsWith(needle)] : [(text) => text.replace(TRAILING, "") === needle, (text) => text.startsWith(needle)];
  for (const fits of tries) {
    const found = theirs.find((m) => forms(m).some(fits));
    if (found) return { kind: "found", id: found.id };
  }
  return { kind: "missing", name: theirs[0]?.sender ?? head.name, mine, theirs: theirs.length > 0 };
}

/**
 * A message as a quote may have it: as it was written, and in Latin letters, for a quote
 * sent transliterated, as MCO Advanced can send one.
 */
function forms(m: MessageRecord): string[] {
  const text = quoteSource(m.text);
  const latin = translit(text);
  return latin === text ? [fold(text)] : [fold(text), fold(latin)];
}

/** Names alike but for case and lookalike letters. */
function same(a: string, b: string): boolean {
  return a === b || fold(a) === fold(b);
}
