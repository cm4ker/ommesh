import { useSyncExternalStore } from "react";
import type { Key } from "../i18n/index.js";
import { readSetting, writeSetting } from "./storage.js";

/**
 * The picture behind the chats, picked in Settings › Appearance › Chat background,
 * and a chat's own where one was picked on its page. The pictures are drawn by
 * `pnpm backgrounds`, with a light and a dark palette for each one.
 * Kept on this device only.
 */

export const BACKGROUNDS = ["none", "doodles", "planets", "botanical", "science", "blocks", "expedition", "damask", "confetti"] as const;
export type Background = (typeof BACKGROUNDS)[number];

export const BACKGROUND_NAMES: Record<Background, Key> = {
  none: "radio.background.none",
  doodles: "radio.background.doodles",
  planets: "radio.background.planets",
  botanical: "radio.background.botanical",
  science: "radio.background.science",
  blocks: "radio.background.blocks",
  expedition: "radio.background.expedition",
  damask: "radio.background.damask",
  confetti: "radio.background.confetti",
};

export interface BackgroundPrefs {
  background: Background;
  /** How strong the picture is drawn, from the theme's plain ground to its full colours. */
  strength: number;
  /** The size of the pattern, as a percentage of its usual size. */
  scale: number;
  /** A chat's own picture, by conversation id. */
  chat: Record<string, Background>;
}

const KEY = "meshnet.chatBackground";
const DEFAULTS: BackgroundPrefs = {
  background: "none",
  strength: 100,
  scale: 100,
  chat: {},
};

/** Existing global and per-chat choices move to the closest design in the new collection. */
const LEGACY: Record<string, Background> = {
  callsigns: "expedition",
  network: "doodles",
  topo: "botanical",
  space: "planets",
  stitch: "damask",
  geometry: "blocks",
  ether: "science",
  aurora: "doodles",
};

const isBackground = (value: unknown): value is Background => (BACKGROUNDS as readonly unknown[]).includes(value);
const fromStored = (value: unknown): Background | undefined =>
  isBackground(value) ? value : typeof value === "string" && Object.prototype.hasOwnProperty.call(LEGACY, value) ? LEGACY[value] : undefined;

/** What was stored, with anything a later or older version left there set right. */
export function sanitize(raw: unknown): BackgroundPrefs {
  const value = (raw && typeof raw === "object" ? raw : {}) as Partial<Record<keyof BackgroundPrefs, unknown>>;
  const strength =
    typeof value.strength === "number" && Number.isFinite(value.strength) ? Math.round(Math.min(100, Math.max(0, value.strength))) : DEFAULTS.strength;
  const scale = typeof value.scale === "number" && Number.isFinite(value.scale) ? Math.round(Math.min(160, Math.max(80, value.scale))) : DEFAULTS.scale;
  const chat: Record<string, Background> = {};
  if (value.chat && typeof value.chat === "object") {
    for (const [conversation, background] of Object.entries(value.chat)) {
      const picked = fromStored(background);
      if (picked !== undefined) chat[conversation] = picked;
    }
  }
  return {
    background: fromStored(value.background) ?? DEFAULTS.background,
    strength,
    scale,
    chat,
  };
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

export function setBackgroundScale(scale: number): void {
  save(sanitize({ ...prefs, scale }));
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
