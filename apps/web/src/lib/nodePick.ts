/**
 * Nodes picked in the Mesh list to be taken off the radio together (#93):
 * held on a touch screen, or picked with Ctrl and a click or a right click
 * with a mouse. While any are picked, a tap picks or lets go and Shift and a
 * click adds a stretch. Only those the list still shows count: a search that
 * hides a picked node keeps it out of what goes, and clearing the search
 * brings it back, still picked.
 */

import { useSyncExternalStore } from "react";
import { idsBetween } from "./messagePick.js";

export interface NodePick {
  keys: readonly string[];
  /** The node picked or let go last, where Shift and a click starts from. */
  last: string | null;
}

let pick: NodePick | null = null;
const listeners = new Set<() => void>();

/** Nothing left picked ends the picking. */
function set(next: NodePick | null): void {
  pick = next && next.keys.length ? next : null;
  for (const listener of listeners) listener();
}

export function nodePick(): NodePick | null {
  return pick;
}

export function useNodePick(): NodePick | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => pick,
  );
}

export function startNodePick(key: string): void {
  set({ keys: [key], last: key });
}

export function toggleNodePick(key: string): void {
  const keys = pick?.keys ?? [];
  set({ keys: keys.includes(key) ? keys.filter((k) => k !== key) : [...keys, key], last: key });
}

/** Shift and a click: every node from the one picked last up to this one, in the list's `order`. */
export function extendNodePick(order: readonly string[], key: string): void {
  if (!pick?.last) return toggleNodePick(key);
  set({ keys: [...new Set([...pick.keys, ...idsBetween(order, pick.last, key)])], last: key });
}

/** All of `order` picked, or, when they all are, let go. */
export function toggleAllNodes(order: readonly string[]): void {
  set({ keys: toggledAll(order, pick?.keys ?? []), last: pick?.last ?? null });
}

export function endNodePick(): void {
  if (pick) set(null);
}

/** Those of `keys` the list shows, in its `order`. */
export function pickedShown(keys: readonly string[], order: readonly string[]): string[] {
  const wanted = new Set(keys);
  return order.filter((k) => wanted.has(k));
}

/** Every node of `order` added to `keys`, or, when every one is there already, taken out; those it does not show stay as they are. */
export function toggledAll(order: readonly string[], keys: readonly string[]): string[] {
  const all = order.length > 0 && order.every((k) => keys.includes(k));
  if (all) {
    const shown = new Set(order);
    return keys.filter((k) => !shown.has(k));
  }
  return [...new Set([...keys, ...order])];
}
