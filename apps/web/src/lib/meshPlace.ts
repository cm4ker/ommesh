/**
 * A place from a chat shown on the Mesh map: a pin there, brought into view,
 * with the map's own tools at hand (a long press for a line of sight). It stays
 * until the map is tapped elsewhere or a node or a tool takes the map.
 */

import { useSyncExternalStore } from "react";
import { setStack } from "./nav.js";

export interface MeshPlace {
  lat: number;
  lon: number;
  /** Changes with each showing, so the same place shown twice is brought into view twice. */
  id: number;
}

let shown: MeshPlace | null = null;
let count = 0;
const listeners = new Set<() => void>();

function set(next: MeshPlace | null): void {
  shown = next;
  for (const listener of listeners) listener();
}

export function showPlaceOnMesh(lat: number, lon: number): void {
  set({ lat, lon, id: ++count });
  setStack("mesh", [], { meshFocus: null });
}

export function clearMeshPlace(): void {
  if (shown) set(null);
}

export function useMeshPlace(): MeshPlace | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => shown,
  );
}
