/**
 * Two-sided message window for a chat view (#137).
 *
 * A long channel can hold tens of thousands of messages, so drawing every
 * message from a jumped-to search match down to the latest would mount
 * thousands of bubbles at once and freeze the phone. The window keeps only a
 * small slice around the reader's place — anchored to the bottom while reading
 * live (`to === null`), or bounded on both ends after jumping far back in
 * history — and expands in either direction as the reader scrolls.
 */

import type { MessageRecord } from "@meshnet/meshcore";

/** How many of the latest messages a chat draws when it opens at the bottom. */
export const FIRST_DRAWN = 60;
/** How many older or newer messages are drawn in per scroll step. */
export const MORE_DRAWN = 100;
/** Messages kept above an unread line or a jumped-to match. */
export const ABOVE = 10;
/** Messages drawn above and below when re-centering on a distant jump target. */
export const WINDOW_BEFORE = 20;
export const WINDOW_AFTER = 20;
/** Distance past the current edge that expands instead of re-centering. */
export const JUMP_EXPAND = 120;

/**
 * Anchors of the drawn slice by message id, both inclusive.
 * `from === null` draws from the oldest message; `to === null` draws through the latest.
 */
export interface ChatWindow {
  from: string | null;
  to: string | null;
}

/** Resolved half-open index range `[start, end)` into `messages`. */
export interface WindowRange {
  start: number;
  end: number;
  /** True when the slice reaches the newest message of the chat. */
  atBottom: boolean;
}

/** Initial window on opening a chat: centered on a distant jump or unread start, else the latest messages. */
export function initialWindow(
  messages: readonly MessageRecord[],
  indexById: ReadonlyMap<string, number>,
  options: { jumpId?: string | null | undefined; unreadFirstId?: string | null | undefined; openAtUnread?: boolean | undefined } = {},
): ChatWindow {
  const n = messages.length;
  if (n <= FIRST_DRAWN) return { from: null, to: null };
  const jumpAt = options.jumpId ? (indexById.get(options.jumpId) ?? -1) : -1;
  if (jumpAt >= 0) return windowAround(messages, jumpAt);
  const unreadAt = options.openAtUnread && options.unreadFirstId ? (indexById.get(options.unreadFirstId) ?? -1) : -1;
  if (unreadAt >= 0) {
    if (n - 1 - unreadAt > FIRST_DRAWN + WINDOW_AFTER) {
      return rangeToWindow(messages, Math.max(0, unreadAt - ABOVE), Math.min(n, unreadAt + FIRST_DRAWN));
    }
    const start = Math.min(n - FIRST_DRAWN, Math.max(0, unreadAt - ABOVE));
    return { from: start > 0 ? messages[start]!.id : null, to: null };
  }
  return { from: messages[n - FIRST_DRAWN]!.id, to: null };
}

/** Resolves a window and adjusts it to cover `targetId` (expanding if nearby, re-centering if far away). */
export function resolveWindow(
  messages: readonly MessageRecord[],
  indexById: ReadonlyMap<string, number>,
  win: ChatWindow,
  targetId: string | null,
): { range: WindowRange; next: ChatWindow; changed: boolean } {
  const n = messages.length;
  if (n === 0) {
    const empty = { from: null, to: null };
    return { range: { start: 0, end: 0, atBottom: true }, next: empty, changed: win.from !== null || win.to !== null };
  }

  let start = win.from === null ? 0 : (indexById.get(win.from) ?? Math.max(0, n - FIRST_DRAWN));
  let end = win.to === null ? n : Math.min(n, (indexById.get(win.to) ?? n - 1) + 1);
  if (start >= end) {
    start = Math.max(0, n - FIRST_DRAWN);
    end = n;
  }

  const targetAt = targetId ? (indexById.get(targetId) ?? -1) : -1;
  if (targetAt >= 0) {
    const comfortableStart = start > 0 ? start + ABOVE : 0;
    const comfortableEnd = end < n ? end - Math.min(ABOVE, WINDOW_AFTER) : n;
    if (targetAt < comfortableStart || targetAt >= comfortableEnd) {
      if (targetAt < start && start - targetAt <= JUMP_EXPAND) {
        start = Math.max(0, targetAt - ABOVE);
      } else if (targetAt >= end && targetAt - end <= JUMP_EXPAND) {
        end = Math.min(n, targetAt + WINDOW_AFTER + 1);
        if (end >= n - ABOVE) end = n;
      } else if (targetAt < start || targetAt >= end) {
        start = Math.max(0, targetAt - WINDOW_BEFORE);
        end = Math.min(n, targetAt + WINDOW_AFTER + 1);
        if (end >= n - ABOVE) end = n;
      } else if (targetAt < comfortableStart) {
        start = Math.max(0, targetAt - ABOVE);
      } else {
        end = Math.min(n, targetAt + WINDOW_AFTER + 1);
        if (end >= n - ABOVE) end = n;
      }
    }
  }

  const next = rangeToWindow(messages, start, end);
  const changed = next.from !== win.from || next.to !== win.to;
  return { range: { start, end, atBottom: end >= n }, next, changed };
}

/** A window centered on `at`, snapping its lower edge to the live bottom when close to it. */
export function windowAround(messages: readonly MessageRecord[], at: number): ChatWindow {
  const n = messages.length;
  const start = Math.max(0, at - WINDOW_BEFORE);
  let end = Math.min(n, at + WINDOW_AFTER + 1);
  if (end >= n - ABOVE) end = n;
  return rangeToWindow(messages, start, end);
}

/** Expands the window upward by up to `MORE_DRAWN` messages. */
export function expandOlder(messages: readonly MessageRecord[], range: WindowRange, win: ChatWindow): ChatWindow {
  if (range.start <= 0) return win;
  const nextStart = Math.max(0, range.start - MORE_DRAWN);
  return { from: nextStart > 0 ? messages[nextStart]!.id : null, to: win.to };
}

/** Expands the window downward by up to `MORE_DRAWN` messages, releasing `to` once the live bottom is reached. */
export function expandNewer(messages: readonly MessageRecord[], range: WindowRange, win: ChatWindow): ChatWindow {
  const n = messages.length;
  if (range.end >= n) return win;
  const nextEnd = Math.min(n, range.end + MORE_DRAWN);
  return { from: win.from, to: nextEnd >= n ? null : messages[nextEnd - 1]!.id };
}

/** Bottom-anchored window showing the latest messages. */
export function latestWindow(messages: readonly MessageRecord[]): ChatWindow {
  const n = messages.length;
  return n > FIRST_DRAWN ? { from: messages[n - FIRST_DRAWN]!.id, to: null } : { from: null, to: null };
}

function rangeToWindow(messages: readonly MessageRecord[], start: number, end: number): ChatWindow {
  const n = messages.length;
  return {
    from: start > 0 ? messages[start]!.id : null,
    to: end >= n ? null : messages[end - 1]!.id,
  };
}
