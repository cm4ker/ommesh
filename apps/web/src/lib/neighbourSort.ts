import { useSyncExternalStore } from "react";
import type { Key } from "../i18n/index.js";
import type { NeighbourSort } from "./neighbours.js";
import { readSetting, writeSetting } from "./storage.js";

/**
 * How the neighbours over the map are listed (#75), kept on this device like
 * the chat list's order: whoever picks the one heard last first wants it for
 * every repeater they look at.
 */

/** The orders, their words as keys: `t()` them while drawing. */
export const NEIGHBOUR_SORTS: readonly { id: NeighbourSort; label: Key; short: Key }[] = [
  { id: "signal", label: "tools.nb.sortSignal", short: "tools.nb.sortSignalShort" },
  { id: "heard", label: "tools.nb.sortHeard", short: "tools.nb.sortHeardShort" },
];

const KEY = "meshnet.neighbourSort";

let sort: NeighbourSort = NEIGHBOUR_SORTS.find((s) => s.id === readSetting<string | null>(KEY, null))?.id ?? "signal";
const listeners = new Set<() => void>();

export function setNeighbourSort(next: NeighbourSort): void {
  sort = next;
  writeSetting(KEY, next);
  for (const listener of listeners) listener();
}

export function useNeighbourSort(): NeighbourSort {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => sort,
  );
}
