import { useSyncExternalStore } from "react";
import { readSetting, writeSetting } from "./storage.js";

/**
 * Whether a message of only emoji is drawn large, without a bubble (#41), or as an
 * ordinary bubble. Set in Appearance.
 */

const KEY = "meshnet.jumboEmoji";
let jumboEmoji = readSetting<boolean>(KEY, true);
const listeners = new Set<() => void>();

export function setJumboEmoji(on: boolean): void {
  jumboEmoji = on;
  writeSetting(KEY, on);
  for (const listener of listeners) listener();
}

export function getJumboEmoji(): boolean {
  return jumboEmoji;
}

export function useJumboEmoji(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => jumboEmoji,
  );
}
