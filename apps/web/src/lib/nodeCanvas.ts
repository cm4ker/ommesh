/**
 * The nodes of the map drawn on one canvas rather than a DOM marker each.
 *
 * A marker is an element with its own transform, so a few hundred of them are
 * a few hundred compositor layers that every frame of a pan, a pinch or a turn
 * moves. The canvas is one element the size of the map, over its tiles, and
 * is painted on every frame the map draws: each node is placed where the map
 * puts its spot now, so a turned map keeps names and pins upright.
 *
 * It takes no pointer events: the map hands taps and hovers to `hit()`.
 * Nodes too close to tell apart are gathered by lib/cluster.ts when grouping
 * is on, again whenever the zoom has moved on; with it off every node is
 * drawn, and names that would run over a pin or another name are left out
 * until a zoom makes room.
 */

import type { Map as MapLibre } from "maplibre-gl";
import { AdvType, type ContactRecord } from "@meshnet/meshcore";
import { t } from "../i18n/index.js";
import { clusterPoints } from "./cluster.js";
import { ago, hue, trailingEmoji } from "./format.js";
import { freshness } from "./geo.js";

/** How close, in screen pixels, two markers may come before they are gathered: a marker and its name. */
const CLUSTER_RADIUS = 44;
/** A pin's half size. */
const PIN = 11;
/** The most device pixels the canvas takes: about 24 MB of memory. */
const MAX_PIXELS = 6_000_000;

export interface LatLon {
  lat: number;
  lon: number;
}

export interface NodeGroup {
  members: ContactRecord[];
  at: LatLon;
}

export interface NodeData {
  nodes: ContactRecord[];
  selected: string | null;
  /** Places in a route being changed, by key. */
  numbers: Record<string, number>;
  grouping: boolean;
  self: LatLon | null;
}

interface Drawn {
  group: NodeGroup;
  /** Pixels on the map. */
  x: number;
  y: number;
  r: number;
}

type Box = { x0: number; y0: number; x1: number; y1: number };

interface Palette {
  bg: string;
  text: string;
  muted: string;
  faint: string;
  accent: string;
  accentInk: string;
  groupFill: string;
  groupGlow: string;
  font: string;
}

function css(style: CSSStyleDeclaration, name: string, fallback: string): string {
  return style.getPropertyValue(name).trim() || fallback;
}

function rgb(hex: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1]!, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** `a` over `b` at `share`, as color-mix does for the DOM markers; `a` alone when either is not a hex colour. */
function mix(a: string, b: string, share: number, alpha = 1): string {
  const x = rgb(a);
  const y = rgb(b) ?? x;
  if (!x || !y) return a;
  const c = x.map((v, i) => Math.round(v * share + y[i]! * (1 - share)));
  return `rgba(${c[0]},${c[1]},${c[2]},${alpha})`;
}

function palette(): Palette {
  const style = getComputedStyle(document.documentElement);
  const bg = css(style, "--bg", "#fafafa");
  const accent = css(style, "--accent", "#5c78e2");
  return {
    bg,
    text: css(style, "--text", "#242529"),
    muted: css(style, "--text-muted", "#5c5e63"),
    faint: css(style, "--text-faint", "#8a8c91"),
    accent,
    accentInk: css(style, "--accent-contrast", "#fafafa"),
    groupFill: mix(accent, bg, 0.88),
    groupGlow: mix(accent, accent, 1, 0.28),
    font: css(style, "--font-ui", "system-ui, sans-serif"),
  };
}

/** oklch to sRGB, as the avatars' `oklch(62% 0.11 hue)`: a canvas in an older WebView may not take oklch itself. */
function oklch(l: number, c: number, h: number): string {
  const a = c * Math.cos((h * Math.PI) / 180);
  const b = c * Math.sin((h * Math.PI) / 180);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const lin = [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ];
  const out = lin.map((v) => {
    const x = Math.min(1, Math.max(0, v));
    return Math.round(255 * (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055));
  });
  return `rgb(${out[0]},${out[1]},${out[2]})`;
}

