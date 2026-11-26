/**
 * The community coverage cells served by nw.ommesh.ru (`/api/coverage`):
 * honeycomb hexagons of several sizes, each telling how many pings went from
 * there, how many a repeater answered, their median and best SNR, which
 * repeaters answered and which signed radios measured there. Everything here
 * is pure data handling, apart from the network and the map, so it is tested
 * straight.
 */

import type { ContactRecord } from "@meshnet/meshcore";
import { metresPerPixel } from "../geo.js";
import { quality } from "../los.js";
import type { PointTone } from "../surveyData.js";
import { MIN_CELL_PX } from "./tiles.js";

/** One repeater heard in a cell: key (full 64 hex when known, else prefix), name, pings, best SNR. */
export type CommunityNodeEntry = [key: string, name: string, n: number, best: number | null];

/** One radio that pinged in a cell: key and name when signed, or "" for unnamed pings, and ping count. */
export type CommunitySenderEntry = [key: string, name: string, n: number];

export interface CommunityCell {
  lat: number;
  lon: number;
  /** Pings from this cell, and those answered by at least one repeater. */
  n: number;
  ok: number;
  /** Median and best SNR of the answers, dB. */
  snr: number | null;
  best: number | null;
  tone: PointTone;
  firstAt: number;
  lastAt: number;
  nodes: CommunityNodeEntry[];
  senders: CommunitySenderEntry[];
}

export interface CommunityLevel {
  cellM: number;
  cells: CommunityCell[];
}

export interface CommunityCoverage {
  days: number;
  from: number;
  to: number;
  samples: number;
  levels: CommunityLevel[];
}

const TONES = new Set<PointTone>(["good", "fair", "weak", "none"]);

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function readNodes(raw: unknown): CommunityNodeEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: CommunityNodeEntry[] = [];
  for (const item of raw) {
    if (!Array.isArray(item) || item.length < 3) continue;
    const [key, name, n, best] = item;
    if (typeof key !== "string" || typeof name !== "string" || !finite(n)) continue;
    out.push([key, name, n, finite(best) ? best : null]);
  }
  return out;
}

function readSenders(raw: unknown): CommunitySenderEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: CommunitySenderEntry[] = [];
  for (const item of raw) {
    if (!Array.isArray(item) || item.length < 3) continue;
    const [key, name, n] = item;
    if (typeof key !== "string" || typeof name !== "string" || !finite(n)) continue;
    out.push([key, name, n]);
  }
  return out;
}

function readCell(raw: unknown): CommunityCell | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Record<string, unknown>;
  if (!finite(c["lat"]) || !finite(c["lon"]) || Math.abs(c["lat"]) > 90 || Math.abs(c["lon"]) > 180) return null;
  if (!finite(c["n"]) || !finite(c["ok"]) || !finite(c["firstAt"]) || !finite(c["lastAt"])) return null;
  if (typeof c["tone"] !== "string" || !TONES.has(c["tone"] as PointTone)) return null;
  return {
    lat: c["lat"],
    lon: c["lon"],
    n: c["n"],
    ok: c["ok"],
    snr: finite(c["snr"]) ? c["snr"] : null,
    best: finite(c["best"]) ? c["best"] : null,
    tone: c["tone"] as PointTone,
    firstAt: c["firstAt"],
    lastAt: c["lastAt"],
    nodes: readNodes(c["nodes"]),
    senders: readSenders(c["senders"]),
  };
}

/** Reads the JSON answer of `/api/coverage`, from a string or an object; null when it is not that. */
export function parseCoverage(raw: unknown): CommunityCoverage | null {
  let body: unknown = raw;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      return null;
    }
  }
  if (!body || typeof body !== "object") return null;
  const d = body as Record<string, unknown>;
  if (!Array.isArray(d["levels"])) return null;
  const levels: CommunityLevel[] = [];
  for (const rawLevel of d["levels"]) {
    if (!rawLevel || typeof rawLevel !== "object") continue;
    const l = rawLevel as Record<string, unknown>;
    if (!finite(l["cellM"]) || l["cellM"] <= 0 || !Array.isArray(l["cells"])) continue;
    const cells: CommunityCell[] = [];
    for (const rawCell of l["cells"]) {
      const cell = readCell(rawCell);
      if (cell) cells.push(cell);
    }
    levels.push({ cellM: l["cellM"], cells });
  }
  levels.sort((a, b) => a.cellM - b.cellM);
  return {
    days: finite(d["days"]) ? d["days"] : 90,
    from: finite(d["from"]) ? d["from"] : 0,
    to: finite(d["to"]) ? d["to"] : 0,
    samples: finite(d["samples"]) ? d["samples"] : 0,
    levels,
  };
}

