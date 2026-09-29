/**
 * The one session, and the hooks that read it.
 *
 * `useSyncExternalStore` over the session's snapshot: every component that
 * reads state re-renders on every change, which is fine for a client whose
 * whole state is a few hundred rows. The one exception is the event log: the
 * radio adds to it for nearly every packet it hears, and the few screens that
 * show it read it with `useSelector`.
 */

import { useSyncExternalStore } from "react";
import { MeshSession, type SessionState } from "@meshnet/meshcore";
import { IndexedDbStorage } from "./storage.js";
import { pushTrace } from "./trace.js";

export const storage = new IndexedDbStorage();

export const session = new MeshSession({
  appName: "Ommesh",
  storage,
  trace: pushTrace,
});

/** Parts of the state that change with the traffic on the air and that `useSession` leaves out. */
const QUIET: ReadonlySet<string> = new Set<keyof SessionState>(["log"]);

/**
 * The state as `useSession` last showed it. It moves on when anything but a quiet part
 * changes, and then carries the quiet parts as they are by that time.
 */
let shown = session.getState();
const shownListeners = new Set<() => void>();
session.subscribe(() => {
  const next = session.getState();
  if (next === shown) return;
  const loud = (Object.keys(next) as (keyof SessionState)[]).some((key) => !QUIET.has(key) && next[key] !== shown[key]);
  if (!loud) return;
  shown = next;
  for (const listener of shownListeners) listener();
});

function subscribeShown(listener: () => void): () => void {
  shownListeners.add(listener);
  return () => shownListeners.delete(listener);
}

/** The whole state, except that a change to a quiet part alone (the log) does not re-render. */
export function useSession(): SessionState {
  return useSyncExternalStore(subscribeShown, () => shown);
}

export function useSelector<T>(select: (state: SessionState) => T): T {
  return useSyncExternalStore(
    (listener) => session.subscribe(listener),
    () => select(session.getState()),
  );
}
