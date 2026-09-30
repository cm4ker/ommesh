/**
 * What the map draws over the nodes: the route to the node picked, coloured
 * by what a ping measured along it; a route being changed; a line of sight;
 * the repeaters that answered "who hears me"; a repeater's neighbours. Worked out here from the state,
 * so the map only draws lines and hands their taps and drags back.
 */

import { AdvType, contactRoute, type ContactRecord, type SessionState } from "@meshnet/meshcore";
import { t } from "../i18n/index.js";
import { candidatesOfHash } from "./echoes.js";
import { formatRoundDistance, hasPosition } from "./geo.js";
import { legId } from "./legVerdicts.js";
import type { Discovery } from "./discovery.js";
import type { Hears } from "./hears.js";
import { quality } from "./los.js";
import type { LosEnd, MeshTool, NeighboursTool } from "./meshTool.js";
import { neighbourRows, passes } from "./neighbours.js";
import { legSnr, measuredLegs, type Ping } from "./ping.js";
import { replyScore, type Survey } from "./surveyData.js";

/** `found` is the way a discovery found there, `back` the way its answer came, `was` the route it replaced. */
export type LineTone = "good" | "fair" | "weak" | "fail" | "flight" | "plain" | "unknown" | "dest" | "look" | "found" | "back" | "was";

export interface OverlayLine {
  from: LosEnd;
  to: LosEnd;
  tone: LineTone;
  /** Whether a tap on it opens its line of sight: only a leg whose both ends are known. */
  tappable: boolean;
  /** A word at its middle, for a leg the terrain closes. */
  label?: string | undefined;
  /** How it stands among the rest: heard long ago, behind the one picked, the one picked. */
  mark?: "stale" | "dim" | "on" | "stale dim" | undefined;
}

/**
 * A point of a route a finger can drag onto a node: a relay, to put another
 * in its place, or the middle of a leg, to put one in between.
 */
export interface MapHandle {
  /** `hop` is relay `index` of the route; `gap` is where a relay goes in before relay `index`. */
  kind: "hop" | "gap";
  index: number;
  lat: number;
  lon: number;
  /** The drawn ends either side, joined to the finger while it drags. */
  from: LosEnd | null;
  to: LosEnd | null;
  /** The relay's contact, which a tap on the hop picks. */
  key: string | null;
  /** The relays of the route it belongs to, as hashes or contact keys, this radio's end first. */
  relays: string[];
}

export interface MapOverlay {
  lines: OverlayLine[];
  /** A spot picked on the map. */
  pins: { lat: number; lon: number }[];
  /** Relays of a route being changed, by contact key, numbered in order. */
  numbers: Record<string, number>;
  handles: MapHandle[];
  /** Where a flood is going out from, drawn as rings spreading from it. */
  pulse: { lat: number; lon: number } | null;
  /** How far a filter by distance reaches from a node, drawn as circles round it. */
  rings?: MapRing[];
  /** The repeaters that answered at a survey's point, by key: their names stand out from the rest. */
  heard?: string[];
}

/** A circle `km` round a point, with the distance written on it. */
export interface MapRing {
  lat: number;
  lon: number;
  km: number;
  label: string;
}

/** A survey's point on the map, by its colour; "off" is one where the repeater picked did not answer. */
export interface MapDot {
  lat: number;
  lon: number;
  tone: "good" | "fair" | "weak" | "none" | "off";
}

export const EMPTY_OVERLAY: MapOverlay ={ lines: [], pins: [], numbers: {}, handles: [], pulse: null };

export function selfEnd(state: SessionState): LosEnd | null {
  const self = state.self;
  return self && hasPosition(self.lat, self.lon) ? { lat: self.lat, lon: self.lon, name: t("mesh.you"), key: "self" } : null;
}

export function contactEnd(c: ContactRecord): LosEnd | null {
  return hasPosition(c.lat, c.lon) ? { lat: c.lat, lon: c.lon, name: c.name || c.prefix, key: c.key } : null;
}

