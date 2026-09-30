/**
 * The nodes on a map: every contact whose last advert carried a position, and
 * this radio. The map is MapLibre's, so it pans, pinches and turns with two
 * fingers; a compass button turns it back to north. Tiles are OpenStreetMap's,
 * kept on the device as they are seen (lib/tiles.ts) and handed to the map
 * through a protocol of their own; a dark theme turns them over on the GPU.
 *
 * The nodes are painted on one canvas (lib/nodeCanvas.ts), which keeps a pan
 * and a pinch smooth with hundreds of them. Nodes that would overlap at the
 * current zoom are gathered into one circle with their count unless grouping
 * is turned off; tapping it zooms in on them, or hands them up as a group when
 * they share a spot. The picked node, and the lines over the nodes
 * (lib/mapOverlay.ts: a route coloured by a ping, a line of sight), are the
 * caller's: the map draws them and reports taps, on a node, on a line, and a
 * long press anywhere, and a point of a route dragged onto a node. The phone,
 * once asked where it is, is a ring with a button under it that puts this
 * radio there. Nothing here asks the air for anything.
 */

import { addProtocol, LngLatBounds, Map as MapLibre, Marker, type StyleSpecification } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AdvType, type ContactRecord } from "@meshnet/meshcore";
import { t } from "../i18n/index.js";
import { destination, distanceKm, formatRoundDistance, hasPosition, metresPerPixel, scaleBar } from "../lib/geo.js";
import { EMPTY_OVERLAY, type MapDot, type MapHandle, type MapOverlay } from "../lib/mapOverlay.js";
import type { LosEnd } from "../lib/meshTool.js";
import { NodeCanvas, type LatLon } from "../lib/nodeCanvas.js";
import type { Fix } from "../lib/phonePosition.js";
import type { MenuAt } from "../lib/press.js";
import { useSession } from "../lib/session.js";
import { TILE_URL, tileAttribution, tileBlob } from "../lib/tiles.js";
import { IconButton } from "../ui/Button.js";
import { CompassIcon, FitIcon, GroupIcon, LocateIcon, MinusIcon, PlusIcon, WavesIcon } from "./Icons.js";

function darkTheme(): boolean {
  return document.documentElement.dataset["appearance"] === "dark";
}

/** Tiles through lib/tiles.ts, which keeps them for use with no network; registered once for every map. */
let tilesServed = false;
function serveTiles(): void {
  if (tilesServed) return;
  tilesServed = true;
  addProtocol("osm-cache", async (params) => {
    const m = /^osm-cache:\/\/(\d+)\/(\d+)\/(\d+)/.exec(params.url);
    if (!m) throw new Error(`not a tile: ${params.url}`);
    const blob = await tileBlob(TILE_URL.replace("{z}", m[1]!).replace("{x}", m[2]!).replace("{y}", m[3]!));
    return { data: await blob.arrayBuffer() };
  });
}

/**
 * OSM's light tiles as they are, or turned over for a dark theme: the CSS
 * filter the map once had, invert(1) hue-rotate(180deg) brightness(0.92)
 * contrast(0.88) saturate(0.55), done by the map's shader instead. Inverting
 * last is the same as first, since a half turn of hue, saturation and contrast
 * are all even about the middle grey.
 */
function tilePaint(dark: boolean) {
  return dark
    ? { "raster-hue-rotate": 180, "raster-saturation": -0.45, "raster-contrast": -0.12, "raster-brightness-min": 0.92, "raster-brightness-max": 0 }
    : { "raster-hue-rotate": 0, "raster-saturation": 0, "raster-contrast": 0, "raster-brightness-min": 0, "raster-brightness-max": 1 };
}

function mapStyle(dark: boolean): StyleSpecification {
  return {
    version: 8,
    sources: { osm: { type: "raster", tiles: ["osm-cache://{z}/{x}/{y}"], tileSize: 256, maxzoom: 19 } },
    layers: [{ id: "osm", type: "raster", source: "osm", paint: tilePaint(dark) }],
  };
}

/** A group spread less than this, in metres, is the same spot at any zoom, and is listed rather than zoomed into. */
const SAME_SPOT_M = 25;

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function element(className: string, html: string, size: [number, number]): HTMLDivElement {
  const el = document.createElement("div");
  el.className = className;
  el.innerHTML = html;
  el.style.width = `${size[0]}px`;
  el.style.height = `${size[1]}px`;
  return el;
}

function selfHtml(name: string): string {
  return `<span class="map-self-pulse"></span><span class="map-self-dot"></span><span class="map-name">${escapeHtml(name)}</span>`;
}

/** The phone: a hollow ring, apart from this radio's filled dot; unnamed under the radio's own name when the two are together. */
function phoneHtml(named: boolean): string {
  const name = named ? `<span class="map-name">${escapeHtml(t("mesh.map.phone"))}</span>` : "";
  return `<span class="map-phone-ring"></span>${name}`;
}

/** The button under the phone's ring; the marker has no size, and the button hangs from its point. */
function putHtml(distance: string | null): string {
  const pin = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-6-5.5-6-11a6 6 0 0 1 12 0c0 5.5-6 11-6 11z"/><circle cx="12" cy="10" r="2"/></svg>';
  const far = distance ? ` <small>${escapeHtml(distance)}</small>` : "";
  return `<span>${pin}${escapeHtml(t("mesh.map.putHere"))}${far}</span>`;
}

const SVG = "http://www.w3.org/2000/svg";

interface Path {
  el: SVGPathElement;
  points: LatLon[];
}

/**
 * What the map draws between its tiles and its nodes, placed again on every
 * frame the map draws: the lines of the overlay as SVG paths with the CSS
 * classes they always had, a survey's points, the circle of how sure the
 * phone's fix is, and the rings of a flood. A line that opens something has a
 * wide path nobody sees over it, for a finger to find.
 */
