/**
 * Do not disturb: when it is on, and what still rings while it is.
 *
 * It is on by hand, for an hour, till morning or until turned off, and on
 * the nights the schedule names, 23:00 to 07:00 unless the reader moved them.
 * Turned off in the middle of a night, the rest of that night is set aside
 * (`awake`); the next one is quiet again. Morning is when the schedule's
 * night ends, whether the schedule is on or not.
 *
 * While it is on, a notice comes without a sound and without popping up: the
 * phone puts it in the shade quietly, a computer straight into the
 * notification centre, and the page's own banner and corner cards show none.
 * New nodes are not told of at all. A direct message from a favourite rings
 * all the same, and, if the reader wants, a message that mentions this radio.
 *
 * The rules are pure, by the clock handed in, so they are testable; the
 * phone's radio core, which has no clock of its own, gets the next two weeks
 * of quiet as spans of the phone's clock (`quietSpans`).
 */

import { useSyncExternalStore } from "react";
import { isFavourite, type MessageRecord, type SessionState } from "@meshnet/meshcore";
import { endChatWhiles, getNoticePrefs, isDirect, mentionsMe, setQuietPrefs, subscribeNoticePrefs, type QuietPrefs } from "./noticePrefs.js";

const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** The end of a quiet that lasts until it is turned off. */
export const FOREVER = Number.MAX_SAFE_INTEGER;
/** How far ahead the radio core is told of the quiet. */
const AHEAD = 14 * DAY;

/** The night that starts on the day of `day`, from and to in ms, or null when the schedule leaves that day out. */
function nightOf(q: QuietPrefs, day: Date): [number, number] | null {
  if (!q.days.includes(day.getDay())) return null;
  const [y, m, d] = [day.getFullYear(), day.getMonth(), day.getDate()];
  return [new Date(y, m, d, 0, q.from).getTime(), new Date(y, m, d + (q.to > q.from ? 0 : 1), 0, q.to).getTime()];
}

/** The scheduled nights that reach into `from`..`to`, past the night set aside. */
function nights(q: QuietPrefs, from: number, to: number): [number, number][] {
  if (!q.nightly) return [];
  const spans: [number, number][] = [];
  const day = new Date(from);
  day.setHours(0, 0, 0, 0);
  day.setDate(day.getDate() - 1);
  while (day.getTime() <= to) {
    const night = nightOf(q, day);
    if (night && night[1] > from && night[0] <= to) {
      const start = Math.max(night[0], q.awake);
      if (start < night[1]) spans.push([start, night[1]]);
    }
    day.setDate(day.getDate() + 1);
  }
  return spans;
}

/** The quiet from `now` to `ahead` ms on, by hand and by the schedule, as spans that neither touch nor overlap. */
export function quietSpans(q: QuietPrefs, now: number, ahead = AHEAD): [number, number][] {
  const spans = nights(q, now, now + ahead);
  if (q.hand === "always") spans.push([now, FOREVER]);
  else if (q.hand !== "off" && q.until > now) spans.push([now, q.until]);
  spans.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const span of spans) {
    const last = merged.at(-1);
    if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]);
    else merged.push([...span]);
  }
  return merged;
}

/** When the quiet on at `now` ends, `FOREVER` when it lasts until turned off; null when it is not on. */
export function quietEnds(q: QuietPrefs, now: number): number | null {
  return quietSpans(q, now, DAY).find(([from, to]) => from <= now && now < to)?.[1] ?? null;
}

export function quietAt(q: QuietPrefs, now: number): boolean {
  return quietEnds(q, now) !== null;
}

/** When quiet next turns on or off, if within the two weeks ahead. */
export function nextTurn(q: QuietPrefs, now: number): number | null {
  const end = quietEnds(q, now);
  if (end !== null) return end >= FOREVER ? null : end;
  return quietSpans(q, now).find(([from]) => from > now)?.[0] ?? null;
}

/** The next morning after `now`: when the schedule's night ends. */
export function morning(q: QuietPrefs, now: number): number {
  const date = new Date(now);
  const at = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, q.to).getTime();
  if (at > now) return at;
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1, 0, q.to).getTime();
}

