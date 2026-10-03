/**
 * A place put in the message field before it goes: one per conversation of
 * each radio, kept like the text's draft, so leaving the chat or the app does
 * not lose it. Each chat also remembers whether its last place of the writer
 * went exact or rough, so the next one starts the same way; a direct chat
 * starts exact, a channel or a room, where many read, rough.
 *
 * Which source a new place starts from is `firstSource`: the phone when it
 * knows where it is, else a radio's own GPS, else whatever the phone can find,
 * else the position set in the radio.
 */

import { useSyncExternalStore } from "react";
import type { LppReading, SelfInfo } from "@meshnet/meshcore";
import { hasPosition } from "./geo.js";
import { readSetting, writeSetting } from "./storage.js";

export type PlaceSource = "phone" | "radio" | "point";

export interface PlaceDraft {
  source: PlaceSource;
  lat: number;
  lon: number;
  /** Metres either way, as the phone gave it; null for the radio and for a point put on the map. */
  accuracy: number | null;
  /** Rough asked for. A point put by hand goes exactly whatever this says: it is a place, not the writer. */
  rough: boolean;
  /** The map open over the text, or folded into a bar above it. */
  open: boolean;
}

export const sendsRough = (draft: PlaceDraft): boolean => draft.rough && draft.source !== "point";

const KEY = "meshnet.placeDrafts";
const ROUGH_KEY = "meshnet.placeRough";
let drafts: Record<string, PlaceDraft> = readSetting<Record<string, PlaceDraft>>(KEY, {});
let roughBy: Record<string, boolean> = readSetting<Record<string, boolean>>(ROUGH_KEY, {});
const listeners = new Set<() => void>();
let saveTimer: ReturnType<typeof setTimeout> | null = null;

/** A channel's index names a different channel on another radio, so the radio is part of the slot. */
const slot = (radio: string, conversation: string) => `${radio}/${conversation}`;

function save(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  writeSetting(KEY, drafts);
}

if (typeof window !== "undefined") window.addEventListener("pagehide", () => saveTimer && save());

export function getPlace(radio: string, conversation: string): PlaceDraft | null {
  return drafts[slot(radio, conversation)] ?? null;
}

/** The place of a conversation put, changed or taken away; the phone's fixes change it often, so the disk hears of it a little later. */
export function setPlace(radio: string, conversation: string, draft: PlaceDraft | null): void {
  const key = slot(radio, conversation);
  const was = drafts[key] ?? null;
  if (JSON.stringify(was) === JSON.stringify(draft)) return;
  drafts = { ...drafts };
  if (draft) drafts[key] = draft;
  else delete drafts[key];
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 400);
  for (const listener of listeners) listener();
}

export function updatePlace(radio: string, conversation: string, patch: Partial<PlaceDraft>): void {
  const draft = getPlace(radio, conversation);
  if (draft) setPlace(radio, conversation, { ...draft, ...patch });
}

export function usePlace(radio: string, conversation: string): PlaceDraft | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => getPlace(radio, conversation),
  );
}

/** Whether a new place of the writer starts rough here: as the last one did, else rough where many read. */
export function startsRough(radio: string, conversation: string, many: boolean): boolean {
  return roughBy[slot(radio, conversation)] ?? many;
}

export function rememberRough(radio: string, conversation: string, rough: boolean): void {
  const key = slot(radio, conversation);
  if (roughBy[key] === rough) return;
  roughBy = { ...roughBy, [key]: rough };
  writeSetting(ROUGH_KEY, roughBy);
}

/** A fix the phone gave, as `phonePosition` keeps it. */
export interface PhoneFix {
  lat: number;
  lon: number;
  accuracy: number;
  at: number;
}

/** A phone's fix this old or older is not where the phone is now. */
export const FRESH_FIX_MS = 2 * 60_000;
/** A fix rougher than this does not beat a radio's GPS. */
export const GOOD_FIX_M = 100;

/**
 * Where this radio is: its own GPS as it last answered when it has one on,
 * else the position it was given. Null when it has neither.
 */
export function radioPosition(self: Pick<SelfInfo, "lat" | "lon"> | null, readings: LppReading[] | undefined, gps: boolean | null): { lat: number; lon: number } | null {
  if (gps) {
    const fix = readings?.find((r): r is Extract<LppReading, { type: "gps" }> => r.type === "gps" && r.channel === 1);
    if (fix && hasPosition(fix.lat, fix.lon)) return { lat: fix.lat, lon: fix.lon };
  }
  return self && hasPosition(self.lat, self.lon) ? { lat: self.lat, lon: self.lon } : null;
}

/**
 * Where a new place starts from: the phone if it knows where it is, a radio
 * with GPS, the phone if it can look, the position set in the radio; null when
 * nothing knows, and the writer puts the point on the map.
 */
export function firstSource(input: { fix: PhoneFix | null; canLocate: boolean; radio: { lat: number; lon: number } | null; radioGps: boolean; now: number }): Exclude<PlaceSource, "point"> | null {
  const { fix, now } = input;
  if (input.canLocate && fix && now - fix.at <= FRESH_FIX_MS && fix.accuracy <= GOOD_FIX_M) return "phone";
  if (input.radio && input.radioGps) return "radio";
  if (input.canLocate) return "phone";
  if (input.radio) return "radio";
  return null;
}