/** The contact a hash names, when exactly one relaying contact does and its position is known. */
export function relayOf(hash: string, contacts: Record<string, ContactRecord>): ContactRecord | null {
  const found = candidatesOfHash(hash, contacts);
  return found.length === 1 ? found[0]! : null;
}

/** An antenna's height, m, for a line of sight when nobody has said: a person's hand, a repeater's mast, a mast yet to be put up. */
export function defaultHeight(end: LosEnd, contacts: Record<string, ContactRecord>): number {
  if (end.key === "self") return 1.5;
  if (end.key === null) return 10;
  const type = contacts[end.key]?.type;
  return type === AdvType.Repeater || type === AdvType.Room ? 10 : 1.5;
}

/**
 * The relays of the route drawn to a contact, as hashes: the ones pinged
 * last, which for a repeater with no route are the way its adverts came, or
 * else the route the radio holds. Null when there is neither.
 */
export function shownRelays(contact: ContactRecord, ping: Ping | null): string[] | null {
  if (ping && ping.chain.length && !ping.via && !(ping.search && !ping.search.found)) return ping.targetInChain ? ping.chain.slice(0, -1) : ping.chain;
  return contactRoute(contact);
}

/** Whether a chain of relays as hashes is the one given as contact keys or hashes. */
export function sameRelays(hashes: string[], relays: string[]): boolean {
  return hashes.length === relays.length && hashes.every((h, i) => relays[i]!.startsWith(h) || h.startsWith(relays[i]!));
}

/**
 * The lines through a chain of nodes, this radio first and the contact
 * last, and a handle on every relay and in the middle of every leg. A node
 * with no place on the map is skipped: the line goes round it, and the leg
 * cannot be tapped for its line of sight.
 */
function chainOverlay(nodes: (LosEnd | null)[], relays: string[], toneOf: (leg: number) => LineTone, label: (a: LosEnd, b: LosEnd) => string | undefined, handles: boolean): MapOverlay {
  const worse = (a: LineTone, b: LineTone): LineTone => {
    const order: LineTone[] = ["fail", "weak", "fair", "good", "flight", "dest", "unknown", "plain"];
    return order.indexOf(a) <= order.indexOf(b) ? a : b;
  };
  const lines: OverlayLine[] = [];
  const gaps: MapHandle[] = [];
  let from = nodes[0] ?? null;
  let first = 0;
  for (let i = 1; i < nodes.length; i++) {
    const to = nodes[i];
    if (!to) continue;
    if (from) {
      let tone = toneOf(first);
      for (let j = first + 1; j < i; j++) tone = worse(tone, toneOf(j));
      lines.push({ from, to, tone, tappable: i - first === 1, label: label(from, to) });
      gaps.push({ kind: "gap", index: first, lat: (from.lat + to.lat) / 2, lon: (from.lon + to.lon) / 2, from, to, key: null, relays });
    }
    from = to;
    first = i;
  }
  const drawn = (i: number, step: number): LosEnd | null => {
    for (let j = i + step; j >= 0 && j < nodes.length; j += step) if (nodes[j]) return nodes[j]!;
    return null;
  };
  const hops: MapHandle[] = [];
  for (let i = 1; i < nodes.length - 1; i++) {
    const at = nodes[i];
    if (at) hops.push({ kind: "hop", index: i - 1, lat: at.lat, lon: at.lon, from: drawn(i, -1), to: drawn(i, 1), key: at.key, relays });
  }
  return { lines, pins: [], numbers: {}, handles: handles ? [...gaps, ...hops] : [], pulse: null };
}

/** The tone of each leg of a chain, from what a ping measured along it; the legs up to `from` only lead there. */
function pingTone(ping: Ping | null, legs: number, toPerson: boolean, from = -1): (i: number) => LineTone {
  const measured = measuredLegs(ping);
  return (i) => {
    if (i === legs - 1 && toPerson) return "dest";
    if (i <= from) return "was";
    if (ping?.running) return "flight";
    const leg = measured[i];
    return leg ? quality(legSnr(leg)) : "plain";
  };
}