/** Whether a message rings while it is quiet: a favourite's direct message, or one that mentions this radio. */
export function ringsThrough(q: QuietPrefs, state: SessionState, message: MessageRecord): boolean {
  if (q.mentions && mentionsMe(state, message)) return true;
  if (!q.favourites || !message.conversation.startsWith("c:") || !isDirect(state, message.conversation)) return false;
  const contact = state.contacts[message.conversation.slice(2)];
  return !!contact && isFavourite(contact);
}

/** What turning it on by hand stores: for an hour, till morning, or until turned off. */
export function turnedOn(q: QuietPrefs, hand: QuietPrefs["hand"], now: number): Partial<QuietPrefs> {
  switch (hand) {
    case "hour":
      return { hand, until: now + HOUR };
    case "morning":
      return { hand, until: morning(q, now) };
    default:
      return { hand, until: 0 };
  }
}

/** What turning it off stores: off by hand, and the night it is in set aside. */
export function turnedOff(q: QuietPrefs, now: number): Partial<QuietPrefs> {
  const night = nights(q, now, now).find(([from, to]) => from <= now && now < to);
  return { hand: "off", until: 0, awake: night ? night[1] : q.awake };
}

/** What an hour more stores: quiet by hand till an hour after it would end. */
export function hourMore(q: QuietPrefs, now: number): Partial<QuietPrefs> {
  const end = quietEnds(q, now) ?? now;
  if (end >= FOREVER) return {};
  return { hand: "hour", until: end + HOUR };
}

export function setQuiet(hand: QuietPrefs["hand"]): void {
  const q = getNoticePrefs().quiet;
  setQuietPrefs(hand === "off" ? { hand: "off", until: 0 } : turnedOn(q, hand, Date.now()));
}

export function quietOff(): void {
  setQuietPrefs(turnedOff(getNoticePrefs().quiet, Date.now()));
}

export function quietLonger(): void {
  setQuietPrefs(hourMore(getNoticePrefs().quiet, Date.now()));
}

/** Whether it is quiet now, and till when. */
export interface QuietNow {
  on: boolean;
  /** When it ends, `FOREVER` when it lasts until turned off; null when it is not on. */
  until: number | null;
}

let current: QuietNow = { on: false, until: null };
const listeners = new Set<() => void>();

function look(): void {
  const until = quietEnds(getNoticePrefs().quiet, Date.now());
  if (until === current.until) return;
  current = { on: until !== null, until };
  for (const listener of listeners) listener();
}

export function getQuietNow(): QuietNow {
  return current;
}

export function subscribeQuiet(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useQuiet(): QuietNow {
  return useSyncExternalStore(subscribeQuiet, getQuietNow);
}

/**
 * Keeps `useQuiet` true to the clock: looked at again when quiet turns on or
 * off, when the settings change, and when the page comes back from sleep,
 * whose timers ran late or not at all. A chat silenced for a while gets its
 * level back on time too.
 */
export function startQuiet(): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const arm = (): void => {
    if (timer) clearTimeout(timer);
    timer = null;
    // Its change comes back here through the settings, and that look does the rest.
    if (endChatWhiles()) return;
    look();
    const now = Date.now();
    const prefs = getNoticePrefs();
    const turns = [nextTurn(prefs.quiet, now), ...Object.values(prefs.chatUntil)].filter((at): at is number => at !== null && at > now);
    if (turns.length === 0) return;
    // A day at most: a long timeout overflows, and the page may sleep through it anyway.
    timer = setTimeout(arm, Math.min(Math.min(...turns) - now + 100, DAY));
  };
  arm();
  const stopPrefs = subscribeNoticePrefs(arm);
  const awake = () => {
    if (document.visibilityState === "visible") arm();
  };
  document.addEventListener("visibilitychange", awake);
  return () => {
    if (timer) clearTimeout(timer);
    stopPrefs();
    document.removeEventListener("visibilitychange", awake);
  };
}
