/**
 * Cyrillic letters that look like Latin ones go out as their Latin twins: in
 * UTF-8 the Cyrillic takes two bytes and the Latin one, so a message of 160
 * bytes carries about a fifth more Russian, and reads the same at the other
 * end. The first set matches in every common typeface. The writer may add the
 * letters that are only nearly alike, and those alike as written by hand: the
 * three sets together are what MCO Advanced swaps in its standard and
 * extended sets.
 *
 * What other apps swap can be read back: a Latin twin among Cyrillic letters
 * is shown as the letter it stands for, so "3uмa" reads "Зима".
 */

import { useMemo, useSyncExternalStore } from "react";
import { readSetting, writeSetting } from "./storage.js";

const EXACT: Record<string, string> = {
  а: "a",
  е: "e",
  о: "o",
  р: "p",
  с: "c",
  х: "x",
  і: "i",
  А: "A",
  В: "B",
  Е: "E",
  К: "K",
  М: "M",
  Н: "H",
  О: "O",
  Р: "P",
  С: "C",
  Т: "T",
  Х: "X",
  І: "I",
};

/**
 * Alike in most typefaces, not in every one: the Cyrillic у has a straighter tail in some, ё
 * loses its dots, З is read as a 3 and Ь as a b.
 */
const NEAR: Record<string, string> = { у: "y", У: "Y", ё: "e", Ё: "E", З: "3", Ь: "b" };

/** Alike as written by hand and in some italics; in print the difference shows. */
const CURSIVE: Record<string, string> = { т: "m", п: "n", и: "u" };

/**
 * The letters a search reads as their Latin twins. т, п and и are not among them: т would be read
 * as both T and m, and "мост" would find "тост". The search reads a word with them as Cyrillic
 * first (`asCyrillic`).
 */
export const TWINS: Readonly<Record<string, string>> = { ...EXACT, ...NEAR };

export interface LookalikePrefs {
  on: boolean;
  /** Also the letters only nearly alike. */
  near: boolean;
  /** Also those alike as written by hand. */
  cursive: boolean;
  /** Latin twins among Cyrillic letters are shown as Cyrillic. */
  read: boolean;
}

/** Every set, for one message too long without them. */
export const ALL_SETS: Pick<LookalikePrefs, "on" | "near" | "cursive"> = { on: true, near: true, cursive: true };

// A mention names someone as they call themselves: with its letters swapped, the apps that look for
// it would no longer find them. MCO Advanced leaves mentions as typed too.
const MENTION = /(@\[[^\]\n]{1,32}\])/;

export function packLookalikes(text: string, prefs: Pick<LookalikePrefs, "on" | "near" | "cursive">): string {
  if (!prefs.on) return text;
  return text
    .split(MENTION)
    .map((part, i) => (i % 2 === 1 ? part : swap(part, prefs)))
    .join("");
}

function swap(text: string, prefs: Pick<LookalikePrefs, "near" | "cursive">): string {
  let out = "";
  for (const c of text) out += EXACT[c] ?? (prefs.near ? NEAR[c] : undefined) ?? (prefs.cursive ? CURSIVE[c] : undefined) ?? c;
  return out;
}

/** Whether a letter goes out looking different: one of the sets past the first. */
export function looksDifferent(c: string): boolean {
  return c in NEAR || c in CURSIVE;
}

// Back from Latin to Cyrillic, every set at once: a message may come from an app that swaps more
// than this one is set to. Where two letters share a twin, as е and ё do, the first set's is read.
const BACK: Record<string, string> = {};
for (const set of [CURSIVE, NEAR, EXACT]) for (const [cyrillic, latin] of Object.entries(set)) BACK[latin] = cyrillic;