/** The node a hash names, where it is on the map. */
function endOfHash(hash: string, contacts: Record<string, ContactRecord>): LosEnd | null {
  const r = relayOf(hash, contacts);
  return r ? contactEnd(r) : null;
}

/**
 * What a check left beside the way it shows, faint: the chain it broke on,
 * with the leg it broke at marked, the ways a search tried that stayed
 * silent, and the one on its way now. `nodesOf` places a chain's hashes.
 */
function checkTrail(ping: Ping | null, nodesOf: (chain: string[]) => { nodes: (LosEnd | null)[]; relays: string[] }): OverlayLine[] {
  if (!ping || ping.via) return [];
  const lines: OverlayLine[] = [];
  const faint = (chain: string[], tone: LineTone, breakAt: number | null = null) => {
    const { nodes, relays } = nodesOf(chain);
    const a = breakAt === null ? null : nodes[breakAt];
    const b = breakAt === null ? null : nodes[breakAt + 1];
    const overlay = chainOverlay(nodes, relays, () => tone, (x, y) => (a && b && x === a && y === b ? t("mesh.leg.breaks") : undefined), false);
    lines.push(...overlay.lines.map((l) => ({ ...l, tappable: false })));
  };
  for (const tried of ping.search?.tried ?? []) faint(tried, "was");
  if (ping.broken) faint(ping.broken.chain, "was", ping.broken.at);
  if (ping.search?.trying) faint(ping.search.trying, "flight");
  return lines;
}

/**
 * The legs of the route to a contact, this radio first: each leg's ends, and
 * how it sounded when last pinged. A relay whose hash names nobody for sure,
 * or nobody with a position, cannot be drawn; the line then skips it and the
 * leg around it cannot be tapped. Its relays and legs can be dragged, but
 * not while a ping is on its way along them.
 */
export function routeOverlay(key: string, state: SessionState, ping: Ping | null): MapOverlay {
  const contact = state.contacts[key];
  if (!contact) return EMPTY_OVERLAY;
  const target = contactEnd(contact);
  if (!target) return EMPTY_OVERLAY;
  const me = selfEnd(state);
  const toPerson = contact.type !== AdvType.Repeater;
  const measured = ping?.via ? null : ping;
  const trail = checkTrail(measured, (chain) => {
    const relays = measured?.targetInChain ? chain.slice(0, -1) : chain;
    return { nodes: along(me, relays, target, state.contacts), relays };
  });
  // A search still looking, or one that found nothing: what it left is all there is to show.
  if (measured?.search && !measured.search.found) return { ...EMPTY_OVERLAY, lines: trail };
  const relays = shownRelays(contact, ping);
  if (relays === null) return { ...EMPTY_OVERLAY, lines: trail };
  const nodes = along(me, relays, target, state.contacts);
  const route = chainOverlay(nodes, relays, pingTone(measured, nodes.length - 1, toPerson), () => undefined, !ping?.running);
  // A way found that came home another way: that way, dashed, from where the trace turned.
  const home = measured?.search?.found && measured.search.back ? measured.search.back : null;
  const turn = toPerson ? endOfHash(relays[relays.length - 1] ?? "", state.contacts) : target;
  const back = home && turn ? chainOverlay(along(turn, home, me, state.contacts), home, () => "back", () => undefined, false).lines.map((l) => ({ ...l, tappable: false })) : [];
  return { ...route, lines: [...trail, ...back, ...route.lines] };
}

/**
 * The way between two repeaters, as a check went along it: from this radio
 * to the first, faint, and on to the second coloured by how it sounded.
 * Before a check, a straight line joins them.
 */
