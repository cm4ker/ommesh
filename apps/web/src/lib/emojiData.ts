import { useEffect, useState } from "react";
import { fold } from "./messageSearch.js";

/**
 * Every emoji a reaction can be chosen from, with its name and search words in
 * the reader's language. They come from Unicode's own names (scripts/emoji.mjs
 * writes `src/emoji/<lang>.json`), up to Emoji 14 and without flags, and are
 * loaded only when the full list is first opened: about 45 KB a language that
 * a start of the app has no need of.
 */

/** Unicode's groups, in its order, under the names the app gives them. */
export const UNICODE_GROUPS = ["faces", "people", "nature", "food", "travel", "activity", "objects", "symbols"] as const;
export type UnicodeGroup = (typeof UNICODE_GROUPS)[number];

/** The file's shape: per group, each emoji as [emoji, name, search words]. */
export type RawEmoji = Record<UnicodeGroup, string[][]>;

export interface EmojiEntry {
  emoji: string;
  name: string;
  /** The name, folded as a query is. */
  key: string;
  /** The name's words and the search words, folded the same way. */
  words: string[];
}

export interface EmojiData {
  groups: { id: UnicodeGroup; items: EmojiEntry[] }[];
  byEmoji: Map<string, EmojiEntry>;
}

export function parseEmojiData(raw: RawEmoji): EmojiData {
  const byEmoji = new Map<string, EmojiEntry>();
  const groups = UNICODE_GROUPS.map((id) => ({
    id,
    items: (raw[id] ?? []).map(([emoji = "", name = "", words = ""]) => {
      const entry = { emoji, name, key: fold(name), words: [...new Set(fold(`${name} ${words}`).split(/[\s,:()«»"]+/).filter(Boolean))] };
      byEmoji.set(emoji, entry);
      return entry;
    }),
  }));
  return { groups, byEmoji };
}

/**
 * The emoji whose name or words start with every word of the query, those
 * whose name starts with it first, each group's order kept otherwise.
 */
export function searchEmoji(data: EmojiData, query: string): EmojiEntry[] {
  const terms = fold(query).split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  const named: EmojiEntry[] = [];
  const tagged: EmojiEntry[] = [];
  const head = fold(query.trim());
  for (const group of data.groups) {
    for (const entry of group.items) {
      if (!terms.every((term) => entry.words.some((word) => word.startsWith(term)))) continue;
      (entry.key.startsWith(head) ? named : tagged).push(entry);
    }
  }
  return [...named, ...tagged];
}

/** An emoji's name with a capital, as it heads a line: "Огонь". */
export function emojiName(data: EmojiData | null, emoji: string): string | null {
  const name = data?.byEmoji.get(emoji)?.name;
  return name ? name[0]!.toUpperCase() + name.slice(1) : null;
}

const loaders: Record<string, () => Promise<{ default: RawEmoji }>> = {
  en: () => import("../emoji/en.json"),
  ru: () => import("../emoji/ru.json"),
};
const loaded = new Map<string, EmojiData>();
const loading = new Map<string, Promise<EmojiData>>();

/** The emoji named in `lang`, or in English when the app has none in it. */
export function loadEmoji(lang: string): Promise<EmojiData> {
  const code = lang in loaders ? lang : "en";
  let promise = loading.get(code);
  if (!promise) {
    promise = loaders[code]!().then((module) => {
      const data = parseEmojiData(module.default);
      loaded.set(code, data);
      return data;
    });
    // A failed load, offline in a browser tab say, is tried again the next time.
    promise.catch(() => loading.delete(code));
    loading.set(code, promise);
  }
  return promise;
}

/** The emoji in `lang` once loaded, starting the load; null until then. */
export function useEmojiData(lang: string): EmojiData | null {
  const code = lang in loaders ? lang : "en";
  const [data, setData] = useState<EmojiData | null>(() => loaded.get(code) ?? null);
  useEffect(() => {
    let live = true;
    if (loaded.get(code)) setData(loaded.get(code)!);
    else loadEmoji(code).then((d) => live && setData(d), () => undefined);
    return () => {
      live = false;
    };
  }, [code]);
  return data;
}
