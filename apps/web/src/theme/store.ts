import { locale, t } from "../i18n/index.js";
import { bubbleVariable, cssVariable, defaultDark, defaultLight, findTheme, sharedTokens, themes, type BubbleToken, type SharedToken, type Theme, type ThemeToken } from "./themes.js";
import { paintSystemBars } from "../lib/systemBars.js";
import { settingWritten } from "../lib/storage.js";

const BUBBLE_TOKENS: BubbleToken[] = ["text", "textMuted", "textFaint", "accent", "danger"];

const KEY = "meshnet.theme";
/** The chosen theme's ground, for the boot screen `index.html` paints before this runs. */
const GROUND_KEY = "meshnet.theme.ground";

/** A theme id, or `"system"` to follow the OS. */
export type ThemePreference = string;

const listeners = new Set<() => void>();
let preference: ThemePreference = read();
let media: MediaQueryList | null = null;

function read(): ThemePreference {
  try {
    return localStorage.getItem(KEY) ?? "system";
  } catch {
    return "system";
  }
}

function prefersDark(): boolean {
  return media?.matches ?? false;
}

export function getPreference(): ThemePreference {
  return preference;
}

export function getActiveTheme(): Theme {
  if (preference === "system") return prefersDark() ? defaultDark : defaultLight;
  return findTheme(preference) ?? defaultDark;
}

/** Every theme, by its name in the reader's language: the picker's order. */
export function listThemes(): Theme[] {
  const names = new Map(themes.map((theme) => [theme, t(theme.name)]));
  return [...themes].sort((a, b) => names.get(a)!.localeCompare(names.get(b)!, locale()));
}

export function subscribeTheme(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setPreference(next: ThemePreference): void {
  preference = next;
  try {
    localStorage.setItem(KEY, next);
    if (next === "system") localStorage.removeItem(GROUND_KEY);
    else localStorage.setItem(GROUND_KEY, getActiveTheme().tokens.bg);
  } catch {
    // Private window.
  }
  apply();
  settingWritten();
}

function apply(): void {
  const theme = getActiveTheme();
  const root = document.documentElement;
  for (const token of Object.keys(theme.tokens) as ThemeToken[]) {
    root.style.setProperty(cssVariable(token), theme.tokens[token]);
  }
  for (const token of BUBBLE_TOKENS) {
    if (theme.bubble) root.style.setProperty(bubbleVariable(token), theme.bubble[token]);
    else root.style.removeProperty(bubbleVariable(token));
  }
  root.style.colorScheme = theme.appearance;
  root.dataset["appearance"] = theme.appearance;
  paintSystemBars(theme.appearance);
  setData(root, "bubbles", theme.bubble?.appearance);
  setData(root, "look", theme.look);
  for (const listener of listeners) listener();
}

function setData(root: HTMLElement, key: string, value: string | undefined): void {
  if (value) root.dataset[key] = value;
  else delete root.dataset[key];
}

/** Before the first render, so the page never paints in one palette and resolves into another. */
export function initTheme(): void {
  const root = document.documentElement;
  for (const token of Object.keys(sharedTokens) as SharedToken[]) root.style.setProperty(cssVariable(token), sharedTokens[token]);
  media = window.matchMedia("(prefers-color-scheme: dark)");
  media.addEventListener("change", () => {
    if (preference === "system") apply();
  });
  apply();
}
