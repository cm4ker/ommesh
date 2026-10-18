/**
 * A radio's history as the storage keeps it: a head with all but the messages,
 * and the messages in parts of `PART` in their order. Saved whole, the history
 * (megabytes, nearly all of it messages) was written again on every change: on
 * an iPhone that came to gigabytes a day, and the web view's storage process ran
 * out of memory on it and took the database down with it. Now a save writes
 * only the parts that changed, which is mostly the last one.
 *
 * Pure, so it is testable without a database: `storage.ts` turns the plan into
 * records.
 */

import type { MessageRecord, PersistedState } from "@meshnet/meshcore";

/** Messages per part: some 100 KB of them. */
export const PART = 200;

export type Head = Omit<PersistedState, "messages"> & { parts: number };

/** What was last written for a radio, to tell what changed since. */
export interface Layout {
  head: Head;
  parts: MessageRecord[][];
}

export interface SavePlan {
  /** Null when the head is as written. */
  head: Head | null;
  /** The parts to write, by number. */
  parts: Map<number, MessageRecord[]>;
  /** Parts past the new last one, by number, to remove; "all" when what is stored is not known. */
  drop: number[] | "all";
  /** What is stored once the plan is carried out. */
  layout: Layout;
}

function headOf(history: PersistedState, parts: number): Head {
  const { messages: _omit, ...rest } = history;
  return { ...rest, parts };
}

/** Whether two records hold the same values, field by field; a list or record in them by reference. */
function sameRecord(a: object, b: object): boolean {
  if (a === b) return true;
  const ak = Object.keys(a);
  if (ak.length !== Object.keys(b).length) return false;
  for (const key of ak) if ((a as Record<string, unknown>)[key] !== (b as Record<string, unknown>)[key]) return false;
  return true;
}

function samePart(a: MessageRecord[] | undefined, b: MessageRecord[]): boolean {
  if (!a || a.length !== b.length) return false;
  for (let i = 0; i < b.length; i++) if (!sameRecord(a[i]!, b[i]!)) return false;
  return true;
}

/** `layout`: what was written last, or null when that is not known and everything is written afresh. */
export function planSave(layout: Layout | null, history: PersistedState): SavePlan {
  const parts: MessageRecord[][] = [];
  for (let i = 0; i < history.messages.length; i += PART) parts.push(history.messages.slice(i, i + PART));
  const head = headOf(history, parts.length);
  const put = new Map<number, MessageRecord[]>();
  parts.forEach((part, i) => {
    if (!layout || !samePart(layout.parts[i], part)) put.set(i, part);
  });
  let drop: number[] | "all" = "all";
  if (layout) {
    drop = [];
    for (let i = parts.length; i < layout.parts.length; i++) drop.push(i);
  }
  return { head: layout && sameRecord(layout.head, head) ? null : head, parts: put, drop, layout: { head, parts } };
}

/** A history from its head and its parts as read; parts past the head's count, left by a failed write, are not taken. */
export function assemble(head: Head, parts: MessageRecord[][]): { history: PersistedState; layout: Layout } {
  const taken = parts.slice(0, head.parts);
  const { parts: _count, ...rest } = head;
  return { history: { ...rest, messages: taken.flat() }, layout: { head, parts: taken } };
}
