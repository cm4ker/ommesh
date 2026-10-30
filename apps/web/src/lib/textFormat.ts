/**
 * Text formatting the way Telegram types it: `**bold**`, `__italic__`,
 * `~~struck~~`, `` `mono` ``, `||hidden||` and a ``` block of lines. The
 * markers go on the air as typed, so another MeshCore app shows them as they
 * are; Ommesh hides them and draws the text they mark.
 *
 * Only doubled markers count: a single `*` or `_` is too common in plain
 * writing, in numbers and in file names. A pair needs text right inside it, no
 * space on either inner edge, and its partner; anything else stays as typed.
 * Addresses, places and mentions come first: a marker inside one is part of it.
 * Nothing is formatted inside mono text.
 *
 * The phone's Rust core reads the markers the same way for the notices it raises while the page
 * sleeps (`crates/meshcore-core/src/format.rs`): change both together.
 */

import { MENTION } from "./composer.js";
import { PLACE_SOURCE } from "./place.js";
import { LINK, linkOf } from "./webLinks.js";

export type FormatKind = "bold" | "italic" | "strike" | "code" | "block" | "spoiler";

/** The markers, longest first where one starts another: a block's ``` before mono's `. */
const MARKS: readonly { mark: string; kind: FormatKind }[] = [
  { mark: "```", kind: "block" },
  { mark: "`", kind: "code" },
  { mark: "**", kind: "bold" },
  { mark: "__", kind: "italic" },
  { mark: "~~", kind: "strike" },
  { mark: "||", kind: "spoiler" },
];

/** What mono text and a block hold is the text as typed. */
const LITERAL: ReadonlySet<FormatKind> = new Set(["code", "block"]);

export type FormatNode =
  | { kind: "text"; text: string }
  | { kind: FormatKind; children: FormatNode[] };

/** Where a pair of markers stands: the opening one at `start`, the text between `inner` and `close`. */
interface Span {
  start: number;
  inner: number;
  close: number;
  end: number;
  kind: FormatKind;
}

/** A marker an address ends with closes a pair around it, as in `**https://…**`: it is no part of the address. */
const TRAILING_MARK = /(?:\*\*|__|~~|\|\||`)+$/;

/** An address as `LINK` matched it, without the sentence's punctuation and the markers after it, in any order. */
function bareLink(match: string): string {
  for (let text = match; ; ) {
    const next = (linkOf(text)?.text ?? text).replace(TRAILING_MARK, "");
    if (next === text) return text;
    text = next;
  }
}

/** The stretches no marker may fall into: mentions, places and web addresses. */
function protectedRanges(text: string): [number, number][] {
  const out: [number, number][] = [];
  const pattern = new RegExp(`${MENTION.source}|${PLACE_SOURCE}|${LINK.source}`, "gi");
  for (const m of text.matchAll(pattern)) {
    const start = m.index ?? 0;
    // A mention starts with @[, a place with geo:, m: or [; only an address with its scheme or www.
    const length = /^[@[gGmM]/.test(m[0]) ? m[0].length : bareLink(m[0]).length;
    out.push([start, start + length]);
  }
  return out;
}

function isSpace(ch: string | undefined): boolean {
  return ch === undefined || /\s/.test(ch);
}

/** The pair that opens first in `text` between `from` and `to`, or null. */
function firstSpan(text: string, from: number, to: number, guarded: [number, number][]): Span | null {
  const clear = (at: number, length: number) => !guarded.some(([a, b]) => a < at + length && at < b);
  let best: Span | null = null;
  for (const { mark, kind } of MARKS) {
    const n = mark.length;
    for (let i = text.indexOf(mark, from); i !== -1 && i + n <= to && (!best || i < best.start); i = text.indexOf(mark, i + 1)) {
      // Mono's single backtick is not one of a block's three.
      if (kind === "code" && (text[i - 1] === "`" || text[i + 1] === "`")) continue;
      if (!clear(i, n)) continue;
      const inner = i + n;
      if (kind !== "block" && isSpace(text[inner])) continue;
      let close = -1;
      for (let j = text.indexOf(mark, inner + 1); j !== -1 && j + n <= to; j = text.indexOf(mark, j + 1)) {
        if (kind === "code" && (text[j - 1] === "`" || text[j + 1] === "`")) continue;
        if (!clear(j, n)) continue;
        if (kind !== "block" && isSpace(text[j - 1])) continue;
        close = j;
        break;
      }
      if (close === -1) continue;
      // Mono text stays on its line; a block holds more than its line breaks.
      if (kind === "code" && text.slice(inner, close).includes("\n")) continue;
      if (kind === "block" && !text.slice(inner, close).trim()) continue;
      best = { start: i, inner, close, end: close + n, kind };
      break;
    }
  }
  return best;
}

function parseRange(text: string, from: number, to: number, guarded: [number, number][]): FormatNode[] {
  const out: FormatNode[] = [];
  let at = from;
  while (at < to) {
    const span = firstSpan(text, at, to, guarded);
    if (!span) {
      out.push({ kind: "text", text: text.slice(at, to) });
      break;
    }
    if (span.start > at) out.push({ kind: "text", text: text.slice(at, span.start) });
    const children = LITERAL.has(span.kind) ? [{ kind: "text" as const, text: text.slice(span.inner, span.close) }] : parseRange(text, span.inner, span.close, guarded);
    out.push({ kind: span.kind, children });
    at = span.end;
  }
  return out;
}

/** The text as runs of plain text and of formatting, the markers left out. Plain text gives one text node. */
export function parseFormat(text: string): FormatNode[] {
  if (!/\*\*|__|~~|\|\||`/.test(text)) return [{ kind: "text", text }];
  return parseRange(text, 0, text.length, protectedRanges(text));
}