class Overlay {
  private readonly svg = document.createElementNS(SVG, "svg");
  private readonly under = document.createElementNS(SVG, "g");
  private readonly lines = document.createElementNS(SVG, "g");
  private readonly dotGroup = document.createElementNS(SVG, "g");
  private readonly html = document.createElement("div");
  private paths: Path[] = [];
  private dots: { el: SVGCircleElement; at: LatLon }[] = [];
  private halo: { el: SVGCircleElement; at: LatLon; metres: number } | null = null;
  private floats: { el: HTMLElement; at: LatLon; half: number }[] = [];

  constructor(
    private readonly map: MapLibre,
    parent: HTMLElement,
  ) {
    this.svg.setAttribute("class", "map-overlay");
    this.svg.setAttribute("aria-hidden", "true");
    this.svg.append(this.under, this.lines, this.dotGroup);
    this.html.className = "map-overlay";
    parent.append(this.html, this.svg);
    map.on("render", this.frame);
  }

  remove(): void {
    this.map.off("render", this.frame);
    this.svg.remove();
    this.html.remove();
  }

  /** A path through `points` in the given classes; tapping it runs `onTap` when there is one. */
  path(points: LatLon[], className: string, onTap?: () => void): Path {
    const el = document.createElementNS(SVG, "path");
    el.setAttribute("class", className);
    if (onTap) {
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        onTap();
      });
    }
    this.lines.append(el);
    const path = { el, points };
    this.paths.push(path);
    return path;
  }

  drop(path: Path): void {
    path.el.remove();
    this.paths = this.paths.filter((p) => p !== path);
  }

  clearPaths(): void {
    for (const p of this.paths) p.el.remove();
    this.paths = [];
    for (const f of this.floats) f.el.remove();
    this.floats = [];
  }

  /** An element held at a spot under the nodes, by its middle: the rings of a flood. */
  float(el: HTMLElement, at: LatLon, size: number): void {
    el.style.width = `${size}px`;
    el.style.height = `${size}px`;
    this.html.append(el);
    this.floats.push({ el, at, half: size / 2 });
  }

  setDots(dots: MapDot[] | null, picked: number | null): void {
    for (const d of this.dots) d.el.remove();
    this.dots = (dots ?? []).map((d, i) => {
      const el = document.createElementNS(SVG, "circle");
      const on = i === picked;
      el.setAttribute("class", `map-dot ${d.tone}${on ? " on" : ""}`);
      el.setAttribute("r", String(on ? 8 : d.tone === "off" ? 2.5 : 6));
      this.dotGroup.append(el);
      return { el, at: { lat: d.lat, lon: d.lon } };
    });
    this.map.triggerRepaint();
  }

  setHalo(at: LatLon | null, metres: number): void {
    if (!at) {
      this.halo?.el.remove();
      this.halo = null;
    } else {
      if (!this.halo) {
        const el = document.createElementNS(SVG, "circle");
        el.setAttribute("class", "map-phone-halo");
        this.under.append(el);
        this.halo = { el, at, metres };
      }
      this.halo.at = at;
      this.halo.metres = metres;
    }
    this.map.triggerRepaint();
  }

  private frame = (): void => {
    const map = this.map;
    const at = (p: LatLon) => map.project([p.lon, p.lat]);
    for (const p of this.paths) {
      if (p.points.length < 2) {
        p.el.removeAttribute("d");
        continue;
      }
      p.el.setAttribute(
        "d",
        p.points
          .map((q, i) => {
            const s = at(q);
            return `${i ? "L" : "M"}${s.x.toFixed(1)} ${s.y.toFixed(1)}`;
          })
          .join(""),
      );
    }
    for (const d of this.dots) {
      const { x, y } = at(d.at);
      d.el.setAttribute("cx", x.toFixed(1));
      d.el.setAttribute("cy", y.toFixed(1));
    }
    if (this.halo) {
      const { x, y } = at(this.halo.at);
      // The map's world is 512 pixels round at zoom 0.
      const metresPerPixel = (40_075_016.686 * Math.cos((this.halo.at.lat * Math.PI) / 180)) / (512 * 2 ** map.getZoom());
      this.halo.el.setAttribute("cx", x.toFixed(1));
      this.halo.el.setAttribute("cy", y.toFixed(1));
      this.halo.el.setAttribute("r", Math.max(0, this.halo.metres / metresPerPixel).toFixed(1));
    }
    for (const f of this.floats) {
      const { x, y } = at(f.at);
      f.el.style.transform = `translate(${x - f.half}px, ${y - f.half}px)`;
    }
  };
}

export interface MapProps {
  /** The node picked, drawn ringed with its route. */
  selected: string | null;
  onSelect: (key: string | null) => void;
  /** Nodes that share a spot no zoom separates. */
  onGroup: (keys: string[]) => void;
  /** Which nodes to show. */
  filter: (contact: ContactRecord) => boolean;
  /** Pixels at the bottom covered by a sheet, so nothing is fitted under it. */
  coverBottom?: number | undefined;
  /** Pixels at the top under a phone's notch or status bar. */
  coverTop?: number | undefined;
  /** A phone zooms with two fingers; a desktop has buttons too. */
  zoomButtons?: boolean | undefined;
  /** Lines over the nodes, and numbers on the relays of a route being changed. */
  overlay?: MapOverlay | undefined;
  /** A line of the overlay tapped. */
  onLeg?: ((from: LosEnd, to: LosEnd) => void) | undefined;
  /** A long press, or a right click, on the map itself: the spot, and where on the screen it was. */
  onHold?: ((lat: number, lon: number, at: MenuAt) => void) | undefined;
  /** A point of a route dragged onto a node: its key, or "self" for this radio. */
  onHandleDrop?: ((handle: MapHandle, onto: string) => void) | undefined;
  /** The "who hears me" button over the map tapped, and whether its sheet is open now. */
  onHears?: (() => void) | undefined;
  hearsOn?: boolean | undefined;
  /** The same button held until its ring closes: a survey starts. Absent when one cannot. */
  onHearsHold?: (() => void) | undefined;
  /** Points to bring into view together, once for each `id`: a repeater and its neighbours. */
  fit?: { id: string; points: [number, number][] } | null | undefined;
  /** The phone, when it is shown: a ring over a circle of how sure the fix is. */
  phone?: Fix | null | undefined;
  /** A button under the phone that puts this radio there, with how far the radio is now. */
  putHere?: { distance: string | null; onPut: () => void } | null | undefined;
  /** "Where am I": finds the phone and says where it is, or null to go to this radio instead. */
  onLocate?: (() => Promise<{ lat: number; lon: number } | null>) | undefined;
  /** A coverage survey's points, the one opened ringed; a tap on one hands up its place. */
  dots?: MapDot[] | null | undefined;
  pickedDot?: number | null | undefined;
  onDot?: ((index: number) => void) | undefined;
  /**
   * Keeps the phone in view as it moves, with these points: the repeaters
   * that have answered in the survey `id`. The map moves out as far as they
   * need and never back in by itself; a hand on it makes the scale the
   * reader's, until "where am I" hands the view back.
   */
  follow?: { id: string; points: [number, number][] } | null | undefined;
  /** A survey running: a red dot on the "who hears me" button, and a scale in the corner. */
  recording?: boolean | undefined;
  /** What stands at the top of the map, in the middle: a running survey's number. */
  top?: ReactNode | undefined;
}

