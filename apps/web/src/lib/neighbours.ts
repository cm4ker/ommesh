/**
 * A repeater's neighbour list read for the map: each neighbour matched to
 * the contact its prefix names, how long ago it was heard as of now, and
 * whether that is so long ago it may be gone. The repeater keeps a
 * neighbour until its table fills, however long ago it last heard it.
 */

import type { ContactRecord, NeighbourList, SessionState } from "@meshnet/meshcore";
import { distanceKm, hasPosition } from "./geo.js";

/** Heard longer ago than this, s, a neighbour is drawn faint: it may have gone. */
export const STALE_S = 86_400;

/** How many a request brings back: the page in the node's screens asks for as many. */
export const PAGE = 10;

export interface NeighbourRow {
  prefix: string;
  snr: number;
  /** Seconds since the repeater last heard it, as of now rather than of the answer. */
  heardS: number;
  contact: ContactRecord | null;
  /** Whether the contact has a position, so a line can be drawn to it. */
  placed: boolean;
  /** How far it is from the repeater, km, when both have a position. */
  km: number | null;
  stale: boolean;
}

/** The contact a neighbour's prefix names, if one does. */
export function contactOfPrefix(contacts: Record<string, ContactRecord>, prefix: string): ContactRecord | null {
  if (!prefix) return null;
  for (const c of Object.values(contacts)) if (c.key.startsWith(prefix)) return c;
  return null;
}

/**
 * How the list goes (#75): strongest first, or the one heard last first. The
 * repeater keeps a neighbour it heard well a day ago above one it hears now,
 * so the second shows who is about it at the moment.
 */
export type NeighbourSort = "signal" | "heard";

const bySignal = (a: NeighbourRow, b: NeighbourRow) => b.snr - a.snr || a.heardS - b.heardS;
const byHeard = (a: NeighbourRow, b: NeighbourRow) => a.heardS - b.heardS || b.snr - a.snr;

/** The neighbours of `key` fetched so far, strongest first unless `order` says otherwise. */
export function neighbourRows(state: Pick<SessionState, "contacts" | "neighbours">, key: string, now: number, order: NeighbourSort = "signal"): NeighbourRow[] {
  const list = state.neighbours[key];
  if (!list) return [];
  const hub = state.contacts[key];
  const from = hub && hasPosition(hub.lat, hub.lon) ? hub : null;
  const since = Math.max(0, (now - list.at) / 1000);
  return list.neighbours
    .map((n) => {
      const contact = contactOfPrefix(state.contacts, n.prefix);
      const heardS = n.heardSecsAgo + since;
      const placed = !!contact && hasPosition(contact.lat, contact.lon);
      const km = from && placed ? distanceKm(from.lat, from.lon, contact.lat, contact.lon) : null;
      return { prefix: n.prefix, snr: n.snr, heardS, contact, placed, km, stale: heardS > STALE_S };
    })
    .sort(order === "heard" ? byHeard : bySignal);
}

/** Whether the list holds all the repeater said it has. */
export function isComplete(list: NeighbourList | undefined): boolean {
  return !!list && list.neighbours.length >= list.total;
}

/** How `from` hears `to`, from `from`'s own list, when it has been read and names `to`. */
export function heardInList(state: Pick<SessionState, "neighbours">, from: string, to: string, now: number): { snr: number; heardS: number } | null {
  const list = state.neighbours[from];
  const n = list?.neighbours.find((r) => r.prefix && to.startsWith(r.prefix));
  return list && n ? { snr: n.snr, heardS: n.heardSecsAgo + Math.max(0, (now - list.at) / 1000) } : null;
}

/**
 * Which neighbours the map shows (#51): those the repeater hears no worse
 * than `minSnr`, from `fromKm` to `toKm` away from it, and with `recent` only
 * those heard within a day. A null limit lets everyone through. A neighbour
 * with no position cannot be held to the distance, so the distance leaves it.
 */
export interface NeighbourFilter {
  minSnr: number | null;
  fromKm: number;
  toKm: number | null;
  recent: boolean;
}

export const NO_FILTER: NeighbourFilter = { minSnr: null, fromKm: 0, toKm: null, recent: false };

export function isFiltering(filter: NeighbourFilter | null | undefined): boolean {
  return !!filter && (filter.minSnr !== null || filter.fromKm > 0 || filter.toKm !== null || filter.recent);
}

export function withinDistance(row: NeighbourRow, filter: NeighbourFilter | null | undefined): boolean {
  return !filter || row.km === null || (row.km >= filter.fromKm && (filter.toKm === null || row.km <= filter.toKm));
}

export function passes(row: NeighbourRow, filter: NeighbourFilter | null | undefined): boolean {
  if (!filter) return true;
  if (filter.minSnr !== null && row.snr < filter.minSnr) return false;
  if (filter.recent && row.stale) return false;
  return withinDistance(row, filter);
}

const ROUND_KM = [1, 2, 5, 10, 20, 30, 50, 100, 150, 200, 300, 500];

/** The far end of the distance slider: the farthest neighbour, rounded up to a round number of km. */
export function scaleKm(rows: NeighbourRow[]): number {
  const far = Math.max(0, ...rows.map((r) => r.km ?? 0));
  return ROUND_KM.find((k) => k >= far) ?? Math.ceil(far / 500) * 500;
}

/**
 * A place along the distance slider, 0 to 1, and back. It goes by the
 * square root, so the first few km, where most neighbours are, take a good
 * part of it. A distance read off it is rounded to what a finger can pick:
 * 100 m under a km, half a km under 10, whole km beyond.
 */
export function kmToPlace(km: number, max: number): number {
  return Math.sqrt(Math.min(Math.max(km, 0), max) / max);
}

export function placeToKm(place: number, max: number): number {
  const km = max * place * place;
  return km < 1 ? Math.round(km * 10) / 10 : km < 10 ? Math.round(km * 2) / 2 : Math.round(km);
}

/** The distances written under the slider: round ones, far enough apart to be read, and its far end. */
export function kmTicks(max: number): number[] {
  const ticks = [0];
  for (const k of [...ROUND_KM.filter((k) => k < max), max]) {
    // The far end always shows; a round number too close to it gives way.
    if (kmToPlace(k, max) - kmToPlace(ticks.at(-1)!, max) >= 0.1 && (k === max || 1 - kmToPlace(k, max) >= 0.1)) ticks.push(k);
  }
  return ticks;
}