/** A cell's stable id, carrying its size so a tapped cell stays found even after zooming to another level. */
export function coverageCellId(cellM: number, lat: number, lon: number): string {
  return `${cellM}:${lat},${lon}`;
}

/** The finest level whose cell is not smaller than `MIN_CELL_PX` on screen at this zoom and latitude. */
export function pickCoverageLevel(coverage: CommunityCoverage, zoom: number, lat: number): CommunityLevel | null {
  if (coverage.levels.length === 0) return null;
  const pxPerMetre = 1 / metresPerPixel(lat, zoom);
  for (const level of coverage.levels) {
    if (level.cellM * pxPerMetre >= MIN_CELL_PX) return level;
  }
  return coverage.levels[coverage.levels.length - 1]!;
}

/** Finds a cell by its `coverageCellId`, whatever zoom level the map draws now. */
export function findCoverageCell(coverage: CommunityCoverage | null, id: string): { level: CommunityLevel; cell: CommunityCell } | null {
  if (!coverage || !id) return null;
  const colon = id.indexOf(":");
  if (colon <= 0) return null;
  const cellM = Number(id.slice(0, colon));
  const level = coverage.levels.find((l) => l.cellM === cellM);
  if (!level) return null;
  const cell = level.cells.find((c) => coverageCellId(level.cellM, c.lat, c.lon) === id);
  return cell ? { level, cell } : null;
}

/** The entry in a cell for a contact key, matching either the full 64-hex key or a prefix of at least 6 hex digits. */
export function cellNodeMatch(cell: CommunityCell, key: string): CommunityNodeEntry | null {
  const target = key.toLowerCase();
  if (!target) return null;
  for (const entry of cell.nodes) {
    const k = entry[0].toLowerCase();
    if (!k) continue;
    if (k === target || (k.length >= 6 && target.startsWith(k))) return entry;
  }
  return null;
}

/** Whether any cell at this level recorded an answer from the repeater `key`. */
export function levelHasNode(level: CommunityLevel, key: string): boolean {
  return level.cells.some((c) => cellNodeMatch(c, key) !== null);
}

/**
 * A cell's colour: the cell's own tone when nobody is singled out, or else the
 * selected repeater's own best SNR there, and null where it never answered.
 */
export function cellToneFor(cell: CommunityCell, only: string | null): PointTone | null {
  if (!only) return cell.tone;
  const hit = cellNodeMatch(cell, only);
  if (!hit) return null;
  return hit[3] !== null ? quality(hit[3]) : "fair";
}

/** The local contact a coverage cell's repeater entry names, by whole key or unique prefix. */
export function contactForCoverageNode(contacts: Readonly<Record<string, ContactRecord>>, nodeKey: string): ContactRecord | null {
  const k = nodeKey.toLowerCase();
  if (!k) return null;
  const direct = contacts[k];
  if (direct) return direct;
  if (k.length < 6 || k.length >= 64) return null;
  let found: ContactRecord | null = null;
  for (const c of Object.values(contacts)) {
    if (!c.key.toLowerCase().startsWith(k)) continue;
    if (found) return null;
    found = c;
  }
  return found;
}

export interface GeoBounds {
  south: number;
  north: number;
  west: number;
  east: number;
}

/** Whether at least one cell at this level lies within the visible map bounds. */
export function hasCellsInBounds(level: CommunityLevel, bounds: GeoBounds): boolean {
  const wholeLon = bounds.east - bounds.west >= 360;
  const wrapLon = (lon: number) => ((((lon + 180) % 360) + 360) % 360) - 180;
  const west = wrapLon(bounds.west);
  const east = wrapLon(bounds.east);
  for (const c of level.cells) {
    if (c.lat < bounds.south || c.lat > bounds.north) continue;
    if (wholeLon) return true;
    if (west <= east ? c.lon >= west && c.lon <= east : c.lon >= west || c.lon <= east) return true;
  }
  return false;
}