const swatches = new Map<number, { fill: string; ink: string }>();
function swatch(name: string): { fill: string; ink: string } {
  const h = hue(name);
  let s = swatches.get(h);
  if (!s) {
    s = { fill: oklch(0.62, 0.11, h), ink: oklch(0.2, 0.03, h) };
    swatches.set(h, s);
  }
  return s;
}

const glyphs = new Map<string, { text: string; emoji: boolean }>();
/** What a node's pin carries: the emoji its name ends with, else its first letter; a repeater or sensor, nothing. */
function glyph(c: ContactRecord): { text: string; emoji: boolean } {
  if (c.type === AdvType.Repeater || c.type === AdvType.Sensor) return { text: "", emoji: false };
  if (c.type === AdvType.Room) return { text: "#", emoji: false };
  const name = c.name || c.prefix;
  let g = glyphs.get(name);
  if (!g) {
    const emoji = trailingEmoji(name);
    g = emoji ? { text: emoji, emoji: true } : { text: name.slice(0, 1).toUpperCase(), emoji: false };
    glyphs.set(name, g);
  }
  return g;
}

/** By arcs: `ctx.roundRect` is missing from the WebView of an iPhone before iOS 16. */
function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** The outline of a node's pin, grown by `grow`: a person a circle, a repeater a mast's diamond, a room a square, a sensor a hexagon. */
function shape(ctx: CanvasRenderingContext2D, type: number, x: number, y: number, grow: number): void {
  if (type === AdvType.Repeater) {
    const r = 9 * Math.SQRT2 + grow;
    ctx.beginPath();
    ctx.moveTo(x, y - r);
    ctx.lineTo(x + r, y);
    ctx.lineTo(x, y + r);
    ctx.lineTo(x - r, y);
    ctx.closePath();
  } else if (type === AdvType.Room) {
    roundRect(ctx, x - PIN - grow, y - PIN - grow, 2 * (PIN + grow), 2 * (PIN + grow), 6 + grow);
  } else if (type === AdvType.Sensor) {
    const r = PIN + grow;
    const w = r * 0.86;
    ctx.beginPath();
    ctx.moveTo(x, y - r);
    ctx.lineTo(x + w, y - r / 2);
    ctx.lineTo(x + w, y + r / 2);
    ctx.lineTo(x, y + r);
    ctx.lineTo(x - w, y + r / 2);
    ctx.lineTo(x - w, y - r / 2);
    ctx.closePath();
  } else {
    ctx.beginPath();
    ctx.arc(x, y, PIN + grow, 0, 2 * Math.PI);
  }
}

/** A grid of boxes, so asking what a name would run over costs the boxes near it, not all of them. */
class Boxes {
  private cells = new Map<number, Box[]>();
  private static readonly CELL = 64;
  private *keys(b: Box): Generator<number> {
    const c = Boxes.CELL;
    for (let cx = Math.floor(b.x0 / c); cx <= Math.floor(b.x1 / c); cx++) {
      for (let cy = Math.floor(b.y0 / c); cy <= Math.floor(b.y1 / c); cy++) yield cx * 131072 + cy;
    }
  }
  add(b: Box): void {
    for (const k of this.keys(b)) {
      const list = this.cells.get(k);
      if (list) list.push(b);
      else this.cells.set(k, [b]);
    }
  }
  hits(b: Box): boolean {
    for (const k of this.keys(b)) {
      for (const t of this.cells.get(k) ?? []) if (b.x0 < t.x1 && b.x1 > t.x0 && b.y0 < t.y1 && b.y1 > t.y0) return true;
    }
    return false;
  }
}

function groupSize(n: number): number {
  return n < 10 ? 32 : n < 100 ? 38 : 44;
}

export class NodeCanvas {
  private data: NodeData = { nodes: [], selected: null, numbers: {}, grouping: true, self: null };
  private placed: NodeGroup[] = [];
  private placedZoom: number | null = null;
  private drawn: Drawn[] = [];
  private widths = new Map<string, number>();
  private widthFont = "";
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D | null;

