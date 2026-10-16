import { useSyncExternalStore } from "react";
import { t } from "../i18n/index.js";
import { session } from "./session.js";
import { readSetting, writeSetting } from "./storage.js";

/**
 * How many times a direct message goes out before it is given up on (#28).
 * The session does the trying; this keeps the number and hands it over.
 */

const KEY = "meshnet.sendTries";
export const SEND_TRIES_MAX = 8;

const clamp = (n: number) => (Number.isFinite(n) ? Math.min(SEND_TRIES_MAX, Math.max(1, Math.round(n))) : 5);

let tries = clamp(readSetting<number>(KEY, 5));
const listeners = new Set<() => void>();

/** Hands the number to the session; called once at start. */
export function initSendTries(): void {
  session.setSendTries(tries);
}

export function setSendTries(n: number): void {
  tries = clamp(n);
  writeSetting(KEY, tries);
  session.setSendTries(tries);
  for (const listener of listeners) listener();
}

export function getSendTries(): number {
  return tries;
}

export function useSendTries(): number {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => tries,
  );
}

/** From the first try to the last, ms, the waits for acknowledgements aside. */
export function triesSpanMs(n: number): number {
  const ladder = session.directRetryLadder;
  let span = 0;
  for (let made = 1; made < n; made++) span += ladder[made] ?? ladder.at(-1) ?? 0;
  return span;
}

/** What `n` tries come to, said in a few words. */
export function triesPhrase(n: number): string {
  const span = triesSpanMs(n);
  return span < 60_000 ? t("chats.tries.withinMinute", { count: n }) : t("chats.tries.over", { count: n, minutes: Math.round(span / 60_000) });
}