// Left as they are: a mention names someone as they call themselves, and an address has to lead
// where it did.
const KEEP = /@\[[^\]\n]{1,32}\]|(?:[Hh]ttps?:\/\/|[Ww]ww\.)\S+/g;
const WORD = /[\p{L}\p{N}]+/gu;
const CYRILLIC = /\p{Script=Cyrillic}/u;
const LATIN = /[A-Za-z]/;
const VOWEL = /[аеёиоуыэюяіaeiouyАЕЁИОУЫЭЮЯІAEIOUY]/;
// What a sentence starts after: its end, a line's start, a quote's ">", an opening quote or bracket.
const OPENING = /(?:^|[.!?…\n>«"(])[ \t]*$/;

interface Word {
  start: number;
  text: string;
  /** Read back, or null when it holds Latin that is no twin. */
  back: string | null;
  /** It holds a Cyrillic letter print tells from Latin, so it is Russian for sure. */
  cyrillic: boolean;
}

// A word whose Cyrillic letters all have exact twins may as well be Latin typed with a lookalike,
// as "Рin" is with a Cyrillic Р.
const russian = (word: string) => Array.from(word).some((c) => CYRILLIC.test(c) && !(c in EXACT));

/**
 * The text with the Latin twins of Cyrillic letters read back as Cyrillic, letter for letter, so a
 * place in the result is the same place in the text. A word with a Cyrillic letter print tells
 * from Latin is read back whole, as long as each Latin letter in it is a twin. A word in Latin twins
 * alone, as "mpu" for "три", is read back only next to such a word: on its own it may be English.
 */
export function asCyrillic(text: string): string {
  if (!CYRILLIC.test(text)) return text;
  // The words, with a gap where a mention or an address stands between them.
  const words: (Word | null)[] = [];
  let at = 0;
  const take = (end: number) => {
    const part = text.slice(at, end);
    for (const m of part.matchAll(WORD)) {
      const start = at + (m.index ?? 0);
      const cyrillic = russian(m[0]);
      words.push({ start, text: m[0], back: readBack(m[0], cyrillic, OPENING.test(text.slice(0, start))), cyrillic });
    }
  };
  for (const keep of text.matchAll(KEEP)) {
    take(keep.index ?? 0);
    words.push(null);
    at = (keep.index ?? 0) + keep[0].length;
  }
  take(text.length);

  const latinOnly = (w: Word | null | undefined): w is Word => !!w && !w.cyrillic && w.back !== null && w.back !== w.text;
  const back: Word[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (!w || w.back === null || w.back === w.text) continue;
    if (w.cyrillic) {
      back.push(w);
      continue;
    }
    // A run of words in Latin twins alone, read back together when a Cyrillic word stands at either end.
    let end = i;
    while (latinOnly(words[end + 1])) end++;
    if (words[i - 1]?.cyrillic || words[end + 1]?.cyrillic) for (let k = i; k <= end; k++) back.push(words[k]!);
    i = end;
  }
  if (back.length === 0) return text;
  let out = "";
  let from = 0;
  for (const w of back) {
    out += text.slice(from, w.start) + w.back;
    from = w.start + w.text.length;
  }
  return out + text.slice(from);
}

/** A word with its twins read back, or null when a Latin letter in it is no twin. */
function readBack(word: string, cyrillic: boolean, opening: boolean): string | null {
  const chars = Array.from(word);
  const letters = chars.filter((c) => !/\d/.test(c));
  // Ь goes out as b only among capitals, as in ДРУЗbЯ; a b among small letters, or on its own, is a b.
  const capitals = letters.some((c) => c !== "b") && letters.every((c) => c === "b" || c === c.toUpperCase());
  if (!cyrillic) {
    // Without a Cyrillic letter, a word with a digit is a name or a number, as T114 and 3A are,
    // unless it starts with a 3 that reads as З. An i beside m, n or u is English: Russian has no і.
    if (letters.length === 0 || chars.some((c, i) => /\d/.test(c) && (i > 0 || !threeIsZe(chars, 0, capitals, opening)))) return null;
    if (letters.includes("i") && letters.some((c) => c === "m" || c === "n" || c === "u")) return null;
  }
  let out = "";
  for (const [i, c] of chars.entries()) {
    if (c === "3") out += threeIsZe(chars, i, capitals, opening) ? "З" : c;
    else if (!LATIN.test(c)) out += c;
    else {
      const back = c === "b" && !capitals ? undefined : BACK[c];
      if (back === undefined) return null;
      out += back;
    }
  }
  return out;
}

/**
 * Whether a 3 stands for З. A number glued to its unit keeps its digit, as in 3км, 3шт or 3ГБ, so
 * a 3 is read as З in a word written in capitals of three letters or more with a vowel among
 * them, as 3BE3ДA, and otherwise only where it starts a word of small letters with a vowel in it,
 * before a vowel or at the start of a sentence: 3uмa, 3дecь.
 */
function threeIsZe(chars: string[], at: number, capitals: boolean, opening: boolean): boolean {
  if (chars.some((c) => /\d/.test(c) && c !== "3")) return false;
  const rest = chars.filter((c) => c !== "3");
  if (!rest.some((c) => VOWEL.test(c))) return false;
  if (capitals) return rest.length >= 3;
  const next = chars[at + 1];
  return at === 0 && next !== undefined && next !== next.toUpperCase() && (VOWEL.test(next) || opening);
}

const KEY = "meshnet.lookalikes";
let prefs: LookalikePrefs = { on: true, near: false, cursive: false, read: true, ...readSetting<Partial<LookalikePrefs>>(KEY, {}) };
const listeners = new Set<() => void>();

export function getLookalikePrefs(): LookalikePrefs {
  return prefs;
}

export function setLookalikePrefs(patch: Partial<LookalikePrefs>): void {
  prefs = { ...prefs, ...patch };
  writeSetting(KEY, prefs);
  for (const listener of listeners) listener();
}

export function useLookalikePrefs(): LookalikePrefs {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => prefs,
  );
}

/** A message's text as it is shown: read back as Cyrillic unless the reader turned that off. */
export function shownText(text: string): string {
  return prefs.read ? asCyrillic(text) : text;
}

export function useShownText(text: string): string {
  const { read } = useLookalikePrefs();
  return useMemo(() => (read ? asCyrillic(text) : text), [read, text]);
}