  constructor(
    private readonly map: MapLibre,
    parent: HTMLElement,
  ) {
    this.canvas = document.createElement("canvas");
    this.canvas.className = "map-nodes";
    this.canvas.setAttribute("aria-hidden", "true");
    parent.append(this.canvas);
    this.ctx = this.canvas.getContext("2d");
    map.on("render", this.paint);
  }

  remove(): void {
    this.map.off("render", this.paint);
    this.canvas.remove();
  }

  /** New nodes, a new pick, grouping turned on or off: grouped again and painted. */
  setData(data: NodeData): void {
    const regroup = data.nodes !== this.data.nodes || data.grouping !== this.data.grouping;
    this.data = data;
    if (regroup) this.placedZoom = null;
    this.map.triggerRepaint();
  }

  /** Painted again as it is: the times beside the names, a new theme, a font that arrived. */
  redraw(): this {
    this.widths.clear();
    this.map.triggerRepaint();
    return this;
  }

  /** The groups on the map now, a single node being a group of one, where they are drawn. */
  groups(): NodeGroup[] {
    return this.drawn.map((d) => d.group);
  }

  /**
   * What is under a point of the map: the nodes of the topmost circle, or of
   * the pins within `slop` of it. Pins stacked on one spot come back together;
   * otherwise the nearest one alone.
   */
  hit(point: { x: number; y: number }, slop: number): ContactRecord[] | null {
    let best: Drawn | null = null;
    let bestD = Infinity;
    const singles: { d: Drawn; dist: number }[] = [];
    for (const d of this.drawn) {
      const dist = Math.hypot(d.x - point.x, d.y - point.y);
      if (dist > d.r + slop) continue;
      if (d.group.members.length === 1) singles.push({ d, dist });
      if (dist < bestD) {
        best = d;
        bestD = dist;
      }
    }
    if (!best) return null;
    if (best.group.members.length > 1) return best.group.members;
    const stacked = singles.filter((s) => Math.hypot(s.d.x - best.x, s.d.y - best.y) < 4);
    return stacked.length > 1 ? stacked.map((s) => s.d.group.members[0]!) : best.group.members;
  }

  // ---- painting ----

  /**
   * Gathered anew for the view as it is. A turn changes no distance on the
   * screen, so only a zoom asks for it: at the end of one, or while a pinch
   * carries the zoom a whole step away.
   */
  private regroup(): void {
    const map = this.map;
    const { nodes, grouping } = this.data;
    if (!grouping) {
      this.placed = nodes.map((c) => ({ members: [c], at: { lat: c.lat, lon: c.lon } }));
    } else {
      const points = nodes.map((c) => {
        const p = map.project([c.lon, c.lat]);
        return { item: c, x: p.x, y: p.y };
      });
      this.placed = clusterPoints(points, CLUSTER_RADIUS).map((g) => {
        if (g.members.length === 1) return { members: g.members, at: { lat: g.members[0]!.lat, lon: g.members[0]!.lon } };
        const at = map.unproject([g.x, g.y]);
        return { members: g.members, at: { lat: at.lat, lon: at.lng } };
      });
    }
    this.placedZoom = map.getZoom();
  }

  private width(ctx: CanvasRenderingContext2D, text: string): number {
    if (ctx.font !== this.widthFont) {
      this.widths.clear();
      this.widthFont = ctx.font;
    }
    let w = this.widths.get(text);
    if (w === undefined) {
      w = ctx.measureText(text).width;
      this.widths.set(text, w);
    }
    return w;
  }

  private paint = (): void => {
    const map = this.map;
    const ctx = this.ctx;
    const canvas = this.canvas;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (!ctx || width === 0 || height === 0) return;
    const zoom = map.getZoom();
    if (this.placedZoom === null || Math.abs(zoom - this.placedZoom) >= 1 || (Math.abs(zoom - this.placedZoom) > 0.01 && !map.isZooming())) this.regroup();

    // Sharp on the screen's pixels, but never past MAX_PIXELS: a phone's WebView refuses, or runs out
    // of memory for, a canvas much larger than that.
    const ratio = Math.min(window.devicePixelRatio || 1, 3, Math.sqrt(MAX_PIXELS / Math.max(1, width * height)));
    if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);

