/**
 * The repeaters to pick from for the next relay of a route set by hand, in
 * the order a way is likeliest to go: first those the link book has heard
 * next to the relay before the one being picked, the surest link first, then
 * the rest by when they were last heard. A repeater needs no place on the
 * map to be picked here, which is the point: the radio keeps a route as
 * hashes, and only the map needs to know where a node stands.
 */

import { AdvType, type ContactRecord, type SessionState } from "@meshnet/meshcore";
import { isUnresolved, resolver, SELF, type Graph } from "./linkGraph.js";
import { fold } from "./messageSearch.js";
import { hasPosition } from "./geo.js";
import { heardAt } from "./nodes.js";

export interface RelayChoice {
  /** What goes in the route: a contact's key, or a hash that names no repeater on the radio. */
  key: string;
  contact: ContactRecord | null;
  /** How likely the step from the relay before it gets through, as the link book has it. */
  chance: number;
  /** Whether it has been heard next to the node the route leads to. */
  nearEnd: boolean;
  placed: boolean;
}

export interface RelayChoices {
  near: RelayChoice[];
  rest: RelayChoice[];
}

export interface PickInput {
  /** The relay the picked one follows, as the route holds it (a key or a hash), or "self". */
  prev: string;
  /** The contact the route leads to. */
  target: string;
  /** The relays already in the route, as keys or hashes: none of them is offered again. */
  taken: string[];
  query: string;
  /** Bytes a hash takes in this route: a hash heard shorter cannot stand in it. */
  size: number;
}

/** The likeliest link between two nodes of the graph, either way, 0 for none. */
function linked(g: Graph, a: string, b: string): number {
  return Math.max(g.edges.get(a)?.get(b) ?? 0, g.edges.get(b)?.get(a) ?? 0);
}

/**
 * The graph's names for a repeater: its key, and the hashes it would be heard
 * as when they name more than one node, since the book keeps those as hashes.
 */
function namesOf(key: string): string[] {
  return [key, `#${key.slice(0, 2)}`, `#${key.slice(0, 4)}`, `#${key.slice(0, 6)}`];
}

function best(g: Graph, from: string, names: string[]): number {
  return Math.max(0, ...names.map((n) => linked(g, from, n)));
}

export function relayChoices(state: Pick<SessionState, "contacts">, g: Graph, input: PickInput): RelayChoices {
  const resolve = resolver(state.contacts);
  const prev = input.prev === SELF ? SELF : resolve(input.prev);
  const target = input.target;
  const isTaken = (key: string) => key === target || input.taken.some((t) => t === key || key.startsWith(t) || t.startsWith(key));
  const q = fold(input.query.trim());
  const hex = /^[0-9a-f]+$/i.test(q) ? q.toLowerCase() : null;
  const matches = (key: string, name: string) => !q || fold(name).includes(q) || (hex !== null && key.startsWith(hex));

  const choices: RelayChoice[] = [];
  for (const c of Object.values(state.contacts)) {
    if (c.type !== AdvType.Repeater || isTaken(c.key) || !matches(c.key, c.name)) continue;
    const names = namesOf(c.key);
    choices.push({ key: c.key, contact: c, chance: best(g, prev, names), nearEnd: best(g, target, names) > 0, placed: hasPosition(c.lat, c.lon) });
  }
  // Repeaters the book has heard but the radio knows by no advert: their hash is all there is to name them by.
  for (const node of g.relays) {
    if (!isUnresolved(node)) continue;
    const hash = node.slice(1);
    if (hash.length < input.size * 2 || isTaken(hash) || !matches(hash, "")) continue;
    if (Object.values(state.contacts).some((c) => c.key.startsWith(hash))) continue;
    const chance = linked(g, prev, node);
    if (chance > 0) choices.push({ key: hash, contact: null, chance, nearEnd: linked(g, target, node) > 0, placed: false });
  }

  const heard = (c: RelayChoice) => (c.contact ? heardAt(c.contact) : 0);
  const near = choices.filter((c) => c.chance > 0).sort((a, b) => b.chance - a.chance || heard(b) - heard(a));
  const rest = choices.filter((c) => c.chance === 0).sort((a, b) => heard(b) - heard(a) || a.key.localeCompare(b.key));
  return { near, rest };
}
