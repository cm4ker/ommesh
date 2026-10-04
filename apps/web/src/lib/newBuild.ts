/**
 * A newer build, for an Android phone that runs an APK from GitHub (#54).
 * Nothing else tells such a phone of one: Google Play updates its own build,
 * TestFlight its own, and the desktop has its updater (updates.ts). The phone
 * reads the feed the desktop reads, whose version is the APK's as well, and
 * points at the APK itself: a Dev APK reads the Dev feed and an APK from a
 * stable release the stable one. The feed carries the version's news, which
 * What's new shows before the download. A build for Google Play never asks:
 * Play allows no other way to update.
 */

import { useSyncExternalStore } from "react";
import { parseRelease, type Release } from "./news.js";
import { nativePlatform } from "./platform.js";
import { readSetting, writeSetting } from "./storage.js";
import { baseVersion, compareVersions } from "./version.js";

export { compareVersions } from "./version.js";

const RELEASES = "https://github.com/cm4ker/ommesh/releases";
/** A Dev APK hears of Dev builds; one from a stable release, of stable versions. */
const dev = () => __APP_VERSION__.includes("-dev.");
/** The channel's feed. Its `version` is the newest build's, desktop and APK alike. */
const feed = () => (dev() ? `${RELEASES}/download/dev/latest.json` : `${RELEASES}/latest/download/latest.json`);
/** The newest APK: the rolling Dev release and every stable one keep a copy of it under one name. */
export const newestApk = () => (dev() ? `${RELEASES}/download/dev/Ommesh_android-debug.apk` : `${RELEASES}/latest/download/Ommesh_android-debug.apk`);
/** How often the feed is read while the app is open, as on the desktop. */
const PERIOD = 6 * 60 * 60_000;
/** How long the strip over the chats stays away once closed. */
const HIDE_MS = 24 * 60 * 60_000;
const HIDDEN_KEY = "meshnet.newBuild.hiddenUntil";

export interface NewBuildState {
  /** The newest build the feed named, once it was later than this one. */
  latest: string | null;
  /** What the version of that build brings, when the feed told it. */
  news: Release | null;
  /** When the feed last answered; 0 before it has. */
  checkedAt: number;
  checking: boolean;
  /** Until when the strip over the chats is closed. */
  hiddenUntil: number;
}

let state: NewBuildState = { latest: null, news: null, checkedAt: 0, checking: false, hiddenUntil: readSetting<number>(HIDDEN_KEY, 0) };
const listeners = new Set<() => void>();

function set(patch: Partial<NewBuildState>): void {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

export function getNewBuild(): NewBuildState {
  return state;
}

export function useNewBuild(): NewBuildState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
  );
}

/** Whether this app looks for newer builds at all: an APK from GitHub on an Android phone. */
export function looksForBuilds(): boolean {
  return nativePlatform() === "android" && !__FOR_PLAY__;
}

/** Whether the strip over the chats is up: a later build is known, and the strip was not closed lately. */
export function stripShown(s: NewBuildState, now = Date.now()): boolean {
  return s.latest !== null && now >= s.hiddenUntil;
}

/** Takes what the feed said about the newest build and its news; `current` is this one's version. */
export function heard(version: unknown, current: string = __APP_VERSION__, now = Date.now(), news: unknown = null): void {
  const later = typeof version === "string" && compareVersions(version, current) > 0 ? version : null;
  // News this build carries already, as a Dev build does on its way to the version, are not news.
  const told = later ? parseRelease(news) : null;
  set({ latest: later, news: told && compareVersions(told.version, baseVersion(current)) > 0 ? told : null, checkedAt: now, checking: false });
}

/** Closes the strip over the chats for a day; About keeps the build. */
export function hideStrip(now = Date.now()): void {
  writeSetting(HIDDEN_KEY, now + HIDE_MS);
  set({ hiddenUntil: now + HIDE_MS });
}

let lastTry = 0;

/** Reads the feed. It fails quietly: without a network the app simply knows of no newer build. */
export async function checkForBuild(): Promise<void> {
  if (!looksForBuilds() || state.checking) return;
  lastTry = Date.now();
  set({ checking: true });
  try {
    // Native, since github.com answers a page's request without the header that lets the page read it.
    const { CapacitorHttp } = await import("@capacitor/core");
    const answer = await CapacitorHttp.get({ url: feed(), connectTimeout: 15_000, readTimeout: 15_000 });
    if (answer.status !== 200) throw new Error(`the feed answered ${answer.status}`);
    // Served as octet-stream, so it may come as text.
    const body: unknown = typeof answer.data === "string" ? JSON.parse(answer.data) : answer.data;
    const told = body as { version?: unknown; news?: unknown } | null;
    heard(told?.version, __APP_VERSION__, Date.now(), told?.news);
  } catch {
    set({ checking: false });
  }
}

function checkIfDue(): void {
  if (Date.now() - lastTry >= PERIOD) void checkForBuild();
}

if (typeof document !== "undefined" && looksForBuilds()) {
  // A moment after launch, out of the way of the radio's connect.
  setTimeout(checkIfDue, 5_000);
  setInterval(checkIfDue, PERIOD);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") checkIfDue();
  });
}
