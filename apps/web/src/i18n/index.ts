/**
 * The words on screen, in the reader's language.
 *
 * Every string the app shows lives in `i18n/<language>/<area>.json`. English
 * (`en/`) is the source; every other folder translates it. A language is a
 * folder and nothing more: copy `en`, name the copy by the language's code
 * (`de`, `pt-BR`), translate the values, and it is offered under Appearance ›
 * Language — languages.ts finds the folders, the language names itself.
 *
 * A key is the file and the key in it: `t("chats.empty")`. A value is a
 * string with `{name}` placeholders, or, for something counted, one string per
 * plural category the language has (CLDR's: `one`, `few`, `many`, `other` …),
 * chosen by the `count` passed. What a translation lacks is said in English.
 *
 * Called while drawing or acting, never at a module's top level: a module is
 * read before the language is known, and a string made then stays English.
 */

import { useSyncExternalStore } from "react";
import app from "./en/app.json";
import apps from "./en/apps.json";
import chats from "./en/chats.json";
import cli from "./en/cli.json";
import common from "./en/common.json";
import connect from "./en/connect.json";
import contacts from "./en/contacts.json";
import mesh from "./en/mesh.json";
import node from "./en/node.json";
import notices from "./en/notices.json";
import radio from "./en/radio.json";
import tools from "./en/tools.json";

/** The source. An area of its own is one more file here and one import above. */
const english = { app, apps, chats, cli, common, connect, contacts, mesh, node, notices, radio, tools };

type English = typeof english;
export type Area = keyof English;
/** Every key English has: `"chats.empty"`. A key it lacks does not compile. */
export type Key = { [A in Area]: `${A}.${Extract<keyof English[A], string>}` }[Area];

/** A counted string: one form per plural category, `other` always. */
export type Plural = Partial<Record<Intl.LDMLPluralRule, string>> & { other: string };
export type Entry = string | Plural;
/** One language: its areas, each its keys. */
export type Messages = Record<string, Record<string, Entry>>;
/** What fills the placeholders; `count` also picks the plural form. */
export type Params = Record<string, string | number> & { count?: number };

export const SOURCE = "en";
const KEY = "meshnet.language";

const loaded = new Map<string, Messages>([[SOURCE, english as unknown as Messages]]);
const loaders = new Map<string, () => Promise<Messages>>();
const listeners = new Set<() => void>();
let preference = SOURCE;
let active = SOURCE;
let rules = new Intl.PluralRules(SOURCE);
let started = false;
let warned = false;

/** The languages there are besides English, each loaded when first wanted (languages.ts). */
export function registerLanguages(found: Record<string, () => Promise<Messages>>): void {
  for (const [code, load] of Object.entries(found)) if (code !== SOURCE) loaders.set(code, load);
}

/** Every language on offer, English first, the rest by their own names. */
export function languages(): string[] {
  const others = [...loaders.keys()].sort((a, b) => languageName(a).localeCompare(languageName(b)));
  return [SOURCE, ...others];
}

/** A language in its own words, "Русский" for `ru`; its code when the system cannot name it. */
export function languageName(code: string): string {
  try {
    const name = new Intl.DisplayNames([code], { type: "language" }).of(code);
    if (name && name !== code) return name.charAt(0).toLocaleUpperCase(code) + name.slice(1);
  } catch {
    // An engine without DisplayNames, or a code it does not know.
  }
  return code;
}

/** `"system"`, or the code of a language picked by hand. */
export function getLanguagePreference(): string {
  return preference;
}

/** The language the words are in now. */
export function language(): string {
  return active;
}

/**
 * The locale dates and numbers are written for: the system's own when it is
 * the same language, so English keeps its region's clock, else the language.
 */
export function locale(): string {
  const system = typeof navigator === "undefined" ? undefined : navigator.language;
  return system && base(system) === base(active) ? system : active;
}