export function spanOverlay(from: string, to: string | null, state: SessionState, ping: Ping | null): MapOverlay {
  const a = state.contacts[from];
  const b = to ? state.contacts[to] : null;
  const aEnd = a ? contactEnd(a) : null;
  const bEnd = b ? contactEnd(b) : null;
  if (!aEnd || !bEnd) return EMPTY_OVERLAY;
  const me = selfEnd(state);
  const nodesOf = (chain: string[]) => ({ nodes: [me, ...chain.map((h) => endOfHash(h, state.contacts))], relays: chain });
  const trail = checkTrail(ping, nodesOf);
  if (!ping || ping.chain.length === 0 || (ping.search && !ping.search.found)) {
    return { ...EMPTY_OVERLAY, lines: [...trail, { from: aEnd, to: bEnd, tone: "unknown", tappable: false }] };
  }
  const { nodes } = nodesOf(ping.chain);
  const way = chainOverlay(nodes, ping.chain, pingTone(ping, nodes.length - 1, false, ping.from), () => undefined, false);
  return { ...way, lines: [...trail, ...way.lines.map((l) => (l.tone === "was" ? { ...l, tappable: false } : l))] };
}

/** The nodes along relays given as hashes, from `from` to `to`; a relay not on the map is null. */
function along(from: LosEnd | null, relays: string[], to: LosEnd | null, contacts: Record<string, ContactRecord>): (LosEnd | null)[] {
  return [from, ...relays.map((h) => endOfHash(h, contacts)), to];
}

/**
 * A path discovery on the map. While the flood is out, rings spread from
 * this radio over the route held. Once it is answered: the way it found
 * there, which is the route now and can be dragged; the way the answer came
 * back; and, faint, the route it replaced.
 */
export function discoveryOverlay(key: string, state: SessionState, d: Discovery): MapOverlay {
  const contact = state.contacts[key];
  if (!contact) return EMPTY_OVERLAY;
  const me = selfEnd(state);
  const target = contactEnd(contact);
  if (d.running) {
    const held = routeOverlay(key, state, null);
    return { ...held, handles: [], pulse: me ? { lat: me.lat, lon: me.lon } : null };
  }
  if (!d.found || !target) return routeOverlay(key, state, null);
  const out = chainOverlay(along(me, d.found.out, target, state.contacts), d.found.out, () => "found", () => undefined, true);
  const back = chainOverlay(along(target, d.found.back, me, state.contacts), d.found.back, () => "back", () => undefined, false);
  const was = d.found.changed && d.before ? chainOverlay(along(me, d.before.relays, target, state.contacts), d.before.relays, () => "was", () => undefined, false) : null;
  const plain = (lines: OverlayLine[]) => lines.map((l) => ({ ...l, tappable: false }));
  return { ...out, lines: [...plain(was?.lines ?? []), ...plain(back.lines), ...out.lines] };
}

/**
 * A route being changed: this radio, the relays tapped or dragged so far,
 * the contact it leads to; coloured once it is pinged as it stands. Every
 * leg opens its line of sight, even one that goes round a node off the map.
 */
export function editOverlay(key: string, relays: string[], state: SessionState, blocked: Set<string>, ping: Ping | null): MapOverlay {
  const target = state.contacts[key];
  const ends = [selfEnd(state), ...relays.map((k) => { const r = state.contacts[k] ?? relayOf(k, state.contacts); return r ? contactEnd(r) : null; }), target ? contactEnd(target) : null];
  const toPerson = target?.type !== AdvType.Repeater;
  const pinged = ping?.via && sameRelays(ping.via, relays) ? ping : null;
  const measured = pingTone(pinged, ends.length - 1, toPerson);
  const tone = (i: number): LineTone => (pinged ? measured(i) : i === ends.length - 2 && toPerson ? "dest" : "unknown");
  const overlay = chainOverlay(ends, relays, tone, (a, b) => (blocked.has(legId(a, b)) ? t("mesh.leg.blocked") : undefined), !pinged?.running);
  const numbers: Record<string, number> = {};
  relays.forEach((k, i) => (numbers[k] = i + 1));
  return { ...overlay, lines: overlay.lines.map((l) => ({ ...l, tappable: true })), numbers };
}

