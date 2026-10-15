/**
 * Checks of the way to a contact, kept per contact while the app runs, and
 * of the way between two repeaters. A check sends five traces out along the
 * route and back, one at a time. When the first two stay silent it stops,
 * finds where the way breaks by halving it, and then looks for a way round
 * in the link book (lib/linkGraph.ts), trying four, one trace each; "Keep
 * looking" tries four more from where it stopped. A way that comes back
 * becomes the route, and the one before can be put back. A route being
 * changed on the map is checked the same way, but only to see where it
 * breaks: a way round is not looked for.
 *
 * Only a tap starts any of it; nothing here repeats on its own.
 */

import { useSyncExternalStore } from "react";
import { AdvType, contactRoute, traceLegs, type SessionState, type TraceResult } from "@meshnet/meshcore";
import { errorText } from "../i18n/errors.js";
import { t } from "../i18n/index.js";
import { buildGraph, findWay, isUnresolved, linkId, locateBreak, planWay, resolver, SELF, tracedLegs, wayLinks, type Graph, type PlannedWay, type WayOptions } from "./linkGraph.js";
import { linkBook, noteBreak, noteTrace } from "./links.js";
import { session } from "./session.js";

export const ROUNDS = 5;
/** Ways a search tries, one trace each, before it gives up: about a flood's worth of air. */
export const TRIES = 4;
/** Between one trace coming back and the next going out, so the relays' queues drain. */
const GAP_MS = 300;

/** How one leg sounded: the SNR at its far end going out, at its near end coming back; null when it came home another way. */
export type Leg = [out: number, back: number | null];

export interface PingRun {
  ok: boolean;
  rttMs: number | null;
  /** Leg by leg from this radio; empty when nothing came back. */
  legs: Leg[];
}

/** A look for a way round a break, or for a way at all. */
export interface Search {
  total: number;
  /** Each way tried, in order: whether it came back. */
  tries: boolean[];
  /** The ways that stayed silent, out as hashes. */
  tried: string[][];
  /** The way on its way now, out as hashes. */
  trying: string[] | null;
  /** The way the one found came home, relays as hashes nearest the turn first; null when it came back the way it went. */
  back: string[] | null;
  found: boolean;
  /** The route held before the one found was written, to put back; absent when nothing was written. */
  before?: { relays: string[] | null; since: number | null };
  done: boolean;
}

export interface Ping {
  /** A contact's key, or `spanKey(a, b)` for the way between two repeaters. */
  key: string;
  /** What was traced: the relays, then the node itself when it relays too. */
  chain: string[];
  /** Whether the node is the last hop of the chain, or only reached through it. */
  targetInChain: boolean;
  /** The relays of a route being changed that it went along, as hashes; null for the route the radio holds. */
  via: string[] | null;
  /** Where along `chain` the part asked about starts: the legs after `chain[from]` count. -1 counts them all. */
  from: number;
  runs: PingRun[];
  running: boolean;
  /** What a running check is doing: going round, finding the break, trying other ways. */
  stage: "rounds" | "locate" | "search" | null;
  /** The chain a check broke on, and the leg it broke at: leg i ends at `chain[i]`. */
  broken: { chain: string[]; at: number } | null;
  search: Search | null;
  error: string | null;
  at: number;
}

const pings = new Map<string, Ping>();
const listeners = new Set<() => void>();
const stopped = new Set<string>();

function publish(ping: Ping): void {
  pings.set(ping.key, { ...ping, search: ping.search ? { ...ping.search } : null });
  for (const listener of listeners) listener();
}

export function usePing(key: string | null): Ping | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => (key ? (pings.get(key) ?? null) : null),
  );
}

export function getPing(key: string): Ping | null {
  return pings.get(key) ?? null;
}

/** The key a check of the way between two repeaters is kept under. */
export function spanKey(from: string, to: string): string {
  return `span:${from}:${to}`;
}