/** What a hidden stretch reads as where it cannot be opened: a chat's row, a notice, a quote. */
export const HIDDEN = "▒▒▒";

function plainOf(nodes: FormatNode[]): string {
  return nodes
    .map((node) => {
      if (node.kind === "text") return node.text;
      if (node.kind === "spoiler") return HIDDEN;
      const inner = plainOf(node.children);
      return node.kind === "block" ? inner.replace(/^\n/, "").replace(/\n$/, "") : inner;
    })
    .join("");
}

/** The text without its markers, a hidden stretch as ▒▒▒: for the chat list, a notice and a reply's quote. */
export function plainText(text: string): string {
  return plainOf(parseFormat(text));
}

/** A stretch of typed text as the layer under the field marks it: a marker, or text and what marks it. */
export interface FormatRun {
  start: number;
  end: number;
  marker: boolean;
  kinds: readonly FormatKind[];
}

/** The typed text cut into runs of markers and of text with the formatting each is under, end to end. */
export function formatRuns(text: string): FormatRun[] {
  const out: FormatRun[] = [];
  const push = (start: number, end: number, marker: boolean, kinds: readonly FormatKind[]) => {
    if (end > start) out.push({ start, end, marker, kinds });
  };
  if (!/\*\*|__|~~|\|\||`/.test(text)) {
    push(0, text.length, false, []);
    return out;
  }
  const guarded = protectedRanges(text);
  const walk = (from: number, to: number, kinds: readonly FormatKind[]) => {
    let at = from;
    while (at < to) {
      const span = firstSpan(text, at, to, guarded);
      if (!span) {
        push(at, to, false, kinds);
        return;
      }
      push(at, span.start, false, kinds);
      const inside = [...kinds, span.kind];
      push(span.start, span.inner, true, kinds);
      if (LITERAL.has(span.kind)) push(span.inner, span.close, false, inside);
      else walk(span.inner, span.close, inside);
      push(span.close, span.end, true, kinds);
      at = span.end;
    }
  };
  walk(0, text.length, []);
  return out;
}

/** What the composer's menu and keys put round a selection; `code` becomes a block over several lines. */
export type FormatChoice = "bold" | "italic" | "strike" | "code" | "spoiler";

const MARK_OF: Record<Exclude<FormatChoice, "code">, string> = { bold: "**", italic: "__", strike: "~~", spoiler: "||" };

/**
 * The text with the selection from `start` to `end` put in markers, and the
 * selection on the same words after; null when nothing but spaces is selected.
 * Markers already round the selection, just outside it or at its edges, are
 * taken off instead. Spaces at the selection's edges stay outside the markers,
 * where a pair still counts.
 */
export function toggleFormat(text: string, start: number, end: number, choice: FormatChoice): { text: string; start: number; end: number } | null {
  if (start === end) return null;
  const picked = text.slice(start, end);
  const mark = choice === "code" ? (picked.includes("\n") ? "```" : "`") : MARK_OF[choice];
  const n = mark.length;
  const before = text.slice(0, start);
  const after = text.slice(end);
  if (before.endsWith(mark) && after.startsWith(mark)) return { text: before.slice(0, -n) + picked + after.slice(n), start: start - n, end: end - n };
  if (picked.length > 2 * n && picked.startsWith(mark) && picked.endsWith(mark)) return { text: before + picked.slice(n, -n) + after, start, end: end - 2 * n };
  const lead = /^\s*/.exec(picked)![0].length;
  const trail = /\s*$/.exec(picked)![0].length;
  const core = picked.slice(lead, picked.length - trail);
  if (!core) return null;
  // A block's markers stand on lines of their own.
  const open = mark === "```" ? `${mark}\n` : mark;
  const close = mark === "```" ? `\n${mark}` : mark;
  const from = start + lead + open.length;
  return { text: before + picked.slice(0, lead) + open + core + close + picked.slice(picked.length - trail) + after, start: from, end: from + core.length };
}

/** Which formatting the selection is already in, by the markers just outside it. */
export function formatAround(text: string, start: number, end: number, choice: FormatChoice): boolean {
  if (start === end) return false;
  const marks = choice === "code" ? ["`", "```"] : [MARK_OF[choice]];
  return marks.some((mark) => text.slice(0, start).endsWith(mark) && text.slice(end).startsWith(mark));
}

/** Every formatting the composer offers, in the order its menu lists them. */
export const FORMAT_CHOICES: readonly FormatChoice[] = ["bold", "italic", "strike", "code", "spoiler"];

const KEY_OF: Record<FormatChoice, { shift: boolean; key: string }> = {
  bold: { shift: false, key: "B" },
  italic: { shift: false, key: "I" },
  strike: { shift: true, key: "X" },
  code: { shift: true, key: "M" },
  spoiler: { shift: true, key: "P" },
};

/** How a menu writes a formatting's keys: Ctrl+Shift+X, or ⇧⌘X on a Mac. */
export function keysOf(choice: FormatChoice, mac: boolean): string {
  const { shift, key } = KEY_OF[choice];
  return mac ? `${shift ? "⇧" : ""}⌘${key}` : `Ctrl+${shift ? "Shift+" : ""}${key}`;
}

/** The formatting a key asks for, as Telegram Desktop binds them: Ctrl+B, Ctrl+I, Ctrl+Shift+X, M and P (⌘ on a Mac). */
export function formatKey(e: { key: string; code: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }): FormatChoice | null {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return null;
  // By the key's place, so a Russian layout's И is still B.
  if (!e.shiftKey) return e.code === "KeyB" ? "bold" : e.code === "KeyI" ? "italic" : null;
  return e.code === "KeyX" ? "strike" : e.code === "KeyM" ? "code" : e.code === "KeyP" ? "spoiler" : null;
}