export function losOverlay(tool: Extract<MeshTool, { kind: "los" }>): MapOverlay {
  return { lines: [{ from: tool.from, to: tool.to, tone: "look", tappable: false }], pins: tool.to.key === null ? [{ lat: tool.to.lat, lon: tool.to.lon }] : [], numbers: {}, handles: [], pulse: null };
}

/** A line from this radio to each repeater that answered, coloured by how well it heard us. */
export function hearsOverlay(hears: Hears, state: SessionState): MapOverlay {
  const me = selfEnd(state);
  if (!me) return EMPTY_OVERLAY;
  const lines: OverlayLine[] = [];
  for (const reply of hears.replies) {
    const c = state.contacts[reply.key];
    const end = c ? contactEnd(c) : null;
    if (end) lines.push({ from: me, to: end, tone: quality(reply.heardUs), tappable: true });
  }
  return { lines, pins: [], numbers: {}, handles: [], pulse: null };
}

/** From a survey's point opened on the map, a line to each repeater that answered there, coloured by the worse of the two ways. */
export function surveyOverlay(survey: Survey | null, point: number | null, state: SessionState): MapOverlay {
  const p = survey && point !== null ? survey.points[point] : undefined;
  if (!survey || !p) return EMPTY_OVERLAY;
  const from: LosEnd = { lat: p.lat, lon: p.lon, name: t("tools.thisSpot"), key: null };
  const lines: OverlayLine[] = [];
  for (const reply of p.replies) {
    const c = state.contacts[reply.key];
    const node = survey.nodes[reply.key];
    const to = (c ? contactEnd(c) : null) ?? (node && node.lat !== null && node.lon !== null ? { lat: node.lat, lon: node.lon, name: node.name, key: reply.key } : null);
    if (to) lines.push({ from, to, tone: quality(replyScore(reply)), tappable: false });
  }
  return { lines, pins: [], numbers: {}, handles: [], pulse: null, heard: p.replies.map((r) => r.key).sort() };
}

/**
 * A line from a repeater to each neighbour on the map, coloured by how well
 * the repeater hears it, faint for one heard long ago. With a link open, the
 * rest step back and it goes over them, marching while it is checked. Those
 * the filter hides are left out, and a filter by distance draws its ends.
 */
export function neighboursOverlay(tool: NeighboursTool, state: SessionState, checking: boolean, now = Date.now()): MapOverlay {
  const hub = state.contacts[tool.key];
  const from = hub ? contactEnd(hub) : null;
  if (!from) return EMPTY_OVERLAY;
  const lines: OverlayLine[] = [];
  let open: OverlayLine | null = null;
  for (const n of neighbourRows(state, tool.key, now)) {
    const to = n.contact && n.placed ? contactEnd(n.contact) : null;
    if (!to || !passes(n, tool.filter)) continue;
    if (tool.link === n.contact!.key) {
      open = { from, to, tone: checking ? "flight" : quality(n.snr), tappable: true, mark: "on" };
      continue;
    }
    const dim = tool.link !== null;
    lines.push({ from, to, tone: quality(n.snr), tappable: true, mark: n.stale ? (dim ? "stale dim" : "stale") : dim ? "dim" : undefined });
  }
  const f = tool.filter;
  const reach = f ? [...(f.fromKm > 0 ? [f.fromKm] : []), ...(f.toKm !== null ? [f.toKm] : [])] : [];
  const rings = reach.map((km) => ({ lat: from.lat, lon: from.lon, km, label: formatRoundDistance(km) }));
  return { ...EMPTY_OVERLAY, lines: open ? [...lines, open] : lines, ...(rings.length ? { rings } : {}) };
}
