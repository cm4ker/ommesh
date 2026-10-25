/**
 * Hiding the repeaters, rooms and sensors not heard for days from the Mesh
 * list and the map, while the radio keeps them (#101): one that advertises
 * again comes back at once. People are never hidden, since a phone advertises
 * only when its owner says so, and neither are the starred. Kept on this
 * device, like the list's order.
 */

import { useSyncExternalStore } from "react";
import { isFavourite, isNodeType, type ContactRecord } from "@meshnet/meshcore";
import type { Key } from "../i18n/index.js";
import { readSetting, writeSetting } from "./storage.js";

const DAY_MS = 24 * 3600 * 1000;

export type SilentDays = 7 | 30 | 90 | null;

/**
 * The choices, each with the key of its name and of how long it is inside a sentence ("for over a month").
 * A repeater floods its advert every 47 hours by default, so none is shorter than a week.
 */
export const SILENT_CHOICES: readonly { days: SilentDays; label: Key; span: Key | null }[] = [
  { days: null, label: "mesh.silent.never", span: null },
  { days: 7, label: "mesh.silent.week", span: "mesh.silent.overWeek" },
  { days: 30, label: "mesh.silent.month", span: "mesh.silent.overMonth" },
  { days: 90, label: "mesh.silent.months3", span: "mesh.silent.overMonths3" },
];

const KEY = "meshnet.silentNodes";

function read(): SilentDays {
  const saved = readSetting<unknown>(KEY, null);
  return SILENT_CHOICES.find((c) => c.days === saved)?.days ?? null;
}

let days = read();
const listeners = new Set<() => void>();

export function setSilentDays(next: SilentDays): void {
  days = next;
  writeSetting(KEY, next);
  for (const listener of listeners) listener();
}

export function useSilentDays(): SilentDays {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => days,
  );
}

/**
 * When the radio or this app last had word of the node, local ms, by their own
 * clocks and never the node's. A repeater restarted without its clock stamps
 * its adverts in the past and the radio drops them, so the advert's stamp
 * counts only for a contact the radio never stamped. The radio's stamp also
 * moves when this app writes the contact; that keeps a node shown, never hides one.
 */
export function lastWord(c: ContactRecord, now: number): number {
  const radio = c.lastMod > 0 ? c.lastMod * 1000 : Math.min(c.lastAdvert * 1000, now);
  return Math.max(c.lastHeardAt ?? 0, radio);
}

/** Whether the node is one to hide for its silence: a repeater, a room or a sensor, not starred, unheard this many days. */
export function isSilent(c: ContactRecord, silentDays: SilentDays, now: number): boolean {
  return silentDays !== null && isNodeType(c.type) && !isFavourite(c) && now - lastWord(c, now) >= silentDays * DAY_MS;
}
