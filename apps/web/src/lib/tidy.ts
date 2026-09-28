/**
 * Keeping the radio's contacts from filling up. The radio has room for a
 * hundred or so; once full, a new node is not kept, or replaces the oldest
 * contact that is not a favourite. This picks the nodes to take off first:
 * those not heard for a while, never one that is starred, yours, or that you
 * write to. Taking a contact off the radio means its direct messages can no
 * longer be read until it advertises again, so a chat keeps it.
 *
 * Pure but for the per-radio setting, so it is testable without a radio.
 */

import { useSyncExternalStore } from "react";
import { isFavourite, isNodeType, type ContactRecord, type SessionState } from "@meshnet/meshcore";
import type { Key } from "../i18n/index.js";
import { heardAt } from "./nodes.js";
import { readSetting, writeSetting } from "./storage.js";

const DAY_MS = 24 * 3600 * 1000;

/** The choices for "not heard for". */
export const TIDY_DAYS = [7, 30, 90] as const;

/** Past this share of the radio's room, the Mesh list says how full it is. */
export const MEMORY_WARN = 0.9;

export type KeepReason = "favourite" | "yours" | "chat";

/** Keys of the words for each reason, read with `t()` where they are shown. */
export const KEEP_LABELS: Record<KeepReason, Key> = {
  favourite: "contacts.keep.favourite",
  yours: "contacts.keep.yours",
  chat: "contacts.keep.chat",
};

/** Repeaters, rooms and sensors you have signed in to, asked for their status, or kept a password for. */
export function isYours(state: SessionState, saved: readonly string[], c: ContactRecord): boolean {
  return isNodeType(c.type) && (state.logins[c.key] !== undefined || state.statusHistory[c.key] !== undefined || saved.includes(c.key));
}

/** The contacts there are messages with. */
export function chatKeys(state: SessionState): Set<string> {
  const keys = new Set<string>();
  for (const m of state.messages) if (m.conversation.startsWith("c:")) keys.add(m.conversation.slice(2));
  return keys;
}

/** Why a contact is never taken off by a clean-up, or null. */
export function keepReason(state: SessionState, saved: readonly string[], chats: ReadonlySet<string>, c: ContactRecord): KeepReason | null {
  if (isFavourite(c)) return "favourite";
  if (isYours(state, saved, c)) return "yours";
  if (chats.has(c.key)) return "chat";
  return null;
}

export interface TidyPlan {
  /** Not heard for the days asked and not kept for a reason; the longest quiet first. */
  remove: ContactRecord[];
  /** Not heard for as long, but kept: starred, yours, or with a chat. */
  kept: { contact: ContactRecord; reason: KeepReason }[];
}

/** What a clean-up of the nodes not heard for `days` would take off the radio. */
export function tidyPlan(state: SessionState, saved: readonly string[], days: number, now: number): TidyPlan {
  const chats = chatKeys(state);
  const before = now - days * DAY_MS;
  const quiet = Object.values(state.contacts)
    .filter((c) => !c.unsaved && heardAt(c) < before)
    .sort((a, b) => heardAt(a) - heardAt(b));
  const plan: TidyPlan = { remove: [], kept: [] };
  for (const c of quiet) {
    const reason = keepReason(state, saved, chats, c);
    if (reason) plan.kept.push({ contact: c, reason });
    else plan.remove.push(c);
  }
  return plan;
}

/** How many contacts the radio holds and has room for; null before it said. */
export function memoryUse(state: SessionState): { used: number; max: number } | null {
  const max = state.device?.maxContacts ?? 0;
  if (!max) return null;
  let used = 0;
  for (const c of Object.values(state.contacts)) if (!c.unsaved) used++;
  return { used, max };
}

/** Whether the Mesh list should say how full the radio is. */
export function memoryTight(state: SessionState): boolean {
  const use = memoryUse(state);
  return state.contactsFull || (!!use && use.used >= use.max * MEMORY_WARN);
}

// ---- the rule, per radio: 0 is off ----

const listeners = new Set<() => void>();
const settingKey = (radioKey: string) => `meshnet.tidy.${radioKey}`;

export function tidyDays(radioKey: string): number {
  const days = readSetting<number>(settingKey(radioKey), 0);
  return typeof days === "number" && days > 0 ? days : 0;
}

export function setTidyDays(radioKey: string, days: number): void {
  writeSetting(settingKey(radioKey), days > 0 ? days : null);
  for (const listener of listeners) listener();
}

export function useTidyDays(radioKey: string | null): number {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => (radioKey ? tidyDays(radioKey) : 0),
  );
}