/** How long a press on ≋ waits before it is a hold and the ring shows, and how long the ring then takes to close. */
const HEARS_WAIT_MS = 250;
const HEARS_HOLD_MS = 700;

/**
 * The "who hears me" button. A tap opens its sheet, which sends nothing by
 * itself. Held, when a survey can start, a red ring runs round it with a
 * word beside it, and a survey starts as the ring closes; let go sooner, it
 * was a tap. The sheet tells of the hold until it has been used once.
 */
function HearsButton({ on, recording, onTap, onHoldDone }: { on: boolean; recording: boolean; onTap: () => void; onHoldDone: (() => void) | undefined }) {
  const [holding, setHolding] = useState(false);
  const timers = useRef<number[]>([]);
  const fired = useRef(false);
  const done = useRef(onHoldDone);
  done.current = onHoldDone;
  const stop = () => {
    for (const id of timers.current) clearTimeout(id);
    timers.current = [];
    setHolding(false);
  };
  useEffect(() => stop, []);
  return (
    <IconButton
      label={onHoldDone ? t("mesh.whoHearsMeHold") : t("mesh.whoHearsMe")}
      className={["map-hears", on ? "on" : "", holding ? "holding" : ""].join(" ")}
      aria-pressed={on}
      onPointerDown={(e) => {
        fired.current = false;
        if (!done.current || e.button !== 0) return;
        timers.current = [
          window.setTimeout(() => setHolding(true), HEARS_WAIT_MS),
          window.setTimeout(() => {
            fired.current = true;
            stop();
            done.current?.();
          }, HEARS_WAIT_MS + HEARS_HOLD_MS),
        ];
      }}
      onPointerUp={stop}
      onPointerLeave={stop}
      onPointerCancel={stop}
      // A long press would otherwise bring the phone's own menu over the button.
      onContextMenu={(e) => e.preventDefault()}
      onClick={() => {
        if (fired.current) {
          fired.current = false;
          return;
        }
        onTap();
      }}
    >
      <WavesIcon size={18} />
      {recording ? <span className="map-rec" aria-hidden="true" /> : null}
      <svg className="map-hold" viewBox="0 0 48 48" aria-hidden="true">
        <circle cx="24" cy="24" r="22" />
      </svg>
      {holding ? (
        <span className="map-hold-word" aria-hidden="true">
          {t("tools.survey.holdWord")}
        </span>
      ) : null}
    </IconButton>
  );
}

/** How near a node, in pixels, a dragged point lets go onto it. */
const SNAP_PX = 36;
/** How near a survey's point, in pixels, a tap opens it. */
const DOT_PX = 18;
/** How much of the map's top a running survey's number takes, which a fit keeps clear of as it does of the controls. */
const TOP_PX = 52;
/** The longest the scale in the corner is drawn. */
const SCALE_PX = 96;
/**
 * A finger held this long on the map opens the spot's menu. The map takes the
 * touch from its start, so neither Android's web view nor iOS's turns a long
 * press into a `contextmenu` of their own; a mouse still has its right click.
 */
const HOLD_MS = 550;

const GROUPING_KEY = "meshnet.map.grouping";

/** Whether nodes close together are gathered into one circle; on unless turned off. */
function groupingWanted(): boolean {
  try {
    return localStorage.getItem(GROUPING_KEY) !== "off";
  } catch {
    return true;
  }
}

/** Where the map was left, so coming back to it, from a profile or another section, finds it there, turned as it was. */
let lastView: { center: [number, number]; zoom: number; bearing: number } | null = null;