    const { selected, numbers, self: me } = this.data;
    const pal = palette();
    const nowSec = Date.now() / 1000;
    const nameFont = `500 11px ${pal.font}`;
    // Read once a paint, in the language of the moment: a change of language paints anew, and no label outlives it.
    const justNow = t("common.justNow");
    const now = t("mesh.map.now");

    // Only what falls on the canvas, with room for a name reaching in from the left.
    const drawn: Drawn[] = [];
    for (const group of this.placed) {
      const { x, y } = map.project([group.at.lon, group.at.lat]);
      if (x < -240 || x > width + 30 || y < -30 || y > height + 30) continue;
      const n = group.members.length;
      drawn.push({ group, x, y, r: n === 1 ? PIN : groupSize(n) / 2 });
    }
    // South over north, as markers stack; the pick on top of everything.
    const holdsPick = (d: Drawn) => selected !== null && d.group.members.some((c) => c.key === selected);
    drawn.sort((a, b) => Number(holdsPick(a)) - Number(holdsPick(b)) || a.y - b.y);
    this.drawn = drawn;

    // Which names fit: the pick's first, then a route's numbered relays, then the most recently heard.
    ctx.font = nameFont;
    const taken = new Boxes();
    for (const d of drawn) taken.add({ x0: d.x - d.r, y0: d.y - d.r, x1: d.x + d.r, y1: d.y + d.r });
    if (me) {
      const { x, y } = map.project([me.lon, me.lat]);
      taken.add({ x0: x - PIN, y0: y - PIN, x1: x + PIN, y1: y + PIN });
    }
    const labels: { d: Drawn; c: ContactRecord; name: string; when: string; state: string; left: number }[] = [];
    const singles = drawn.filter((d) => d.group.members.length === 1);
    const rank = (c: ContactRecord) => (c.key === selected ? 2 : numbers[c.key] ? 1 : 0);
    singles.sort((a, b) => {
      const ca = a.group.members[0]!;
      const cb = b.group.members[0]!;
      return rank(cb) - rank(ca) || cb.lastAdvert - ca.lastAdvert;
    });
    for (const d of singles) {
      const c = d.group.members[0]!;
      const age = c.lastAdvert > 0 ? nowSec - c.lastAdvert : Infinity;
      const state = freshness(c.type, age);
      const name = c.name || c.prefix;
      const heard = Number.isFinite(age) ? ago(c.lastAdvert * 1000) : "";
      const when = heard ? ` · ${heard === justNow ? now : heard}` : "";
      const left = d.x + (numbers[c.key] ? 19 : 15);
      const box = { x0: left, y0: d.y - 8, x1: left + this.width(ctx, name) + this.width(ctx, when), y1: d.y + 8 };
      if (c.key !== selected && taken.hits(box)) continue;
      taken.add(box);
      labels.push({ d, c, name, when, state, left });
    }

    for (const d of drawn) {
      if (d.group.members.length === 1) this.pin(ctx, pal, d, nowSec);
      else this.circle(ctx, pal, d, holdsPick(d));
    }