function spanEnds(key: string): [string, string] | null {
  const m = /^span:([0-9a-f]+):([0-9a-f]+)$/.exec(key);
  return m ? [m[1]!, m[2]!] : null;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The size a route to `key` is written at, in bytes: that of the route held, else the radio's own. */
function hashSize(state: SessionState, key: string | null): number {
  const held = key && state.contacts[key] ? contactRoute(state.contacts[key]) : null;
  return held?.[0] ? held[0].length / 2 : (state.device?.pathHashMode ?? 0) + 1;
}

/** A node of the graph as a trace names it: a key cut to the size, or a hash long enough. */
function hashOf(node: string, size: number): string | null {
  if (node === SELF) return null;
  const hex = isUnresolved(node) ? node.slice(1) : node;
  return hex.length >= size * 2 ? hex.slice(0, size * 2) : null;
}

function hashesOf(nodes: string[], size: number): string[] | null {
  const out = nodes.map((n) => hashOf(n, size));
  return out.every((h): h is string => h !== null) ? out : null;
}

/** The way a trace to this contact goes along relays given by hand: through them, and on to it when it relays too. */
function pathVia(key: string, via: string[]): { relays: string[]; target: string | null } | null {
  const state = session.getState();
  const contact = state.contacts[key];
  if (!contact) return null;
  const size = via[0] ? via[0].length / 2 : (state.device?.pathHashMode ?? 0) + 1;
  return { relays: via, target: contact.type === AdvType.Repeater ? key.slice(0, size * 2) : null };
}

/**
 * The way to check between two repeaters: to the first along the route held
 * to it, or the likeliest way the book knows, then on to the second the
 * likeliest way. Null when the book knows no way.
 */
function spanPath(from: string, to: string, g: Graph, avoid: Set<string> = new Set(), doubt?: Map<string, number>): { chain: string[]; from: number } | null {
  const state = session.getState();
  const size = hashSize(state, null);
  // The route held to the first leads there unless what the radio has heard since says otherwise.
  const held = state.contacts[from] ? contactRoute(state.contacts[from]) : null;
  const resolve = resolver(state.contacts);
  const prefer = new Set<string>();
  const heldNodes = held ? [SELF, ...held.map(resolve), from] : [];
  for (let i = 0; i < heldNodes.length - 1; i++) prefer.add(linkId(heldNodes[i]!, heldNodes[i + 1]!));
  const opts: WayOptions = { avoid, ...(doubt ? { doubt } : {}) };
  const way = findWay(g, SELF, from, { ...opts, prefer });
  const approach = way ? hashesOf(way.slice(1, -1), size) : held && avoid.size === 0 ? held.map((h) => h.slice(0, size * 2)) : null;
  const seg = findWay(g, from, to, opts);
  const segHashes = seg ? hashesOf(seg.slice(1), size) : null;
  if (!approach || !segHashes) return null;
  return { chain: [...approach, from.slice(0, size * 2), ...segHashes], from: approach.length };
}

function blank(key: string, via: string[] | null): Ping {
  return { key, chain: [], targetInChain: false, via, from: -1, runs: [], running: true, stage: null, broken: null, search: null, error: null, at: Date.now() };
}

/** The legs of a trace that came back through `chain`, and home through `back` or the same way. */
function legsOf(chain: string[], back: string[] | null, snrs: number[]): Leg[] {
  if (!back) return traceLegs(snrs, chain.length);
  return chain.slice(0, snrs.length).map((_, j) => [snrs[j]!, null]);
}

/**
 * One trace, out through `chain` and home through `back` or the same way.
 * What comes back goes in the link book, and its legs in `heard`: legs this
 * check has heard work, so a way that then stays silent broke elsewhere.
 * One that comes back after it was given up on counts the same, and
 * `onLate` hears it.
 */
async function trace(chain: string[], back: string[] | null, heard: Set<string>, onLate?: (res: TraceResult) => void): Promise<TraceResult | null> {
  const hops = [...chain, ...(back ?? chain.slice(0, -1).reverse())];
  const took = (res: TraceResult) => {
    noteTrace(hops, res.snrs);
    const resolve = resolver(session.getState().contacts);
    for (const leg of tracedLegs(hops, res.snrs)) heard.add(linkId(resolve(leg.from), resolve(leg.to)));
  };
  const res = await session.traceRoute(chain, back ?? undefined, (late) => {
    took(late);
    onLate?.(late);
  });
  if (res) took(res);
  return res;
}

/** What a search has learned, kept so that "Keep looking" goes on from where it stopped. */
interface Look {
  heard: Set<string>;
  avoid: Set<string>;
  doubt: Map<string, number>;
  /** How many times each way was tried, by its hashes out and home. */
  tried: Map<string, number>;
  /** Each way may be tried once a round. */
  round: number;
}

const looks = new Map<string, Look>();

/**
 * Checks the way to `key`: along `via` when given (a route being changed),
 * else the route the radio holds. When it does not come back, finds where it
 * breaks and, for the route held, looks for a way round.
 */
export async function ping(key: string, via: string[] | null = null): Promise<void> {
  stopped.delete(key);
  const p = blank(key, via);
  const heard = new Set<string>();
  publish(p);
  try {
    const span = spanEnds(key);
    let path: { relays: string[]; target: string | null } | null;
    if (span) {
      const found = spanPath(span[0], span[1], buildGraph(linkBook(), session.getState(), Date.now()));
      if (!found) {
        p.running = false;
        p.error = t("tools.ping.notLinked");
        return publish(p);
      }
      path = { relays: found.chain, target: null };
      p.from = found.from;
    } else {
      path = via ? pathVia(key, via) : await session.pingPath(key);
    }
    if (!path) {
      if (via) {
        p.running = false;
        p.error = t("tools.contactGone");
        return publish(p);
      }
      // No route known: look for one.
      await search(p, null, heard);
      return finish(p);
    }
    p.chain = path.target ? [...path.relays, path.target] : path.relays;
    p.targetInChain = path.target !== null || span !== null;
    if (p.chain.length === 0) {
      p.running = false;
      p.error = t("tools.ping.direct");
      return publish(p);
    }
    p.stage = "rounds";
    publish(p);
    for (let i = 0; i < ROUNDS && !stopped.has(key); i++) {
      if (i > 0) await wait(GAP_MS);
      // A round that comes back late, while the rounds are still going, came back.
      const late = (res: TraceResult) => {
        if (p.stage !== "rounds" || p.runs[i]?.ok !== false) return;
        p.runs = p.runs.map((r, j) => (j === i ? { ok: true, rttMs: res.rttMs, legs: traceLegs(res.snrs, p.chain.length) } : r));
        publish(p);
      };
      const back = await trace(p.chain, null, heard, late);
      if (stopped.has(key)) return;
      p.runs = [...p.runs, back ? { ok: true, rttMs: back.rttMs, legs: traceLegs(back.snrs, p.chain.length) } : { ok: false, rttMs: null, legs: [] }];
      publish(p);
      // Two silent in a row from the start: the way is broken, not unlucky.
      if (i === 1 && !p.runs[0]!.ok && !p.runs[1]!.ok) break;
    }
    if (p.runs.some((r) => r.ok) || stopped.has(key)) return finish(p);
    await locate(p, heard);
    if (stopped.has(key) || via) return finish(p);
    await search(p, p.broken, heard);
  } catch (error) {
    p.error = errorText(error);
  }
  finish(p);
}

function finish(p: Ping): void {
  if (stopped.has(p.key)) return;
  p.running = false;
  p.stage = null;
  if (p.search) p.search = { ...p.search, trying: null, done: true };
  publish(p);
}

/**
 * Finds the first leg of the chain that stays silent, by halving the chain.
 * A part that stays silent is tried once more before it counts: a weak leg
 * loses a trace now and then, and blaming it would send the search round a
 * leg that works.
 */
async function locate(p: Ping, heard: Set<string>): Promise<void> {
  p.stage = "locate";
  publish(p);
  const chain = p.chain;
  const at = await locateBreak(chain.length, async (m) => {
    for (let tries = 0; tries < 2; tries++) {
      if (stopped.has(p.key)) return false;
      await wait(GAP_MS);
      if (await trace(chain.slice(0, m), null, heard)) return true;
    }
    return false;
  });
  if (stopped.has(p.key)) return;
  p.broken = { chain, at };
  noteBreak(at === 0 ? SELF : chain[at - 1]!, chain[at]!);
  publish(p);
}

/**
 * Looks in the link book for a way to the contact, round the leg a check
 * broke at, and tries the likeliest, one trace each, until one comes back.
 * A way that stays silent broke on a leg this check has not heard work:
 * those count for less in the next look, so the next way goes round them
 * where it can, and through them only where there is no other.
 */
async function search(p: Ping, broken: Ping["broken"], heard: Set<string>): Promise<void> {
  const resolve = resolver(session.getState().contacts);
  const look: Look = { heard, avoid: new Set(), doubt: new Map(), tried: new Map(), round: 1 };
  if (broken) {
    const a = broken.at === 0 ? SELF : resolve(broken.chain[broken.at - 1]!);
    const b = resolve(broken.chain[broken.at]!);
    look.avoid.add(linkId(a, b));
    look.avoid.add(linkId(b, a));
  }
  looks.set(p.key, look);
  p.search = { total: TRIES, tries: [], tried: [], trying: null, back: null, found: false, done: false };
  await goOn(p, look);
}

/**
 * Four more ways, after a search found none: on from where it stopped, with
 * the break and the legs heard working as they were. What the last round
 * doubted counts for more again, and each way may be tried once more, since
 * a weak leg loses a trace now and then.
 */
export async function keepLooking(key: string): Promise<void> {
  const prior = pings.get(key);
  const look = looks.get(key);
  if (!prior?.search || prior.running || prior.search.found || !look) return;
  stopped.delete(key);
  for (const [id, d] of look.doubt) look.doubt.set(id, Math.min(1, d * 2.5));
  look.round++;
  const p: Ping = { ...prior, running: true, error: null, search: { ...prior.search, total: prior.search.tries.length + TRIES, done: false } };
  publish(p);
  try {
    await goOn(p, look);
  } catch (error) {
    p.error = errorText(error);
  }
  finish(p);
}

/** Tries ways, one trace each, until one comes back or the search has tried as many as it may. */
async function goOn(p: Ping, look: Look): Promise<void> {
  const state = session.getState();
  const span = spanEnds(p.key);
  const contact = span ? null : state.contacts[p.key];
  if (!span && !contact) return;
  const relaysItself = span !== null || contact!.type === AdvType.Repeater;
  const size = hashSize(state, span ? null : p.key);
  const resolve = resolver(state.contacts);
  const { heard, avoid, doubt } = look;
  if (!p.search) return;
  p.stage = "search";
  publish(p);
  for (let guard = 0; p.search.tries.length < p.search.total && guard < TRIES * 3; guard++) {
    if (stopped.has(p.key)) return;
    const g = buildGraph(linkBook(), session.getState(), Date.now());
    let plan: (PlannedWay & { from: number }) | null = null;
    let out: string[] | null = null;
    if (span) {
      const found = spanPath(span[0], span[1], g, avoid, doubt);
      if (found) {
        out = found.chain;
        plan = { out: [], back: null, from: found.from };
      }
    } else {
      const way = planWay(g, p.key, relaysItself, avoid, doubt);
      if (way) {
        plan = { ...way, from: -1 };
        out = hashesOf(way.out, size);
      }
    }
    if (!plan) break;
    const back = plan.back ? hashesOf(plan.back, size) : null;
    const nodes = span ? [SELF, ...(out ?? []).map(resolve)] : [SELF, ...plan.out];
    const loop = [...nodes, ...(plan.back ?? nodes.slice(1, -1).reverse()), SELF];
    // The legs of this way not yet heard to work count for less from now on.
    const doubtIt = () => {
      const links = wayLinks(loop);
      const suspects = links.filter((id) => !heard.has(id));
      for (const id of suspects.length ? suspects : links) doubt.set(id, (doubt.get(id) ?? 1) * 0.3);
    };
    // A hash too short to name at the size traced, or a way tried this round already: doubt it, and look again.
    const wayKey = `${out?.join(" ")}|${back?.join(" ") ?? ""}`;
    if (!out || (plan.back && !back) || (look.tried.get(wayKey) ?? 0) >= look.round) {
      doubtIt();
      continue;
    }
    if (out.length + (back ?? out.slice(0, -1)).length > 63) break;
    look.tried.set(wayKey, (look.tried.get(wayKey) ?? 0) + 1);
    p.search.trying = out;
    publish(p);
    if (p.search.tries.length > 0) await wait(GAP_MS);
    const res = await trace(out, back, heard);
    if (stopped.has(p.key)) return;
    p.search.tries = [...p.search.tries, !!res];
    p.search.trying = null;
    if (res) {
      p.chain = out;
      p.targetInChain = relaysItself;
      p.from = plan.from;
      p.runs = [{ ok: true, rttMs: res.rttMs, legs: legsOf(out, back, res.snrs) }];
      p.search.found = true;
      p.search.back = back;
      if (contact) await keep(p, contact.key, relaysItself ? out.slice(0, -1) : out);
      publish(p);
      return;
    }
    if (!p.search.tried.some((t) => t.join(" ") === out!.join(" "))) p.search.tried = [...p.search.tried, out];
    publish(p);
    doubtIt();
  }
}

/** Writes a way found as the route, as learned: it ages like any other. Not for a contact pinned to flood. */
async function keep(p: Ping, key: string, relays: string[]): Promise<void> {
  const contact = session.getState().contacts[key];
  if (!contact || !p.search) return;
  if (session.routePolicy(key).flood) return;
  const before = { relays: contactRoute(contact), since: contact.pathSince };
  await session.setRoute(key, relays, { learnedAt: Date.now() });
  p.search.before = before;
}

/** Puts back the route held before a search wrote the one it found. */
export async function undoFound(key: string): Promise<void> {
  const before = pings.get(key)?.search?.before;
  if (!before) return;
  if (before.relays) await session.setRoute(key, before.relays, { learnedAt: before.since });
  else await session.resetPath(key);
  clearPing(key);
}

export function stopPing(key: string): void {
  stopped.add(key);
  const p = pings.get(key);
  if (p?.running) publish({ ...p, running: false, stage: null, search: p.search ? { ...p.search, trying: null, done: true } : null });
}

/** Forgets what was measured, when the route it was measured along has changed. */
export function clearPing(key: string): void {
  stopPing(key);
  pings.delete(key);
  looks.delete(key);
  for (const listener of listeners) listener();
}

/** A route being changed was saved as `relays`: what was measured along it is now the route's, and anything else is forgotten. */
export function settlePing(key: string, relays: string[]): void {
  const p = pings.get(key);
  if (p?.via && !p.running && p.via.length === relays.length && p.via.every((h, i) => h === relays[i])) publish({ ...p, via: null });
  else clearPing(key);
}

/** The legs measured last, from the last trace that came back. */
export function measuredLegs(p: Ping | null): (Leg | null)[] {
  if (!p) return [];
  const last = [...p.runs].reverse().find((r) => r.ok);
  return last ? last.legs : [];
}

/** A leg's worse direction, or its only one. */
export function legSnr(leg: Leg): number {
  return leg[1] === null ? leg[0] : Math.min(leg[0], leg[1]);
}

/** The weakest leg measured, by its worse direction; for the way between two repeaters, only between them. */
export function weakestLeg(p: Ping | null): { index: number; snr: number } | null {
  let worst: { index: number; snr: number } | null = null;
  measuredLegs(p).forEach((leg, index) => {
    if (!leg || (p && index <= p.from)) return;
    const snr = legSnr(leg);
    if (!worst || snr < worst.snr) worst = { index, snr };
  });
  return worst;
}
