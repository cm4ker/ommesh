/**
 * What each version brought: a file a stable version in src/news, which
 * scripts/news.mjs checks and turns into the texts for the stores, GitHub and
 * Telegram. The files ship with the app, so What's new reads with no network.
 * After an update the versions it brought stand behind one strip over the
 * chats until the strip is opened or closed. A version with fixes only puts
 * up no strip, and neither does a first install: nothing is new to someone
 * who has seen nothing yet.
 */

import { useSyncExternalStore } from "react";
import { language, locale } from "../i18n/index.js";
import { goSection, openRadioPage, push, RADIO_PAGES, type RadioPage } from "./nav.js";
import { readSetting, writeSetting } from "./storage.js";
import { baseVersion, compareVersions } from "./version.js";

export interface NewThing {
  title: string;
  text: string;
}

export type NewItem = { kind: "new"; show: string | null; words: Record<string, NewThing> };
export type FixItem = { kind: "fix"; words: Record<string, string> };
export type NewsItem = NewItem | FixItem;

export interface Release {
  version: string;
  /** YYYY-MM-DD. */
  date: string;
  items: NewsItem[];
}

/** The newest version whose news this app has put before its reader. */
const SEEN_KEY = "meshnet.news.seen";

const isThing = (value: unknown): value is NewThing => !!value && typeof (value as NewThing).title === "string" && typeof (value as NewThing).text === "string";

/**
 * A release as a news file or the desktop's and the APK's feed gives it. The
 * feed comes over the network, so anything malformed is left out, an item
 * without English among it; a release with nothing left is null.
 */
export function parseRelease(value: unknown): Release | null {
  if (!value || typeof value !== "object") return null;
  const { version, date, items } = value as { version?: unknown; date?: unknown; items?: unknown };
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) return null;
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Array.isArray(items)) return null;
  const parsed: NewsItem[] = [];
  for (const item of items as unknown[]) {
    if (!item || typeof item !== "object") continue;
    const { kind, show, ...languages } = item as Record<string, unknown>;
    if (kind === "new") {
      const words = Object.fromEntries(Object.entries(languages).filter(([, w]) => isThing(w)).map(([lang, w]) => [lang, { title: (w as NewThing).title, text: (w as NewThing).text }]));
      if (words["en"]) parsed.push({ kind: "new", show: typeof show === "string" ? show : null, words });
    } else if (kind === "fix") {
      const words = Object.fromEntries(Object.entries(languages).filter(([, w]) => typeof w === "string")) as Record<string, string>;
      if (words["en"]) parsed.push({ kind: "fix", words });
    }
  }
  return parsed.length ? { version, date, items: parsed } : null;
}

export const newThings = (release: Release): NewItem[] => release.items.filter((item): item is NewItem => item.kind === "new");
export const fixes = (release: Release): FixItem[] => release.items.filter((item): item is FixItem => item.kind === "fix");

/** The words in the reader's language, English where a language has none. */
function inLanguage<T>(words: Record<string, T>): T {
  const lang = language();
  return words[lang] ?? words[lang.split("-")[0]!] ?? words["en"]!;
}
export const thingWords = (item: NewItem): NewThing => inLanguage(item.words);
export const fixWords = (item: FixItem): string => inLanguage(item.words);

/** "8 October", with the year when it is not this one. */
export function releaseDay(date: string, now = new Date()): string {
  const [y = 0, m = 1, d = 1] = date.split("-").map(Number);
  return new Intl.DateTimeFormat(locale(), { day: "numeric", month: "long", ...(y === now.getFullYear() ? {} : { year: "numeric" }) }).format(new Date(y, m - 1, d));
}

/**
 * What a launch brings, against the newest version shown before (`seen`):
 * the versions What's new opens with, whether the strip goes up, and the
 * version to remember as seen now (null leaves it). `before` says whether the
 * app ran before this launch. With no version seen, an app that ran before
 * came from a build without news and shows its newest version once; a first
 * install remembers it and shows nothing.
 */
export function arrival(releases: Release[], seen: string | null, before: boolean): { fresh: string[]; strip: boolean; seen: string | null } {
  const newest = releases[0]?.version;
  if (!newest) return { fresh: [], strip: false, seen: null };
  if (seen === null && !before) return { fresh: [], strip: false, seen: newest };
  const fresh = releases.filter((r) => (seen === null ? r.version === newest : compareVersions(r.version, seen) > 0));
  const strip = fresh.some((r) => newThings(r).length > 0);
  // Fixes alone are told in What's new only, and count as seen from now on.
  return { fresh: fresh.map((r) => r.version), strip, seen: fresh.length > 0 && !strip ? newest : null };
}

export interface NewsState {
  /** The versions this build carries news of, newest first. */
  releases: Release[];
  /** Those this launch brought: What's new opens them. */
  fresh: string[];
  /** Whether the strip over the chats is up. */
  strip: boolean;
}

let state: NewsState = { releases: [], fresh: [], strip: false };
const listeners = new Set<() => void>();

function set(patch: Partial<NewsState>): void {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

export function getNews(): NewsState {
  return state;
}

export function useNews(): NewsState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
  );
}

/** Whether the app ran before this launch: it was moved about in, or connected a radio. A first launch has done neither yet. */
function ranBefore(): boolean {
  try {
    return localStorage.getItem("meshnet.nav") !== null || localStorage.getItem("meshnet.link.last") !== null;
  } catch {
    return false;
  }
}

/**
 * The news files this build carries (main.tsx), and what this launch brought.
 * A file for a version past this build's own is left out: a Dev build on its
 * way to 0.7.0 tells of 0.7.0 once the file is written, never of 0.8.0.
 */
export function registerNews(files: unknown[], version: string = __APP_VERSION__, seen: unknown = readSetting<unknown>(SEEN_KEY, null), before: boolean = ranBefore()): void {
  const own = baseVersion(version);
  const releases = files
    .map(parseRelease)
    .filter((r): r is Release => r !== null && compareVersions(r.version, own) <= 0)
    .sort((a, b) => compareVersions(b.version, a.version));
  const came = arrival(releases, typeof seen === "string" ? seen : null, before);
  if (came.seen) writeSetting(SEEN_KEY, came.seen);
  set({ releases, fresh: came.fresh, strip: came.strip });
}

/** The strip is done with: its versions count as seen. What's new still opens with them until the app restarts. */
export function closeNewsStrip(): void {
  const newest = state.releases[0]?.version;
  if (newest) writeSetting(SEEN_KEY, newest);
  set({ strip: false });
}

/** What's new from the strip over the chats: over the list on a phone, beside the chat on a desktop. */
export function openNews(): void {
  closeNewsStrip();
  push({ kind: "radio", page: "news" });
}

/** Where a new thing's Show goes: Chats, Mesh or a page of Settings; null for a place the app does not have. */
export function showTarget(show: string): (() => void) | null {
  if (show === "chats" || show === "mesh") return () => goSection(show, true);
  const page = /^radio\/(\w+)$/.exec(show)?.[1];
  return page && (RADIO_PAGES as readonly string[]).includes(page) ? () => openRadioPage(page as RadioPage) : null;
}
