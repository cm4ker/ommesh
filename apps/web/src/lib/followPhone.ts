/**
 * "Follow the phone" (#34): while it is on for a radio, the app moves the
 * radio's position after the phone, as long as the app is open and the radio
 * connected. Each move is a write to the radio's flash (the firmware ends
 * CMD_SET_ADVERT_LATLON with savePrefs), so one goes only when the phone is
 * more than 50 m from where the radio is, at most once in five minutes, and
 * only on a fix good to 100 m. No advert is sent: others see the new place
 * with the radio's next one.
 *
 * A radio whose own GPS is on (its sensor setting `gps` is "1") rewrites its
 * position itself every few seconds, and is not followed.
 */

import { useSyncExternalStore } from "react";
import { t } from "../i18n/index.js";
import { distanceKm, hasPosition } from "./geo.js";
import { getPhoneState, holdPhone, phoneLocates, subscribePhone, type Fix } from "./phonePosition.js";
import { session } from "./session.js";
import { readSetting, writeSetting } from "./storage.js";
import { toast } from "./toast.js";

/** Nearer than this, in metres, the radio is where the phone is: GPS drifts a few metres standing still. */
export const FOLLOW_MOVE_M = 50;
/** At most one write to the radio's flash in this long. */
export const FOLLOW_EVERY_MS = 5 * 60_000;
/** A fix less sure than this, in metres (indoors, or a phone giving only an approximate place), is not written. */
export const FOLLOW_ACCURACY_M = 100;
/** After a write that failed, the next fix may try again this much later. */
const RETRY_MS = 30_000;

export type FollowStep = "write" | "near" | "wait" | "rough";

/** What one fix of the phone does to the radio's position. */
export function followStep(fix: Fix, radio: { lat: number; lon: number } | null, lastWrite: number | null, now: number): FollowStep {
  if (fix.accuracy > FOLLOW_ACCURACY_M) return "rough";
  if (radio && hasPosition(radio.lat, radio.lon) && distanceKm(fix.lat, fix.lon, radio.lat, radio.lon) * 1000 <= FOLLOW_MOVE_M) return "near";
  if (lastWrite !== null && now - lastWrite < FOLLOW_EVERY_MS) return "wait";
  return "write";
}

// ---- which radios follow, and how it went ----

const KEY = "meshnet.followPhone";

function restore(saved: unknown): Record<string, true> {
  if (!saved || typeof saved !== "object") return {};
  const on: Record<string, true> = {};
  for (const [key, value] of Object.entries(saved)) if (value === true) on[key] = true;
  return on;
}

export interface FollowStatus {
  /** Following is on for this radio. */
  on: boolean;
  /** The radio's own GPS is on, so it is not followed; null until the radio has said. */
  gps: boolean | null;
  /** The last position written from the phone in this run of the app. */
  wrote: { at: number; accuracy: number } | null;
  /** The phone's latest fix was too rough to write: how rough, in metres. */
  rough: number | null;
}

let following = restore(readSetting<unknown>(KEY, null));
const gps: Record<string, boolean> = {};
const wrote: Record<string, { at: number; accuracy: number }> = {};
const failed: Record<string, number> = {};
let rough: Record<string, number> = {};
let version = 0;
const listeners = new Set<() => void>();

function changed(): void {
  version++;
  for (const listener of listeners) listener();
}

export function followsPhone(radioKey: string | undefined): boolean {
  return !!radioKey && following[radioKey] === true;
}

/** Whether the radio's own GPS is on; null until the radio has said. */
export function radioHasGps(radioKey: string | undefined): boolean | null {
  return radioKey ? gps[radioKey] ?? null : null;
}

export function setFollowPhone(radioKey: string, on: boolean): void {
  const next = { ...following };
  if (on) next[radioKey] = true;
  else delete next[radioKey];
  following = next;
  // Turned on, the first write goes at once.
  if (on) delete wrote[radioKey];
  rough = { ...rough };
  delete rough[radioKey];
  writeSetting(KEY, following);
  changed();
  check();
}

const statusCache = new Map<string, { version: number; status: FollowStatus }>();

function statusOf(radioKey: string | undefined): FollowStatus {
  const id = radioKey ?? "";
  const cached = statusCache.get(id);
  if (cached && cached.version === version) return cached.status;
  const status: FollowStatus = { on: followsPhone(radioKey), gps: radioHasGps(radioKey), wrote: radioKey ? wrote[radioKey] ?? null : null, rough: radioKey ? rough[radioKey] ?? null : null };
  statusCache.set(id, { version, status });
  return status;
}

export function useFollowStatus(radioKey: string | undefined): FollowStatus {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => statusOf(radioKey),
  );
}

// ---- the loop ----

let release: (() => void) | null = null;
/** The radio whose GPS setting was asked on this connection. */
let askedGps: string | null = null;
let writing = false;

/** The radio that follows the phone now: connected, following on, no GPS of its own. */
function follower(): string | null {
  const state = session.getState();
  const key = state.status === "ready" ? state.self?.key : undefined;
  if (!key || !followsPhone(key) || gps[key] === true) return null;
  return key;
}

function check(): void {
  const state = session.getState();
  const connected = state.status === "ready" ? state.self?.key ?? null : null;
  if (connected !== askedGps) {
    askedGps = connected;
    if (connected) readGps(connected);
  }
  const key = follower();
  if (key && !release) release = holdPhone();
  else if (!key && release) {
    release();
    release = null;
  }
  if (key) void move(key);
}

function readGps(key: string): void {
  session.customVars().then(
    (vars) => {
      gps[key] = vars["gps"] === "1";
      changed();
      check();
    },
    // An older radio that does not know the question has no GPS setting to ask.
    () => undefined,
  );
}

async function move(key: string): Promise<void> {
  const { fix, problem } = getPhoneState();
  if (problem === "denied") {
    // Leave taken away in the phone's settings: following stops, and says why.
    setFollowPhone(key, false);
    toast(t("radio.position.followDenied"), "error");
    return;
  }
  const self = session.getState().self;
  if (!fix || !self || writing) return;
  const now = Date.now();
  const step = followStep(fix, self, wrote[key]?.at ?? null, now);
  const wasRough = rough[key] ?? null;
  const isRough = step === "rough" ? Math.round(fix.accuracy) : null;
  if (wasRough !== isRough) {
    rough = { ...rough };
    if (isRough === null) delete rough[key];
    else rough[key] = isRough;
    changed();
  }
  if (step !== "write" || now - (failed[key] ?? 0) < RETRY_MS) return;
  writing = true;
  try {
    await session.setLocation(Number(fix.lat.toFixed(6)), Number(fix.lon.toFixed(6)));
    wrote[key] = { at: now, accuracy: Math.round(fix.accuracy) };
    delete failed[key];
    changed();
  } catch {
    // The link dropped mid-write, most likely; the next fix tries again.
    failed[key] = now;
  } finally {
    writing = false;
  }
}

/** Runs for as long as the app does, in the shells that can say where the phone is. */
export function startFollowPhone(): () => void {
  if (!phoneLocates()) return () => undefined;
  const offSession = session.subscribe(check);
  const offPhone = subscribePhone(check);
  check();
  return () => {
    offSession();
    offPhone();
    release?.();
    release = null;
  };
}
