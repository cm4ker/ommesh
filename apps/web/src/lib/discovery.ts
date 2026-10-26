/**
 * Path discoveries, kept per contact while the app runs: the flood going
 * out, the way it found there and the way the answer came back, and the
 * route the radio held before, to put back. The map draws what one found,
 * until the next ping along the route. Only a tap starts one.
 */

import { contactRoute, NoReplyError, type PathFound } from "@meshnet/meshcore";
import { useSyncExternalStore } from "react";
import { errorText } from "../i18n/errors.js";
import { clearPing } from "./ping.js";
import { session } from "./session.js";

export interface Discovery {
  key: string;
  running: boolean;
  /** Local ms it was asked. */
  at: number;
  found: PathFound | null;
  /** The route held before, as hashes, and when it was learned; null when there was none. */
  before: { relays: string[]; since: number | null } | null;
  /** The node stayed silent. */
  silent: boolean;
  /** How long it was waited for, s. */
  waitedS: number;
  /** How long the answer took, ms; null until one came. */
  tookMs: number | null;
  error: string | null;
}

const discoveries = new Map<string, Discovery>();
const listeners = new Set<() => void>();

function publish(d: Discovery): void {
  discoveries.set(d.key, d);
  for (const listener of listeners) listener();
}

export function useDiscovery(key: string | null): Discovery | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => (key ? (discoveries.get(key) ?? null) : null),
  );
}

export function getDiscovery(key: string): Discovery | null {
  return discoveries.get(key) ?? null;
}

/** Floods the request and waits for the answer; what it found becomes the route (MeshSession.discoverPath). */
export async function discover(key: string): Promise<Discovery> {
  const contact = session.getState().contacts[key];
  const held = contact ? contactRoute(contact) : null;
  const base: Discovery = {
    key,
    running: true,
    at: Date.now(),
    found: null,
    before: held ? { relays: held, since: contact?.pathSince ?? null } : null,
    silent: false,
    waitedS: 0,
    tookMs: null,
    error: null,
  };
  publish(base);
  try {
    const found = await session.discoverPath(key);
    // What a ping measured was along the route it replaced.
    if (found.changed && found.kept) clearPing(key);
    const done = { ...base, running: false, found, tookMs: Date.now() - base.at };
    publish(done);
    return done;
  } catch (error) {
    const done = { ...base, running: false, silent: error instanceof NoReplyError, waitedS: Math.round((Date.now() - base.at) / 1000), error: errorText(error) };
    publish(done);
    return done;
  }
}

/** Puts back the route held before the discovery, as it was learned. */
export async function undoDiscovery(key: string): Promise<void> {
  const d = discoveries.get(key);
  if (!d?.found?.kept) return;
  if (d.before) await session.setRoute(key, d.before.relays, { learnedAt: d.before.since });
  else await session.resetPath(key);
  forgetDiscovery(key);
}

export function forgetDiscovery(key: string): void {
  if (!discoveries.delete(key)) return;
  for (const listener of listeners) listener();
}
