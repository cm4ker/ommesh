import { useSyncExternalStore } from "react";
import type { Key } from "../i18n/index.js";
import { readSetting, writeSetting } from "./storage.js";

/**
 * The picture behind the chats, picked in Settings › Appearance › Chat background,
 * and a chat's own where one was picked on its page. The pictures are drawn by
 * `pnpm backgrounds`; most take the theme's colours (styles.css, `.chat-backdrop`).
 * Kept on this device only.
 */

export const BACKGROUNDS = ["none", "callsigns", "network", "topo", "space", "stitch", "geometry", "ether", "aurora"] as const;
export type Background = (typeof BACKGROUNDS)[number];

export const BACKGROUND_NAMES: Record<Background, Key> = {
  none: "radio.background.none",
  callsigns: "radio.background.callsigns",
  network: "radio.background.network",
  topo: "radio.background.topo",
  space: "radio.background.space",
  stitch: "radio.background.stitch",
  geometry: "radio.background.geometry",
  ether: "radio.background.ether",
  aurora: "radio.background.aurora",
};

export interface BackgroundPrefs {
  background: Background;
  /** How strong the pattern is drawn, 0–100; 50 is as each picture was drawn. */
  strength: number;
  /** A chat's own picture, by conversation id. */
  chat: Record<string, Background>;
}

const KEY = "meshnet.chatBackground";
const DEFAULTS: BackgroundPrefs = { background: "none", strength: 50, chat: {} };

const isBackground = (value: unknown): value is Background => (BACKGROUNDS as readonly unknown[]).includes(value);

/** What was stored, with anything a later or older version left there set right. */
export function sanitize(raw: unknown): BackgroundPrefs {
  const value = (raw && typeof raw === "object" ? raw : {}) as Partial<Record<keyof BackgroundPrefs, unknown>>;
  const strength = typeof value.strength === "number" && Number.isFinite(value.strength) ? Math.round(Math.min(100, Math.max(0, value.strength))) : DEFAULTS.strength;
  const chat: Record<string, Background> = {};
  if (value.chat && typeof value.chat === "object") {
    for (const [conversation, background] of Object.entries(value.chat)) if (isBackground(background)) chat[conversation] = background;
  }
  return { background: isBackground(value.background) ? value.background : DEFAULTS.background, strength, chat };
}

/** The picture a chat shows: its own, or everyone's. */
export function backgroundOf(prefs: BackgroundPrefs, conversation?: string): Background {
  return (conversation !== undefined ? prefs.chat[conversation] : undefined) ?? prefs.background;
}

let prefs = sanitize(readSetting<unknown>(KEY, DEFAULTS));
const listeners = new Set<() => void>();

function save(next: BackgroundPrefs): void {
  prefs = next;
  writeSetting(KEY, next);
  for (const listener of listeners) listener();
}

export function setBackground(background: Background): void {
  save({ ...prefs, background });
}

export function setBackgroundStrength(strength: number): void {
  save(sanitize({ ...prefs, strength }));
}

/** A chat's own picture; null goes back to everyone's. */
export function setChatBackground(conversation: string, background: Background | null): void {
  const chat = { ...prefs.chat };
  if (background === null) delete chat[conversation];
  else chat[conversation] = background;
  save({ ...prefs, chat });
}

export function useBackgroundPrefs(): BackgroundPrefs {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => prefs,
  );
}