    ctx.font = nameFont;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.lineJoin = "round";
    ctx.lineWidth = 3;
    ctx.strokeStyle = pal.bg;
    for (const l of labels) {
      const y = l.d.y + 0.5;
      const w = this.width(ctx, l.name);
      ctx.strokeText(l.name, l.left, y);
      ctx.fillStyle = l.state === "stale" ? pal.muted : pal.text;
      ctx.fillText(l.name, l.left, y);
      if (l.when) {
        ctx.strokeText(l.when, l.left + w, y);
        ctx.fillStyle = pal.faint;
        ctx.fillText(l.when, l.left + w, y);
      }
    }
  };

  private pin(ctx: CanvasRenderingContext2D, pal: Palette, d: Drawn, nowSec: number): void {
    const c = d.group.members[0]!;
    const { x, y } = d;
    const age = c.lastAdvert > 0 ? nowSec - c.lastAdvert : Infinity;
    const state = freshness(c.type, age);
    const stale = state === "stale";
    const selected = c.key === this.data.selected;
    const repeater = c.type === AdvType.Repeater;
    const { fill, ink } = swatch(c.name || c.prefix);
    const body = repeater ? pal.text : fill;

    if (selected) {
      ctx.beginPath();
      ctx.arc(x, y, PIN + (repeater ? 5 : 4), 0, 2 * Math.PI);
      ctx.lineWidth = 2;
      ctx.strokeStyle = pal.accent;
      ctx.stroke();
    }
    ctx.globalAlpha = state === "aging" ? 0.6 : 1;
    // The drop shadow the DOM pin had, as a darker copy one pixel down.
    shape(ctx, c.type, x, y + 1, 0.5);
    ctx.fillStyle = "rgba(0,0,0,0.22)";
    ctx.fill();
    shape(ctx, c.type, x, y, 0);
    if (c.type === AdvType.Sensor) {
      ctx.fillStyle = stale ? pal.bg : body;
      ctx.fill();
      if (stale) {
        ctx.lineWidth = 2;
        ctx.strokeStyle = body;
        ctx.stroke();
      }
    } else {
      ctx.fillStyle = pal.bg;
      ctx.fill();
      shape(ctx, c.type, x, y, -2);
      ctx.fillStyle = stale ? pal.bg : body;
      ctx.fill();
      if (stale) {
        ctx.lineWidth = 2;
        ctx.strokeStyle = body;
        shape(ctx, c.type, x, y, -1);
        ctx.stroke();
      }
    }
    if (repeater && !stale) {
      ctx.beginPath();
      ctx.arc(x, y, 2.5, 0, 2 * Math.PI);
      ctx.fillStyle = pal.bg;
      ctx.fill();
    }
    const g = glyph(c);
    if (g.text) {
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.font = g.emoji ? `13px ${pal.font}` : `600 10px ${pal.font}`;
      ctx.fillStyle = stale ? fill : ink;
      ctx.fillText(g.text, x, y + (g.emoji ? 1 : 0.5));
    }
    ctx.globalAlpha = 1;

    const number = this.data.numbers[c.key];
    if (number) {
      ctx.font = `600 10px ${pal.font}`;
      const text = String(number);
      const w = Math.max(16, ctx.measureText(text).width + 12);
      roundRect(ctx, x + 2, y - 19, w, 16, 8);
      ctx.fillStyle = pal.bg;
      ctx.fill();
      roundRect(ctx, x + 4, y - 17, w - 4, 12, 6);
      ctx.fillStyle = pal.accent;
      ctx.fill();
      ctx.fillStyle = pal.accentInk;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(text, x + 2 + w / 2, y - 10.5);
    }
  }

  private circle(ctx: CanvasRenderingContext2D, pal: Palette, d: Drawn, selected: boolean): void {
    const { x, y, r } = d;
    ctx.beginPath();
    ctx.arc(x, y, r + (selected ? 4 : 2), 0, 2 * Math.PI);
    ctx.lineWidth = selected ? 2 : 4;
    ctx.strokeStyle = selected ? pal.accent : pal.groupGlow;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y + 1, r + 0.5, 0, 2 * Math.PI);
    ctx.fillStyle = "rgba(0,0,0,0.22)";
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x, y, r, 0, 2 * Math.PI);
    ctx.fillStyle = pal.bg;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x, y, r - 2, 0, 2 * Math.PI);
    ctx.fillStyle = pal.groupFill;
    ctx.fill();
    ctx.font = `600 12px ${pal.font}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = pal.accentInk;
    ctx.fillText(String(d.group.members.length), x, y + 0.5);
  }
}