export default function MapView({ selected, onSelect, onGroup, filter, coverBottom = 0, coverTop = 0, zoomButtons = false, overlay = EMPTY_OVERLAY, onLeg, onHold, onHandleDrop, onHears, hearsOn = false, onHearsHold, fit = null, phone = null, putHere = null, onLocate, dots = null, pickedDot = null, onDot, follow = null, recording = false, top = null }: MapProps) {
  const state = useSession();
  const box = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibre | null>(null);
  const nodes = useRef<NodeCanvas | null>(null);
  const layer = useRef<Overlay | null>(null);
  const selfMarker = useRef<Marker | null>(null);
  const phoneMarker = useRef<Marker | null>(null);
  const putMarker = useRef<Marker | null>(null);
  // Markers the overlay brings: pins, the labels of legs, a route's handles.
  const overlayMarkers = useRef<Marker[]>([]);
  const fitted = useRef(false);
  const [grouping, setGrouping] = useState(groupingWanted);
  const [locating, setLocating] = useState(false);
  const [zoom, setZoom] = useState<number | null>(null);
  // Whether the map is turned off north, which brings the compass; the needle itself is turned without a render.
  const [turned, setTurned] = useState(false);
  const needle = useRef<HTMLSpanElement>(null);
  // A hand moved or scaled the map while it followed the phone: from then on the scale is the reader's.
  const own = useRef(false);
  // The handlers the map holds are set once; they read the latest callbacks from here.
  const calls = useRef({ onSelect, onGroup, onLeg, onHold, onHandleDrop, onPut: putHere?.onPut, onDot, dots });
  calls.current = { onSelect, onGroup, onLeg, onHold, onHandleDrop, onPut: putHere?.onPut, onDot, dots };

  const contacts = state.contacts;
  const selfLat = state.self && hasPosition(state.self.lat, state.self.lon) ? state.self.lat : null;
  const selfLon = selfLat !== null ? state.self!.lon : null;
  const self = useMemo(() => (selfLat !== null && selfLon !== null ? { lat: selfLat, lon: selfLon } : null), [selfLat, selfLon]);
  const selfName = state.self?.name ?? t("mesh.map.thisRadio");
  // Read when the map moves rather than when it renders: the sheet over it moves often and should not redraw it.
  const cover = useRef({ top: coverTop, bottom: coverBottom });
  cover.current = { top: coverTop, bottom: coverBottom };
  const topped = useRef(false);
  topped.current = top !== null;
  /** A fit keeps clear of the controls, the credit, and what lies over the map. */
  const padding = () => ({ top: 56 + cover.current.top + (topped.current ? TOP_PX : 0), bottom: 40 + cover.current.bottom, left: 40, right: 64 });
  const size = () => ({ x: box.current?.clientWidth ?? 0, y: box.current?.clientHeight ?? 0 });
  /** A point in the middle of what is left uncovered, not of the whole map. */
  const centerOn = (at: LatLon, z: number, animate = true) => {
    const { top, bottom } = cover.current;
    map.current?.easeTo({ center: [at.lon, at.lat], zoom: z, offset: [0, (top - bottom) / 2], ...(animate ? {} : { duration: 0 }) });
  };
  /** Several points in view, the map left turned as it is. */
  const fitPoints = (points: [number, number][], maxZoom: number, animate = true) => {
    const m = map.current;
    if (!m || points.length === 0) return;
    const bounds = new LngLatBounds();
    for (const [lat, lon] of points) bounds.extend([lon, lat]);
    m.fitBounds(bounds, { padding: padding(), maxZoom, bearing: m.getBearing(), animate });
  };
  /** Whether a point is on the map as it stands: within what a fit keeps clear, or anywhere on it. */
  const inView = (lat: number, lon: number, clear: boolean) => {
    const m = map.current;
    if (!m) return false;
    const p = m.project([lon, lat]);
    const { x, y } = size();
    // A point a fit has put on the very edge is still in.
    const pad = clear ? padding() : { top: 0, bottom: 0, left: 0, right: 0 };
    return p.x >= pad.left - 2 && p.x <= x - pad.right + 2 && p.y >= pad.top - 2 && p.y <= y - pad.bottom + 2;
  };

  const placed = useMemo(() => Object.values(contacts).filter((c) => hasPosition(c.lat, c.lon)).sort((a, b) => (a.key < b.key ? -1 : 1)), [contacts]);
  const shown = useMemo(() => placed.filter(filter), [placed, filter]);
  const picked = selected ? contacts[selected] ?? null : null;
  const numbers = overlay.numbers;
  const heardKey = overlay.heard?.join(",") ?? "";
  const heard = useMemo(() => new Set(heardKey ? heardKey.split(",") : []), [heardKey]);
  // What a dragged point can let go onto, read while it is dragged: every node on the map, and this radio.
  const targets = useRef<{ key: string; at: LatLon }[]>([]);
  targets.current = [...placed.map((c) => ({ key: c.key, at: { lat: c.lat, lon: c.lon } })), ...(self ? [{ key: "self", at: self }] : [])];

  // The map itself, once.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    serveTiles();
    const m = new MapLibre({
      container: el,
      style: mapStyle(darkTheme()),
      center: lastView?.center ?? [0, 20],
      zoom: lastView?.zoom ?? 1,
      bearing: lastView?.bearing ?? 0,
      minZoom: 1,
      maxZoom: 18,
      maxPitch: 0,
      pitchWithRotate: false,
      touchPitch: false,
      attributionControl: false,
      renderWorldCopies: true,
    });
    if (lastView) fitted.current = true;
    const canvasBox = m.getCanvasContainer();
    // Over the tiles: the overlay's lines, then the nodes; the markers come over both.
    const overlayLayer = new Overlay(m, canvasBox);
    const nodeCanvas = new NodeCanvas(m, canvasBox);
    layer.current = overlayLayer;
    nodes.current = nodeCanvas;

    // The finger lifting after a long press is not a tap on the map as well, however long it stayed down.
    let heldAt = 0;
    let fingerHeld = false;
    const hold = (x: number, y: number) => {
      if (!calls.current.onHold) return;
      heldAt = Date.now();
      // A map panned round the world gives longitudes past 180; the spot is the same one back on the globe.
      const spot = m.unproject([x, y]).wrap();
      const rect = el.getBoundingClientRect();
      calls.current.onHold(spot.lat, spot.lng, { x: rect.left + x, y: rect.top + y });
    };
    m.on("contextmenu", (e) => {
      e.preventDefault();
      if (Date.now() - heldAt < 800) return;
      hold(e.point.x, e.point.y);
    });
    {
      let timer = 0;
      let start: { x: number; y: number } | null = null;
      const cancel = () => {
        window.clearTimeout(timer);
        start = null;
      };
      canvasBox.addEventListener(
        "touchstart",
        (e) => {
          cancel();
          fingerHeld = false;
          const touch = e.touches[0];
          if (e.touches.length !== 1 || !touch) return;
          const rect = el.getBoundingClientRect();
          start = { x: touch.clientX - rect.left, y: touch.clientY - rect.top };
          const at = start;
          timer = window.setTimeout(() => {
            fingerHeld = true;
            hold(at.x, at.y);
          }, HOLD_MS);
        },
        { passive: true },
      );
      canvasBox.addEventListener(
        "touchmove",
        (e) => {
          const touch = e.touches[0];
          if (!start || !touch) return;
          const rect = el.getBoundingClientRect();
          if (e.touches.length > 1 || Math.hypot(touch.clientX - rect.left - start.x, touch.clientY - rect.top - start.y) > 10) cancel();
        },
        { passive: true },
      );
      canvasBox.addEventListener("touchend", cancel);
      canvasBox.addEventListener("touchcancel", cancel);
    }
    // The canvas takes no pointer events: a tap lands on the map, and is looked up among the nodes drawn.
    m.on("click", (e) => {
      if (fingerHeld || Date.now() - heldAt < 500) {
        fingerHeld = false;
        return;
      }
      const mouse = (e.originalEvent as PointerEvent).pointerType === "mouse";
      const members = nodeCanvas.hit(e.point, mouse ? 3 : 10);
      if (!members) {
        // Missing the nodes, a tap may land on a survey's point: the nearest within reach of a finger.
        const { dots: points, onDot: open } = calls.current;
        if (points && open) {
          let best = -1;
          let reach = mouse ? 8 : DOT_PX;
          points.forEach((d, i) => {
            if (d.tone === "off") return;
            const p = m.project([d.lon, d.lat]);
            const gap = Math.hypot(p.x - e.point.x, p.y - e.point.y);
            if (gap < reach) {
              best = i;
              reach = gap;
            }
          });
          if (best >= 0) return open(best);
        }
        return calls.current.onSelect(null);
      }
      if (members.length === 1) return calls.current.onSelect(members[0]!.key);
      const lats = members.map((c) => c.lat);
      const lons = members.map((c) => c.lon);
      const spread = distanceKm(Math.min(...lats), Math.min(...lons), Math.max(...lats), Math.max(...lons)) * 1000;
      if (spread < SAME_SPOT_M || m.getZoom() >= m.getMaxZoom()) calls.current.onGroup(members.map((c) => c.key));
      else fitPoints(members.map((c) => [c.lat, c.lon]), m.getMaxZoom());
    });
    // A pointer over a node shows it can be clicked; looked up once a frame at most.
    let hoverFrame = 0;
    m.on("mousemove", (e) => {
      if (hoverFrame) return;
      hoverFrame = requestAnimationFrame(() => {
        hoverFrame = 0;
        m.getCanvas().style.cursor = nodeCanvas.hit(e.point, 3) ? "pointer" : "";
      });
    });
    // Not while hidden under a profile: a map with no size has no middle to remember.
    m.on("moveend", () => {
      if (el.clientHeight > 0) {
        const c = m.getCenter();
        lastView = { center: [c.lng, c.lat], zoom: m.getZoom(), bearing: m.getBearing() };
      }
    });
    m.on("zoomend", () => setZoom(m.getZoom()));
    const turn = () => {
      const b = m.getBearing();
      setTurned(Math.abs(b) >= 0.5);
      if (needle.current) needle.current.style.transform = `rotate(${-b}deg)`;
    };
    m.on("rotate", turn);
    m.on("dragstart", () => {
      own.current = true;
    });
    // A pinch, a wheel or a double tap; the map's own moves carry no event of the reader's.
    m.on("zoomstart", (e) => {
      if (e.originalEvent) own.current = true;
    });
    setZoom(m.getZoom());
    turn();
    map.current = m;
    // The pane is sized by the layout, which changes when a phone turns or a desktop window is resized.
    const resize = new ResizeObserver(() => m.resize());
    resize.observe(el);
    // The tiles are turned over for a dark theme by the map itself; the nodes are coloured when drawn.
    const theme = new MutationObserver(() => {
      const paint = tilePaint(darkTheme());
      if (m.getLayer("osm")) for (const [key, value] of Object.entries(paint)) m.setPaintProperty("osm", key, value);
      nodeCanvas.redraw();
    });
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ["data-appearance"] });
    // The names are measured in the app's font, which may arrive after the first paint.
    void document.fonts?.ready.then(() => nodeCanvas.redraw());
    // "4 min" beside a name turns into "5 min".
    const minute = window.setInterval(() => {
      if (el.clientHeight > 0) nodeCanvas.redraw();
    }, 30_000);
    return () => {
      window.clearInterval(minute);
      cancelAnimationFrame(hoverFrame);
      theme.disconnect();
      resize.disconnect();
      nodeCanvas.remove();
      overlayLayer.remove();
      m.remove();
      map.current = null;
      nodes.current = null;
      layer.current = null;
      selfMarker.current = null;
      phoneMarker.current = null;
      putMarker.current = null;
      overlayMarkers.current = [];
      fitted.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The nodes: handed to the canvas, which groups them for the zoom and paints them.
  useEffect(() => {
    nodes.current?.setData({ nodes: shown, selected, numbers, heard, grouping, self });
  }, [shown, selected, numbers, heard, grouping, self]);

  // This radio, kept as one marker so its pulse is not restarted by every change.
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    if (!self) {
      selfMarker.current?.remove();
      selfMarker.current = null;
      return;
    }
    if (!selfMarker.current) {
      selfMarker.current = new Marker({ element: element("map-self", selfHtml(selfName), [22, 22]) }).setLngLat([self.lon, self.lat]).addTo(m);
    } else {
      selfMarker.current.setLngLat([self.lon, self.lat]);
      selfMarker.current.getElement().innerHTML = selfHtml(selfName);
    }
  }, [self, selfName]);

  // The phone, under this radio's dot when the two are at one spot.
  const phoneLat = phone?.lat ?? null;
  const phoneLon = phone?.lon ?? null;
  const phoneAccuracy = phone?.accuracy ?? null;
  // Close enough to this radio that the two names would overlap at this zoom, the phone goes unnamed.
  const phoneNamed = useMemo(() => {
    const m = map.current;
    if (!m || zoom === null || phoneLat === null || phoneLon === null || !self) return true;
    const a = m.project([phoneLon, phoneLat]);
    const b = m.project([self.lon, self.lat]);
    return Math.hypot(a.x - b.x, a.y - b.y) > 40;
  }, [zoom, phoneLat, phoneLon, self]);
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    if (phoneLat === null || phoneLon === null || phoneAccuracy === null) {
      phoneMarker.current?.remove();
      phoneMarker.current = null;
      layer.current?.setHalo(null, 0);
      return;
    }
    if (!phoneMarker.current) phoneMarker.current = new Marker({ element: element("map-phone", phoneHtml(phoneNamed), [16, 16]) }).setLngLat([phoneLon, phoneLat]).addTo(m);
    else phoneMarker.current.setLngLat([phoneLon, phoneLat]);
    layer.current?.setHalo({ lat: phoneLat, lon: phoneLon }, phoneAccuracy);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phoneLat, phoneLon, phoneAccuracy]);
  useEffect(() => {
    const el = phoneMarker.current?.getElement();
    if (el) el.innerHTML = phoneHtml(phoneNamed);
  }, [phoneNamed]);

  // "Put the radio here", hanging under the phone's ring.
  const putDistance = putHere ? putHere.distance : undefined;
  useEffect(() => {
    const m = map.current;
    putMarker.current?.remove();
    putMarker.current = null;
    if (!m || putDistance === undefined || phoneLat === null || phoneLon === null) return;
    const label = t("mesh.map.putHere");
    const el = element("map-put", putHtml(putDistance), [0, 0]);
    el.title = label;
    el.setAttribute("role", "button");
    el.setAttribute("aria-label", label);
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      calls.current.onPut?.();
    });
    putMarker.current = new Marker({ element: el, anchor: "top-left" }).setLngLat([phoneLon, phoneLat]).addTo(m);
  }, [putDistance, phoneLat, phoneLon]);

  // A survey's points, drawn again when one is added or picked; a tap on one is looked up by the map's click.
  useEffect(() => {
    layer.current?.setDots(dots, pickedDot);
  }, [dots, pickedDot]);

  // Following the phone through a survey: it and every repeater that has answered are kept in what the sheet
  // leaves, no closer than a street. The map moves out when a farther one answers and never back in by itself:
  // a view that closed in and out with every point was hard to read from behind a wheel (#66). A hand on the
  // map makes its scale the reader's, and the map then only goes along with the phone while the phone is in
  // sight, until "where am I" hands the view back.
  const followed = useRef<string | null>(null);
  const phoneWas = useRef<[number, number] | null>(null);
  const followKey = follow ? JSON.stringify(follow) : null;
  useEffect(() => {
    const m = map.current;
    // A map with no size, under a profile or another section, has nothing to fit into.
    if (!follow || !m || phoneLat === null || phoneLon === null || size().y === 0) return;
    // Nor has one the list has come up over: there is no room left to keep anything in.
    const clear = padding();
    if (size().y - clear.top - clear.bottom < 48) return;
    const was = phoneWas.current;
    phoneWas.current = [phoneLat, phoneLon];
    const points: [number, number][] = [[phoneLat, phoneLon], ...follow.points];
    if (followed.current !== follow.id) {
      followed.current = follow.id;
      own.current = false;
      fitPoints(points, 15, false);
      return;
    }
    // A move under way, the reader's or the map's, is let finish; the next fix is seconds off.
    if (m.isMoving()) return;
    if (own.current) {
      if (was && inView(was[0], was[1], false) && !inView(phoneLat, phoneLon, true)) centerOn({ lat: phoneLat, lon: phoneLon }, m.getZoom());
      return;
    }
    if (points.every(([lat, lon]) => inView(lat, lon, true))) return;
    fitPoints(points, Math.min(15, m.getZoom()));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [followKey, phoneLat, phoneLon]);

  // The lines over the nodes: a route and how it sounded, a line of sight, the answers to "who hears me".
  useEffect(() => {
    const m = map.current;
    const lines = layer.current;
    if (!m || !lines) return;
    lines.clearPaths();
    for (const marker of overlayMarkers.current) marker.remove();
    overlayMarkers.current = [];
    // How far a filter reaches, under the lines it explains, with the distance written up and to the left, clear of the buttons.
    for (const ring of overlay.rings ?? []) {
      const round = Array.from({ length: 73 }, (_, i) => destination(ring.lat, ring.lon, ring.km, i * 5));
      lines.path(round, "map-ring");
      const el = document.createElement("div");
      el.className = "map-ring-label";
      el.textContent = ring.label;
      const at = destination(ring.lat, ring.lon, ring.km, 315);
      overlayMarkers.current.push(new Marker({ element: el }).setLngLat([at.lon, at.lat]).addTo(m));
    }
    for (const line of overlay.lines) {
      const points = [
        { lat: line.from.lat, lon: line.from.lon },
        { lat: line.to.lat, lon: line.to.lon },
      ];
      const mark = line.mark ? ` ${line.mark}` : "";
      // Thin lines drawn beside a route go without its halo.
      if (line.tone !== "back" && line.tone !== "was") lines.path(points, `map-leg-under${mark}`);
      lines.path(points, `map-leg ${line.tone}${mark}`);
      // A wide line nobody sees, so a finger finds a thin one.
      if (line.tappable) lines.path(points, "map-hit", () => calls.current.onLeg?.(line.from, line.to));
      if (line.label) {
        // Above the leg's middle, clear of the point that drags it.
        const el = element("map-leg-label", escapeHtml(line.label), [64, 18]);
        el.style.pointerEvents = "none";
        overlayMarkers.current.push(new Marker({ element: el, offset: [0, -21] }).setLngLat([(line.from.lon + line.to.lon) / 2, (line.from.lat + line.to.lat) / 2]).addTo(m));
      }
    }
    for (const pin of overlay.pins) {
      const el = element("map-spot", "<span></span>", [20, 20]);
      el.style.pointerEvents = "none";
      overlayMarkers.current.push(new Marker({ element: el, anchor: "bottom" }).setLngLat([pin.lon, pin.lat]).addTo(m));
    }
    for (const handle of overlay.handles) overlayMarkers.current.push(dragHandle(m, lines, handle, handle.key ? overlay.numbers[handle.key] : undefined));
    if (overlay.pulse) {
      // A flood going out: rings spreading from this radio, under the nodes.
      const el = document.createElement("div");
      el.className = "map-flood";
      el.innerHTML = "<i></i><i></i><i></i>";
      lines.float(el, { lat: overlay.pulse.lat, lon: overlay.pulse.lon }, 260);
    }
    m.triggerRepaint();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overlay]);

  /** The node nearest to a point, within reach of a finger letting go. */
  const snapAt = (at: LatLon): { key: string; at: LatLon } | null => {
    const m = map.current;
    if (!m) return null;
    const p = m.project([at.lon, at.lat]);
    const px = (q: LatLon) => {
      const s = m.project([q.lon, q.lat]);
      return Math.hypot(s.x - p.x, s.y - p.y);
    };
    let best: { key: string; at: LatLon } | null = null;
    let reach = SNAP_PX;
    for (const target of targets.current) {
      const d = px(target.at);
      if (d < reach) {
        best = target;
        reach = d;
      }
    }
    // Nodes gathered into a circle are let go onto through it: a repeater among them, the nearest first.
    for (const entry of nodes.current?.groups() ?? []) {
      if (entry.members.length < 2) continue;
      const d = px(entry.at);
      if (d >= reach) continue;
      const near = (c: ContactRecord) => px({ lat: c.lat, lon: c.lon });
      const member = [...entry.members].sort((a, b) => Number(b.type === AdvType.Repeater) - Number(a.type === AdvType.Repeater) || near(a) - near(b))[0]!;
      best = { key: member.key, at: entry.at };
      reach = d;
    }
    return best;
  };

  /**
   * A point of a route that follows the finger: the legs either side stretch
   * to it, and a ring marks the node it would let go onto. Let go, it goes
   * back to its place and says where it was dropped; the caller redraws the
   * route. A tap on a relay picks it, a tap on a leg's middle opens the leg.
   */
  function dragHandle(m: MapLibre, lines: Overlay, handle: MapHandle, number: number | undefined): Marker {
    const size = handle.kind === "hop" ? 34 : 26;
    // A relay's place in a route being changed rides on its ring, which covers the marker's own.
    const badge = number ? `<b class="map-num">${number}</b>` : "";
    const home = { lat: handle.lat, lon: handle.lon };
    const el = element(`map-handle map-handle-${handle.kind}`, `<span></span>${badge}`, [size, size]);
    el.style.zIndex = handle.kind === "hop" ? "5" : "4";
    const marker = new Marker({ element: el, draggable: true }).setLngLat([home.lon, home.lat]).addTo(m);
    let rubber: Path | null = null;
    let ring: Marker | null = null;
    let droppedAt = 0;
    const stretch = (tip: LatLon) => {
      if (!rubber) return;
      rubber.points = [...(handle.from ? [{ lat: handle.from.lat, lon: handle.from.lon }] : []), tip, ...(handle.to ? [{ lat: handle.to.lat, lon: handle.to.lon }] : [])];
      m.triggerRepaint();
    };
    const tip = (): LatLon => {
      const at = marker.getLngLat();
      return { lat: at.lat, lon: at.lng };
    };
    marker.on("dragstart", () => {
      el.classList.add("dragging");
      rubber = lines.path([], "map-leg rubber");
      ring = new Marker({ element: element("map-snap", "<span></span>", [40, 40]) }).setLngLat([home.lon, home.lat]).setOpacity("0").addTo(m);
      stretch(home);
    });
    marker.on("drag", () => {
      const snap = snapAt(tip());
      stretch(snap?.at ?? tip());
      if (snap) ring?.setLngLat([snap.at.lon, snap.at.lat]);
      ring?.setOpacity(snap ? "1" : "0");
    });
    marker.on("dragend", () => {
      const snap = snapAt(tip());
      if (rubber) lines.drop(rubber);
      rubber = null;
      ring?.remove();
      ring = null;
      el.classList.remove("dragging");
      droppedAt = Date.now();
      marker.setLngLat([home.lon, home.lat]);
      if (snap) calls.current.onHandleDrop?.(handle, snap.key);
    });
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      if (Date.now() - droppedAt < 400) return;
      if (handle.kind === "hop" && handle.key) calls.current.onSelect(handle.key);
      else if (handle.kind === "gap" && handle.from && handle.to) calls.current.onLeg?.(handle.from, handle.to);
    });
    return marker;
  }

  // A node picked from outside the map, from its profile or the list, is brought into view. On a phone the
  // pick opens its profile over the map, which then has no size; it is brought into view when the map shows again.
  const pickedKey = picked && hasPosition(picked.lat, picked.lon) ? picked.key : null;
  const unseenPick = useRef<string | null>(null);
  const bringIntoView = (key: string) => {
    const m = map.current;
    const c = contacts[key];
    if (!m || !c) return;
    m.resize();
    const { x: width, y: height } = size();
    const { top, bottom } = cover.current;
    const clear = { left: 40, right: width - 64, top: top + 56, bottom: height - bottom - 40 };
    if (clear.right <= clear.left || clear.bottom <= clear.top) {
      unseenPick.current = key;
      return;
    }
    unseenPick.current = null;
    const p = m.project([c.lon, c.lat]);
    if (p.x > clear.left && p.x < clear.right && p.y > clear.top && p.y < clear.bottom) return;
    // In sight but under the sheet or at an edge: moved just clear. Out of sight: brought to the middle.
    if (p.x >= 0 && p.x <= width && p.y >= 0 && p.y <= height) {
      const dx = p.x < clear.left ? p.x - clear.left : p.x > clear.right ? p.x - clear.right : 0;
      const dy = p.y < clear.top ? p.y - clear.top : p.y > clear.bottom ? p.y - clear.bottom : 0;
      m.panBy([dx, dy]);
    } else {
      centerOn({ lat: c.lat, lon: c.lon }, Math.max(m.getZoom(), 12));
    }
  };
  const bringLatest = useRef(bringIntoView);
  bringLatest.current = bringIntoView;
  useEffect(() => {
    unseenPick.current = null;
    if (!pickedKey) return;
    // After the layout settles: a desktop's panel opens beside the map in the same render.
    const frame = requestAnimationFrame(() => bringLatest.current(pickedKey));
    return () => cancelAnimationFrame(frame);
  }, [pickedKey]);
  // The map shown again with a pick it could not show while hidden.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    let frame = 0;
    const resize = new ResizeObserver(() => {
      const key = unseenPick.current;
      if (!key || el.clientHeight === 0) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => bringLatest.current(key));
    });
    resize.observe(el);
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
    };
  }, []);

  // A set of points asked to be seen together: after a pick's own move, so it has the last word.
  const fitId = fit?.id ?? null;
  const fitList = useRef(fit?.points ?? []);
  fitList.current = fit?.points ?? [];
  useEffect(() => {
    const m = map.current;
    if (!m || !fitId) return;
    const frame = requestAnimationFrame(() => {
      const points = fitList.current;
      if (size().y === 0 || points.length === 0) return;
      m.resize();
      if (points.length === 1) centerOn({ lat: points[0]![0], lon: points[0]![1] }, Math.max(m.getZoom(), 12));
      else fitPoints(points, 14);
    });
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitId]);

  // The first time there is something to show, show all of it.
  useEffect(() => {
    const m = map.current;
    // A map with no size, hidden under a profile, has nothing to fit into.
    if (!m || fitted.current || size().y === 0) return;
    const points: [number, number][] = placed.map((c) => [c.lat, c.lon]);
    if (self) points.push([self.lat, self.lon]);
    if (points.length === 1) centerOn({ lat: points[0]![0], lon: points[0]![1] }, 12, false);
    else if (points.length > 1) fitPoints(points, 13, false);
    if (points.length > 0) fitted.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placed, self]);

  const fitAll = () => {
    own.current = true;
    const points: [number, number][] = shown.map((c) => [c.lat, c.lon]);
    if (self) points.push([self.lat, self.lon]);
    if (points.length === 1) centerOn({ lat: points[0]![0], lon: points[0]![1] }, 13);
    else if (points.length > 1) fitPoints(points, 14);
  };

  const toRadio = () => {
    const m = map.current;
    if (m && self) centerOn(self, Math.max(m.getZoom(), 13));
  };
  // "Where am I" finds the phone, and goes to this radio when the phone cannot say.
  const locate = async () => {
    // During a survey the phone is on the map already: the view goes back to it and to those who answered.
    if (follow && phone) {
      own.current = false;
      fitPoints([[phone.lat, phone.lon], ...follow.points], 15);
      return;
    }
    if (!onLocate) return toRadio();
    if (locating) return;
    setLocating(true);
    const at = await onLocate().catch(() => null);
    setLocating(false);
    const m = map.current;
    if (at && m) centerOn(at, Math.max(m.getZoom(), 14));
    else toRadio();
  };

  // The scale, while a survey runs: a map that holds a far view says how far.
  const at = recording && zoom !== null ? map.current?.getCenter() : undefined;
  const bar = at && zoom !== null ? scaleBar(metresPerPixel(at.lat, zoom), SCALE_PX) : null;

  return (
    <div className="map-view">
      <div ref={box} className="map" />
      <div className="map-attribution" dangerouslySetInnerHTML={{ __html: tileAttribution() }} />
      {top !== null ? <div className="map-top">{top}</div> : null}
      {bar ? (
        <div className="map-scale" style={{ width: bar.px, bottom: coverBottom + 8 }} aria-hidden="true">
          {formatRoundDistance(bar.metres / 1000)}
        </div>
      ) : null}
      <div className="map-controls">
        {turned ? (
          <IconButton label={t("mesh.map.north")} onClick={() => map.current?.easeTo({ bearing: 0 })}>
            <span ref={needle} className="map-needle" style={{ transform: `rotate(${-(map.current?.getBearing() ?? 0)}deg)` }}>
              <CompassIcon size={18} />
            </span>
          </IconButton>
        ) : null}
        {zoomButtons ? (
          <>
            <IconButton
              label={t("mesh.map.zoomIn")}
              onClick={() => {
                own.current = true;
                map.current?.zoomIn();
              }}
            >
              <PlusIcon size={18} />
            </IconButton>
            <IconButton
              label={t("mesh.map.zoomOut")}
              onClick={() => {
                own.current = true;
                map.current?.zoomOut();
              }}
            >
              <MinusIcon size={18} />
            </IconButton>
          </>
        ) : null}
        <IconButton
          label={grouping ? t("mesh.map.ungroup") : t("mesh.map.group")}
          className={grouping ? "on" : ""}
          aria-pressed={grouping}
          onClick={() => {
            const next = !grouping;
            setGrouping(next);
            try {
              localStorage.setItem(GROUPING_KEY, next ? "on" : "off");
            } catch {
              // Kept for this visit only.
            }
          }}
        >
          <GroupIcon size={18} />
        </IconButton>
        {onHears ? <HearsButton on={hearsOn} recording={recording} onTap={onHears} onHoldDone={onHearsHold} /> : null}
        <IconButton label={t("mesh.map.showAll")} onClick={fitAll}>
          <FitIcon size={18} />
        </IconButton>
        {self || onLocate ? (
          <IconButton label={onLocate ? t("mesh.map.whereAmI") : t("mesh.map.thisRadio")} className={[phone ? "on" : "", locating ? "busy" : ""].join(" ")} aria-busy={locating} onClick={() => void locate()}>
            <LocateIcon size={18} />
          </IconButton>
        ) : null}
      </div>
    </div>
  );
}
