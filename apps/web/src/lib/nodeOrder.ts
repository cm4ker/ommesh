import { useSyncExternalStore } from "react";
import { contactHops, isFavourite, type ContactRecord, type SessionState } from "@meshnet/meshcore";
import type { Key } from "../i18n/index.js";
import { distanceKm, hasPosition } from "./geo.js";
import { heardAt } from "./nodes.js";
import { readSetting, writeSetting } from "./storage.js";

/**
 * How the Mesh list is ordered, and whether the starred come first or fall in
 * with everyone else. Kept on this device, like the theme.
 */

export type NodeOrder = "heard" | "name" | "near" | "relays";

/** Each order and the key of its name, which the view reads with `t()`. */
export const NODE_ORDERS: readonly { id: NodeOrder; label: Key }[] = [
  { id: "heard", label: "mesh.order.heard" },
  { id: "name", label: "mesh.order.name" },
  { id: "near", label: "mesh.order.near" },
  { id: "relays", label: "mesh.order.relays" },
];

export interface NodeOrderPrefs {
  order: NodeOrder;
  /** Favourites above the rest. */
  pinned: boolean;
}

const KEY = "meshnet.nodeOrder.2";
/** Where it was kept while the groups were on by default: the order chosen there is carried over, the groups start off. */
const OLD_KEY = "meshnet.nodeOrder";

function read(): NodeOrderPrefs {
  const saved = readSetting<Partial<NodeOrderPrefs> | null>(KEY, null);
  const old = saved ? null : readSetting<Partial<NodeOrderPrefs> | null>(OLD_KEY, null);
  const order = NODE_ORDERS.find((o) => o.id === (saved ?? old)?.order)?.id ?? "heard";
  return { order, pinned: typeof saved?.pinned === "boolean" ? saved.pinned : false };
}

/** How the list stands when nothing has been changed. */
export const DEFAULT_NODE_ORDER: NodeOrderPrefs = { order: "heard", pinned: false };

let prefs = read();
const listeners = new Set<() => void>();

export function setNodeOrder(patch: Partial<NodeOrderPrefs>): void {
  prefs = { ...prefs, ...patch };
  writeSetting(KEY, prefs);
  for (const listener of listeners) listener();
}

export function getNodeOrder(): NodeOrderPrefs {
  return prefs;
}

export function useNodeOrder(): NodeOrderPrefs {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => prefs,
  );
}

/** Whether this radio knows where it is, which the nearest-first order needs. */
export function placed(self: SessionState["self"]): boolean {
  return !!self && hasPosition(self.lat, self.lon);
}

/** The order in force: without a position of its own the radio cannot say who is nearest, and the list goes by last heard. */
export function orderInForce(order: NodeOrder, self: SessionState["self"]): NodeOrder {
  return order === "near" && !placed(self) ? "heard" : order;
}

const byName = (a: ContactRecord, b: ContactRecord) => (a.name || a.prefix).localeCompare(b.name || b.prefix);
const byHeard = (a: ContactRecord, b: ContactRecord) => heardAt(b) - heardAt(a) || byName(a, b);

/**
 * Compares two nodes in the order. A node without what the order goes by, a
 * position or a route, comes after those with it, and among its like the
 * newest heard first.
 */
export function nodeComparator(order: NodeOrder, self: SessionState["self"]): (a: ContactRecord, b: ContactRecord) => number {
  const by = (measure: (c: ContactRecord) => number) => {
    const known = new Map<string, number>();
    const of = (c: ContactRecord) => {
      let v = known.get(c.key);
      if (v === undefined) known.set(c.key, (v = measure(c)));
      return v;
    };
    // Infinity less Infinity is NaN, which falls through to the last heard like a tie.
    return (a: ContactRecord, b: ContactRecord) => of(a) - of(b) || byHeard(a, b);
  };
  switch (orderInForce(order, self)) {
    case "name":
      return byName;
    case "near":
      return by((c) => (hasPosition(c.lat, c.lon) ? distanceKm(self!.lat, self!.lon, c.lat, c.lon) : Infinity));
    case "relays":
      return by((c) => contactHops(c) ?? Infinity);
    default:
      return byHeard;
  }
}

/**
 * With favourites pinned: the starred first, then the rest, each still in the
 * order and with no heading between them. Unpinned, the rows as they are. Nodes
 * of yours are not pinned: a guest login to someone else's repeater makes it
 * "yours", and those would hang at the top of the list.
 */
export function pinnedFirst(rows: ContactRecord[], pinned: boolean): ContactRecord[] {
  if (!pinned) return rows;
  const rank = (c: ContactRecord) => (isFavourite(c) ? 0 : 1);
  return [...rows].sort((a, b) => rank(a) - rank(b));
}
