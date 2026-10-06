/**
 * A repeater's search for its neighbours: the command, the wait while they
 * answer, the list read after. A reset is the same search after the
 * repeater forgets them all. Kept per repeater while the app runs, so the
 * search goes on and its outcome waits when the reader leaves the page.
 */

import { useSyncExternalStore } from "react";
import { NoReplyError, NodeCommandError } from "@meshnet/meshcore";
import { errorText } from "../i18n/errors.js";
import { t } from "../i18n/index.js";
import { session } from "./session.js";

export interface NeighbourSearchState {
  running: boolean;
  /** Whether the list was reset first. */
  reset: boolean;
  /** Local ms when the neighbours will have had time to answer; null until the repeater says it called them. */
  until: number | null;
  /** How long that wait is, ms. */
  waitMs: number;
  /** When the search ended, local ms; its outcome stands until the list is read again after it. */
  at: number;
  /** The prefixes that answered, and those of them that are new (null when that cannot be told). */
  answered: string[];
  fresh: string[] | null;
  /** How many answered: after a reset, the whole list, of which only a page is read. */
  heard: number;
  /** After a reset, the neighbours held before that did not answer, when that can be told. */
  gone: number | null;
  /** False after a reset on firmware that cannot call the neighbours. */
  called: boolean;
  error: string | null;
}

const searches = new Map<string, NeighbourSearchState>();
const listeners = new Set<() => void>();

function set(key: string, value: NeighbourSearchState): void {
  searches.set(key, value);
  for (const listener of listeners) listener();
}

export function useNeighbourSearch(key: string): NeighbourSearchState | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => searches.get(key) ?? null,
  );
}

/** Keeps a search's outcome over a page of the list read after it, which would otherwise end it. */
export function keepSearch(key: string, at: number): void {
  const search = searches.get(key);
  if (search && !search.running) set(key, { ...search, at });
}

function failure(error: unknown, reset: boolean): string {
  if (error instanceof NoReplyError) return t("node.neighbours.noReply", { seconds: /(\d+) s$/.exec(error.message)?.[1] ?? "?" });
  if (error instanceof NodeCommandError) {
    if (/^unknown/i.test(error.reply.trim())) return reset ? t("node.reset.oldFirmware") : t("node.search.oldFirmware");
    return t("node.search.refused", { reply: error.reply });
  }
  return errorText(error);
}

export function searchNeighbours(key: string): Promise<void> {
  return run(key, false);
}

/** Has the repeater forget all its neighbours, then call them again. */
export function resetNeighbours(key: string): Promise<void> {
  return run(key, true);
}

async function run(key: string, reset: boolean): Promise<void> {
  if (searches.get(key)?.running || session.getState().status !== "ready") return;
  const base: NeighbourSearchState = { running: true, reset, until: null, waitMs: 0, at: 0, answered: [], fresh: null, heard: 0, gone: null, called: true, error: null };
  set(key, base);
  const onCalled = (waitMs: number) => set(key, { ...base, until: Date.now() + waitMs, waitMs });
  try {
    const waited = () => searches.get(key)?.waitMs ?? 0;
    if (reset) {
      const found = await session.resetNeighbours(key, onCalled);
      set(key, { ...base, running: false, waitMs: waited(), at: found.list.at, answered: found.answered, fresh: found.fresh, heard: found.list.total, gone: found.gone, called: found.called });
    } else {
      const found = await session.searchNeighbours(key, onCalled);
      set(key, { ...base, running: false, waitMs: waited(), at: found.list.at, answered: found.answered, fresh: found.fresh, heard: found.answered.length });
    }
  } catch (error) {
    set(key, { ...base, running: false, at: Date.now(), error: failure(error, reset) });
  }
}
