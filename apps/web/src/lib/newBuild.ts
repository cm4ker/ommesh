/**
 * A newer Dev build, for an Android phone that runs one (#54). Dev builds
 * come from GitHub, where every push to master publishes one, and nothing
 * else tells a phone of them: Google Play updates its own build, TestFlight
 * its own, and the desktop has its updater (updates.ts). The phone reads the
 * feed the desktop reads, whose version is the APK's as well, and points at
 * the APK itself. A build from Google Play never asks: Play allows no other
 * way to update, and its version has no "-dev.".
 */

import { useSyncExternalStore } from "react";
import { nativePlatform } from "./platform.js";
import { readSetting, writeSetting } from "./storage.js";

/** The Dev channel's feed. Its `version` is the newest build's, desktop and APK alike. */
const FEED = "https://github.com/cm4ker/ommesh/releases/download/dev/latest.json";
/** The newest Dev APK: the rolling Dev release keeps a copy of it under one name. */
export const NEWEST_APK = "https://github.com/cm4ker/ommesh/releases/download/dev/Ommesh_android-debug.apk";
/** How often the feed is read while the app is open, as on the desktop. */
const PERIOD = 6 * 60 * 60_000;
/** How long the strip over the chats stays away once closed: Dev builds come several a day. */
const HIDE_MS = 24 * 60 * 60_000;
const HIDDEN_KEY = "meshnet.newBuild.hiddenUntil";

export interface NewBuildState {
  /** The newest build the feed named, once it was later than this one. */
  latest: string | null;
  /** When the feed last answered; 0 before it has. */
  checkedAt: number;
  checking: boolean;
  /** Until when the strip over the chats is closed. */
  hiddenUntil: number;
}

let state: NewBuildState = { latest: null, checkedAt: 0, checking: false, hiddenUntil: readSetting<number>(HIDDEN_KEY, 0) };
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

/** Whether this app looks for newer builds at all: a Dev build on an Android phone. */
export function looksForBuilds(): boolean {
  return nativePlatform() === "android" && __APP_VERSION__.includes("-dev.");
}

/**
 * SemVer's order: numbers by value, a release after its prereleases, and
 * prerelease parts one by one, so 0.4.0-dev.140.1 follows 0.4.0-dev.99.2 and
 * precedes 0.4.0. Build metadata after "+" is left out.
 */
export function compareVersions(a: string, b: string): number {
  const [coreA = "", preA] = a.split("+")[0]!.split(/-(.*)/s);
  const [coreB = "", preB] = b.split("+")[0]!.split(/-(.*)/s);
  const numbers = (core: string) => core.split(".").map((part) => Number(part) || 0);
  const x = numbers(coreA);
  const y = numbers(coreB);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  if (!preA || !preB) return preA ? -1 : preB ? 1 : 0;
  const p = preA.split(".");
  const q = preB.split(".");
  for (let i = 0; i < Math.max(p.length, q.length); i++) {
    if (p[i] === undefined) return -1;
    if (q[i] === undefined) return 1;
    const m = /^\d+$/.test(p[i]!);
    const n = /^\d+$/.test(q[i]!);
    if (m && n) {
      const d = Number(p[i]) - Number(q[i]);
      if (d !== 0) return Math.sign(d);
    } else if (m !== n) {
      // A number part comes before a word part.
      return m ? -1 : 1;
    } else if (p[i] !== q[i]) {
      return p[i]! < q[i]! ? -1 : 1;
    }
  }
  return 0;
}

/** Whether the strip over the chats is up: a later build is known, and the strip was not closed lately. */
export function stripShown(s: NewBuildState, now = Date.now()): boolean {
  return s.latest !== null && now >= s.hiddenUntil;
}

/** Takes what the feed said about the newest build; `current` is this one's version. */
export function heard(version: unknown, current: string = __APP_VERSION__, now = Date.now()): void {
  const later = typeof version === "string" && compareVersions(version, current) > 0 ? version : null;
  set({ latest: later, checkedAt: now, checking: false });
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
    const answer = await CapacitorHttp.get({ url: FEED, connectTimeout: 15_000, readTimeout: 15_000 });
    if (answer.status !== 200) throw new Error(`the feed answered ${answer.status}`);
    // Served as octet-stream, so it may come as text.
    const feed: unknown = typeof answer.data === "string" ? JSON.parse(answer.data) : answer.data;
    heard((feed as { version?: unknown } | null)?.version);
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
