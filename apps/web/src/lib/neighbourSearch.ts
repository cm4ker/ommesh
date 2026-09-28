/**
 * A repeater's search for its neighbours: the command, the wait while they
 * answer, the list read after. Kept per repeater while the app runs, so the
 * search goes on and its outcome waits when the reader leaves the page.
 */

import { useSyncExternalStore } from "react";
import { NoReplyError, NodeCommandError } from "@meshnet/meshcore";
import { errorText } from "../i18n/errors.js";
import { t } from "../i18n/index.js";
import { session } from "./session.js";

export interface NeighbourSearchState {
  running: boolean;
  /** Local ms when the neighbours will have had time to answer; null until the repeater says it called them. */
  until: number | null;
  /** How long that wait is, ms. */
  waitMs: number;
  /** When the search ended, local ms; its outcome stands until the list is read again after it. */
  at: number;
  /** The prefixes that answered, and those of them that are new (null when that cannot be told). */
  answered: string[];
  fresh: string[] | null;
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

function failure(error: unknown): string {
  if (error instanceof NoReplyError) return t("node.neighbours.noReply", { seconds: /(\d+) s$/.exec(error.message)?.[1] ?? "?" });
  if (error instanceof NodeCommandError) return /^unknown/i.test(error.reply.trim()) ? t("node.search.oldFirmware") : t("node.search.refused", { reply: error.reply });
  return errorText(error);
}

export async function searchNeighbours(key: string): Promise<void> {
  if (searches.get(key)?.running || session.getState().status !== "ready") return;
  const base: NeighbourSearchState = { running: true, until: null, waitMs: 0, at: 0, answered: [], fresh: null, error: null };
  set(key, base);
  try {
    const found = await session.searchNeighbours(key, (waitMs) => set(key, { ...base, until: Date.now() + waitMs, waitMs }));
    set(key, { ...base, running: false, waitMs: searches.get(key)?.waitMs ?? 0, at: found.list.at, answered: found.answered, fresh: found.fresh });
  } catch (error) {
    set(key, { ...base, running: false, at: Date.now(), error: failure(error) });
  }
}