/** The language the system asks for, of those there are; English when none. */
export function systemLanguage(): string {
  const wanted = typeof navigator === "undefined" ? [] : navigator.languages?.length ? navigator.languages : [navigator.language];
  const codes = [SOURCE, ...loaders.keys()];
  for (const tag of wanted) {
    const exact = codes.find((c) => c.toLowerCase() === tag.toLowerCase());
    if (exact) return exact;
    const near = codes.find((c) => base(c) === base(tag));
    if (near) return near;
  }
  return SOURCE;
}

function base(tag: string): string {
  return tag.split("-")[0]!.toLowerCase();
}

function resolve(wanted: string): string {
  return wanted !== "system" && (wanted === SOURCE || loaders.has(wanted)) ? wanted : systemLanguage();
}

async function load(code: string): Promise<void> {
  if (loaded.has(code)) return;
  const read = loaders.get(code);
  if (!read) return;
  loaded.set(code, await read());
}

async function apply(): Promise<void> {
  const code = resolve(preference);
  try {
    await load(code);
  } catch (error) {
    console.warn(`Could not load the ${code} words`, error);
  }
  const next = loaded.has(code) ? code : SOURCE;
  if (next !== active || !started) {
    active = next;
    rules = new Intl.PluralRules(active);
    started = true;
    if (typeof document !== "undefined") document.documentElement.lang = active;
  }
  // Told even when the language stays: the preference may have changed.
  for (const listener of listeners) listener();
}

/** Before the first render, so the page is drawn in its language from the start. */
export async function initLanguage(): Promise<void> {
  preference = read() ?? "system";
  await apply();
  // Another window of the app changed it (the desktop's notice cards), or the system's language changed.
  window.addEventListener("storage", (e) => {
    if (e.key !== KEY) return;
    preference = e.newValue ?? "system";
    void apply();
  });
  window.addEventListener("languagechange", () => {
    if (preference === "system") void apply();
  });
}

export async function setLanguagePreference(next: string): Promise<void> {
  preference = next;
  try {
    if (next === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, next);
  } catch {
    // Private window: kept for this visit.
  }
  await apply();
}

function read(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function subscribeLanguage(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The language, for a component that draws words made outside React's reach, or keys its tree by it. */
export function useLanguage(): string {
  return useSyncExternalStore(subscribeLanguage, language);
}

function lookup(code: string, key: string): Entry | undefined {
  const dot = key.indexOf(".");
  return loaded.get(code)?.[key.slice(0, dot)]?.[key.slice(dot + 1)];
}

/** The plural category of a count in the language now. */
export function pluralCategory(count: number): Intl.LDMLPluralRule {
  return rules.select(count);
}

/**
 * The category of each count from 0 to 199, for native code that counts in the
 * page's words without the page's `Intl`: past 199, a count takes the category
 * of 100 plus its last two digits, as the languages' rules go.
 */
export function pluralTable(): Intl.LDMLPluralRule[] {
  return Array.from({ length: 200 }, (_, n) => rules.select(n));
}

/** A counted key's forms in the language now, for native code that fills them itself. */
export function forms(key: Key): Plural {
  const value = lookup(active, key) ?? lookup(SOURCE, key);
  return typeof value === "object" ? value : { other: value ?? key };
}

/** A key's text before its placeholders are filled, in the form `count` asks for. */
export function template(key: Key, count?: number): string {
  if (!started && !warned && typeof window !== "undefined") {
    warned = true;
    console.warn(`"${key}" was read before the language was known, and stays English. Read it while drawing, not at a module's top.`);
  }
  const value = lookup(active, key) ?? lookup(SOURCE, key);
  if (value === undefined) return key;
  if (typeof value === "string") return value;
  return value[rules.select(count ?? 0)] ?? value.other;
}

/** The text for a key, placeholders filled: `t("mesh.heardAgo", { time: "5 min" })`. */
export function t(key: Key, params?: Params): string {
  const text = template(key, params?.count);
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (whole, name: string) => (name in params ? String(params[name]) : whole));
}
