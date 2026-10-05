/**
 * A point put on the map for where a repeater, room or sensor stands (#79).
 * The picker leaves it here and goes back; the node's settings take it into
 * their latitude and longitude, to go to the node with Apply like any other
 * change. On a phone the settings wait under the picker, on a desktop they
 * are drawn again after it, so the point stays until they take it.
 */

import { useSyncExternalStore } from "react";

export interface PickedPlace {
  key: string;
  lat: number;
  lon: number;
}

let picked: PickedPlace | null = null;
const listeners = new Set<() => void>();

export function putPickedPlace(next: PickedPlace | null): void {
  picked = next;
  for (const listener of listeners) listener();
}

/** The point put for this node, until it is taken. */
export function usePickedPlace(key: string): PickedPlace | null {
  const value = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => picked,
  );
  return value?.key === key ? value : null;
}

/** A degree as the node's field shows it: five decimals, about a metre, with no zeros trailing. */
export function degreeText(value: number): string {
  return String(Number(value.toFixed(5)));
}
