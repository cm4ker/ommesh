/**
 * The nodes on a map: every contact whose last advert carried a position, and
 * this radio. Tiles are OpenStreetMap's, kept on the device as they are seen
 * (lib/tiles.ts). The nodes are painted on one canvas (lib/nodeCanvas.ts),
 * which keeps a pan and a pinch smooth with hundreds of them. Nodes that
 * would overlap at the current zoom are gathered into one circle with their
 * count unless grouping is turned off; tapping it zooms in on them, or hands
 * them up as a group when they share a spot. The picked node,
 * and the lines over the nodes (lib/mapOverlay.ts: a route coloured by a
 * ping, a line of sight), are the caller's: the map draws them and reports
 * taps, on a node, on a line, and a long press anywhere, and a point of a
 * route dragged onto a node. The phone, once asked where it is, is a ring
 * with a button under it that puts this radio there. Nothing here asks the
 * air for anything.
 */

import * as L from "leaflet";
import "leaflet/dist/leaflet.css";
import { useEffect, useMemo, useRef, useState } from "react";
import { AdvType, type ContactRecord } from "@meshnet/meshcore";
import { t } from "../i18n/index.js";
import { darkenPixels } from "../lib/darkTile.js";
import { hasPosition } from "../lib/geo.js";
import { EMPTY_OVERLAY, type MapDot, type MapHandle, type MapOverlay } from "../lib/mapOverlay.js";
import type { LosEnd } from "../lib/meshTool.js";
import { NodeCanvas } from "../lib/nodeCanvas.js";
import type { Fix } from "../lib/phonePosition.js";
import type { MenuAt } from "../lib/press.js";
import { useSession } from "../lib/session.js";
import { TILE_URL, tileAttribution, tileBlob } from "../lib/tiles.js";
import { IconButton } from "../ui/Button.js";
import { FitIcon, GroupIcon, LocateIcon, MinusIcon, PlusIcon, WavesIcon } from "./Icons.js";

function darkTheme(): boolean {
  return document.documentElement.dataset["appearance"] === "dark";
}

function decode(blob: Blob): Promise<CanvasImageSource & { close?: () => void }> {
  if (typeof createImageBitmap === "function") return createImageBitmap(blob);
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("tile did not decode"));
    };
    img.src = url;
  });
}

/**
 * Serves each tile from the device's copy when it has one (lib/tiles.ts), and
 * draws it on a canvas, recoloured once for a dark theme (lib/darkTile.ts)
 * rather than filtered live on every frame of a zoom.
 */
class CachedTileLayer extends L.TileLayer {
  protected override createTile(coords: L.Coords, done: L.DoneCallback): HTMLElement {
    const canvas = document.createElement("canvas");
    canvas.setAttribute("role", "presentation");
    const size = this.getTileSize();
    canvas.width = size.x;
    canvas.height = size.y;
    tileBlob(this.getTileUrl(coords))
      .then(decode)
      .then((image) => {
        const dark = darkTheme();
        const context = canvas.getContext("2d", { willReadFrequently: dark });
        if (!context) throw new Error("no canvas");
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        image.close?.();
        if (dark) {
          const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
          darkenPixels(pixels.data);
          context.putImageData(pixels, 0, 0);
        }
        done(undefined, canvas);
      })
      .catch((error: Error) => done(error, canvas));
    return canvas;
  }
}


/** A group spread less than this, in metres, is the same spot at any zoom, and is listed rather than zoomed into. */
const SAME_SPOT_M = 25;

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function selfIcon(name: string): L.DivIcon {
  return L.divIcon({
    className: "map-self",
    html: `<span class="map-self-pulse"></span><span class="map-self-dot"></span><span class="map-name">${escapeHtml(name)}</span>`,
    iconSize: [22, 22],
    iconAnchor: [11, 11],
  });
}

/** The phone: a hollow ring, apart from this radio's filled dot; unnamed under the radio's own name when the two are together. */
function phoneIcon(named: boolean): L.DivIcon {
  const name = named ? `<span class="map-name">${escapeHtml(t("mesh.map.phone"))}</span>` : "";
  return L.divIcon({
    className: "map-phone",
    html: `<span class="map-phone-ring"></span>${name}`,
    iconSize: [16, 16],
    iconAnchor: [8, 8],
  });
}

/** The button under the phone's ring; the marker has no size, and the button hangs from its point. */
function putIcon(distance: string | null): L.DivIcon {
  const pin = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-6-5.5-6-11a6 6 0 0 1 12 0c0 5.5-6 11-6 11z"/><circle cx="12" cy="10" r="2"/></svg>';
  const far = distance ? ` <small>${escapeHtml(distance)}</small>` : "";
  return L.divIcon({ className: "map-put", html: `<span>${pin}${escapeHtml(t("mesh.map.putHere"))}${far}</span>`, iconSize: [0, 0], iconAnchor: [0, 0] });
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
  /** "Who hears me" asked from its button over the map, and whether its answers are on the map now. */
  onHears?: (() => void) | undefined;
  hearsOn?: boolean | undefined;
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
   * Keeps the phone in view as it moves, with these points: a survey's last
   * point and the repeaters that answered there. The map zooms out as far as
   * they need, and steps aside for a while when a finger moves it.
   */
  follow?: [number, number][] | null | undefined;
  /** A survey running: a red dot on the "who hears me" button. */
  recording?: boolean | undefined;
}

/** How near a survey's point, in pixels, a tap opens it. */
const DOT_PX = 18;
/** After a finger moves the map, how long following the phone waits before it takes over again. */
const FOLLOW_PAUSE_MS = 20_000;

/** How near a node, in pixels, a dragged point lets go onto it. */
const SNAP_PX = 36;

const GROUPING_KEY = "meshnet.map.grouping";

/** Whether nodes close together are gathered into one circle; on unless turned off. */
function groupingWanted(): boolean {
  try {
    return localStorage.getItem(GROUPING_KEY) !== "off";
  } catch {
    return true;
  }
}

/** Where the map was left, so coming back to it, from a profile or another section, finds it there. */
let lastView: { center: L.LatLng; zoom: number } | null = null;

export default function MapView({ selected, onSelect, onGroup, filter, coverBottom = 0, coverTop = 0, zoomButtons = false, overlay = EMPTY_OVERLAY, onLeg, onHold, onHandleDrop, onHears, hearsOn = false, fit = null, phone = null, putHere = null, onLocate, dots = null, pickedDot = null, onDot, follow = null, recording = false }: MapProps) {
  const state = useSession();
  const box = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const nodes = useRef<NodeCanvas | null>(null);
  const routeLayer = useRef<L.LayerGroup | null>(null);
  const selfMarker = useRef<L.Marker | null>(null);
  const phoneMarker = useRef<L.Marker | null>(null);
  const phoneHalo = useRef<L.Circle | null>(null);
  const putMarker = useRef<L.Marker | null>(null);
  const fitted = useRef(false);
  const [grouping, setGrouping] = useState(groupingWanted);
  const [locating, setLocating] = useState(false);
  const [zoom, setZoom] = useState<number | null>(null);
  const dotLayer = useRef<L.LayerGroup | null>(null);
  const dotRenderer = useRef<L.Renderer | null>(null);
  // When a finger last moved the map, so following the phone steps aside for a while.
  const draggedAt = useRef(0);
  // The handlers Leaflet holds are set once; they read the latest callbacks from here.
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
  /** A fit keeps clear of the controls, the attribution, and what lies over the map. */
  const padding = (): L.FitBoundsOptions => ({ paddingTopLeft: [40, 56 + cover.current.top], paddingBottomRight: [64, 40 + cover.current.bottom] });
  /** A point in the middle of what is left uncovered, not of the whole map. */
  const centerOn = (at: L.LatLngExpression, zoom: number) => {
    const m = map.current;
    if (!m) return;
    const { top, bottom } = cover.current;
    m.setView(m.unproject(m.project(at, zoom).add([0, (bottom - top) / 2]), zoom), zoom);
  };

  const placed = useMemo(() => Object.values(contacts).filter((c) => hasPosition(c.lat, c.lon)).sort((a, b) => (a.key < b.key ? -1 : 1)), [contacts]);
  const shown = useMemo(() => placed.filter(filter), [placed, filter]);
  const picked = selected ? contacts[selected] ?? null : null;
  const numbers = overlay.numbers;
  // What a dragged point can let go onto, read while it is dragged: every node on the map, and this radio.
  const targets = useRef<{ key: string; at: L.LatLng }[]>([]);
  targets.current = [...placed.map((c) => ({ key: c.key, at: L.latLng(c.lat, c.lon) })), ...(self ? [{ key: "self", at: L.latLng(self.lat, self.lon) }] : [])];

  // The map itself, once.
  useEffect(() => {
    if (!box.current) return;
    // A long press picks a spot; iOS needs Leaflet's own timer for it, Android and a mouse fire it themselves.
    const m = L.map(box.current, { zoomControl: false, attributionControl: false, worldCopyJump: true, minZoom: 2, maxZoom: 19, tapHold: true });
    L.control.attribution({ prefix: false, position: "topleft" }).addTo(m);
    const tiles = new CachedTileLayer(TILE_URL, { maxZoom: 19, attribution: tileAttribution() }).addTo(m);
    routeLayer.current = L.layerGroup().addTo(m);
    // A survey's points: over the lines drawn from one, under the nodes.
    m.createPane("dots").style.zIndex = "420";
    dotRenderer.current = L.svg({ pane: "dots" });
    dotLayer.current = L.layerGroup().addTo(m);
    // Over the lines, under the markers left: this radio, a route's handles, the labels of legs.
    m.createPane("nodes").style.zIndex = "450";
    const nodeCanvas = new NodeCanvas({ pane: "nodes" }).addTo(m);
    nodes.current = nodeCanvas;
    if (lastView) {
      m.setView(lastView.center, lastView.zoom, { animate: false });
      fitted.current = true;
    } else {
      m.setView([20, 0], 2);
    }
    // The finger lifting after a long press is not a tap on the map as well.
    let heldAt = 0;
    m.on("contextmenu", (e: L.LeafletMouseEvent) => {
      if (!calls.current.onHold) return;
      heldAt = Date.now();
      // A map panned round the world gives longitudes past 180; the spot is the same one back on the globe.
      const spot = e.latlng.wrap();
      const box = m.getContainer().getBoundingClientRect();
      calls.current.onHold(spot.lat, spot.lng, { x: box.left + e.containerPoint.x, y: box.top + e.containerPoint.y });
    });
    // The canvas takes no pointer events: a tap lands on the map, and is looked up among the nodes drawn.
    m.on("click", (e: L.LeafletMouseEvent) => {
      if (Date.now() - heldAt < 500) return;
      const mouse = (e.originalEvent as PointerEvent).pointerType === "mouse";
      const members = nodeCanvas.hit(e.layerPoint, mouse ? 3 : 10);
      if (!members) {
        // Missing the nodes, a tap may land on a survey's point: the nearest within reach of a finger.
        const { dots: points, onDot: open } = calls.current;
        if (points && open) {
          let best = -1;
          let reach = mouse ? 8 : DOT_PX;
          points.forEach((d, i) => {
            if (d.tone === "off") return;
            const gap = e.containerPoint.distanceTo(m.latLngToContainerPoint([d.lat, d.lon]));
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
      const bounds = L.latLngBounds(members.map((c) => [c.lat, c.lon] as L.LatLngTuple));
      const spread = bounds.getNorthEast().distanceTo(bounds.getSouthWest());
      if (spread < SAME_SPOT_M || m.getZoom() >= m.getMaxZoom()) calls.current.onGroup(members.map((c) => c.key));
      else m.fitBounds(bounds, { ...padding(), maxZoom: m.getMaxZoom() });
    });
    // A pointer over a node shows it can be clicked; looked up once a frame at most.
    let hoverFrame = 0;
    m.on("mousemove", (e: L.LeafletMouseEvent) => {
      if (hoverFrame) return;
      hoverFrame = requestAnimationFrame(() => {
        hoverFrame = 0;
        m.getContainer().style.cursor = nodeCanvas.hit(e.layerPoint, 3) ? "pointer" : "";
      });
    });
    // Not while hidden under a profile: a map with no size has no middle to remember.
    m.on("moveend", () => {
      if (m.getSize().y > 0) lastView = { center: m.getCenter(), zoom: m.getZoom() };
    });
    m.on("zoomend", () => setZoom(m.getZoom()));
    m.on("dragstart", () => {
      draggedAt.current = Date.now();
    });
    setZoom(m.getZoom());
    map.current = m;
    // The pane is sized by the layout, which changes when a phone turns or a desktop window is resized.
    const resize = new ResizeObserver(() => m.invalidateSize());
    resize.observe(box.current);
    // Tiles and nodes are coloured when drawn, so a change of theme draws them again.
    const theme = new MutationObserver(() => {
      tiles.redraw();
      nodeCanvas.redraw();
    });
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ["data-appearance"] });
    // The names are measured in the app's font, which may arrive after the first paint.
    void document.fonts?.ready.then(() => nodeCanvas.redraw());
    // "4 min" beside a name turns into "5 min".
    const minute = window.setInterval(() => {
      if (m.getSize().y > 0) nodeCanvas.redraw();
    }, 30_000);
    return () => {
      window.clearInterval(minute);
      cancelAnimationFrame(hoverFrame);
      theme.disconnect();
      resize.disconnect();
      m.remove();
      map.current = null;
      nodes.current = null;
      routeLayer.current = null;
      dotLayer.current = null;
      dotRenderer.current = null;
      selfMarker.current = null;
      phoneMarker.current = null;
      phoneHalo.current = null;
      putMarker.current = null;
      fitted.current = false;
    };
  }, []);

  // The nodes: handed to the canvas, which groups them for the zoom and paints them.
  useEffect(() => {
    nodes.current?.setData({ nodes: shown, selected, numbers, grouping, self: self ? L.latLng(self.lat, self.lon) : null });
  }, [shown, selected, numbers, grouping, self]);

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
      selfMarker.current = L.marker([self.lat, self.lon], { icon: selfIcon(selfName), interactive: false, zIndexOffset: 1000 }).addTo(m);
    } else {
      selfMarker.current.setLatLng([self.lat, self.lon]);
      selfMarker.current.setIcon(selfIcon(selfName));
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
    return m.project([phoneLat, phoneLon], zoom).distanceTo(m.project([self.lat, self.lon], zoom)) > 40;
  }, [zoom, phoneLat, phoneLon, self]);
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    if (phoneLat === null || phoneLon === null || phoneAccuracy === null) {
      phoneMarker.current?.remove();
      phoneHalo.current?.remove();
      phoneMarker.current = null;
      phoneHalo.current = null;
      return;
    }
    const at = L.latLng(phoneLat, phoneLon);
    if (!phoneMarker.current) {
      phoneHalo.current = L.circle(at, { radius: phoneAccuracy, className: "map-phone-halo", interactive: false }).addTo(m);
      phoneMarker.current = L.marker(at, { icon: phoneIcon(phoneNamed), interactive: false, keyboard: false, zIndexOffset: 900 }).addTo(m);
    } else {
      phoneMarker.current.setLatLng(at);
      phoneHalo.current?.setLatLng(at).setRadius(phoneAccuracy);
    }
  }, [phoneLat, phoneLon, phoneAccuracy, phoneNamed]);
  useEffect(() => {
    phoneMarker.current?.setIcon(phoneIcon(phoneNamed));
  }, [phoneNamed]);

  // "Put the radio here", hanging under the phone's ring.
  const putDistance = putHere ? putHere.distance : undefined;
  useEffect(() => {
    const m = map.current;
    putMarker.current?.remove();
    putMarker.current = null;
    if (!m || putDistance === undefined || phoneLat === null || phoneLon === null) return;
    const label = t("mesh.map.putHere");
    putMarker.current = L.marker([phoneLat, phoneLon], { icon: putIcon(putDistance), title: label, alt: label, zIndexOffset: 1600 })
      .on("click", (e) => {
        L.DomEvent.stopPropagation(e);
        calls.current.onPut?.();
      })
      .addTo(m);
  }, [putDistance, phoneLat, phoneLon]);

  // A survey's points, drawn again when one is added or picked; a tap on one is looked up by the map's click.
  useEffect(() => {
    const layer = dotLayer.current;
    const renderer = dotRenderer.current;
    if (!layer || !renderer) return;
    layer.clearLayers();
    if (!dots) return;
    dots.forEach((d, i) => {
      const on = i === pickedDot;
      L.circleMarker([d.lat, d.lon], { renderer, pane: "dots", interactive: false, radius: on ? 8 : d.tone === "off" ? 2.5 : 6, className: `map-dot ${d.tone}${on ? " on" : ""}` }).addTo(layer);
    });
  }, [dots, pickedDot]);

  // Following the phone through a survey: it and the points given, fitted to what the sheet leaves, no closer
  // than a street. With nobody placed to show, that is the phone alone.
  const following = useRef(false);
  const followKey = follow ? JSON.stringify(follow) : null;
  useEffect(() => {
    const m = map.current;
    if (!follow) {
      following.current = false;
      return;
    }
    if (!m || phoneLat === null || phoneLon === null) return;
    if (following.current && Date.now() - draggedAt.current < FOLLOW_PAUSE_MS) return;
    const bounds = L.latLngBounds([[phoneLat, phoneLon], ...follow]);
    m.fitBounds(bounds, { ...padding(), maxZoom: 16, animate: following.current });
    following.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [followKey, phoneLat, phoneLon]);

  // The lines over the nodes: a route and how it sounded, a line of sight, the answers to "who hears me".
  useEffect(() => {
    const layer = routeLayer.current;
    if (!layer) return;
    layer.clearLayers();
    for (const line of overlay.lines) {
      const points: L.LatLngTuple[] = [
        [line.from.lat, line.from.lon],
        [line.to.lat, line.to.lon],
      ];
      const mark = line.mark ? ` ${line.mark}` : "";
      // Thin lines drawn beside a route go without its halo.
      if (line.tone !== "back" && line.tone !== "was") L.polyline(points, { className: `map-leg-under${mark}`, interactive: false }).addTo(layer);
      L.polyline(points, { className: `map-leg ${line.tone}${mark}`, interactive: false }).addTo(layer);
      if (line.tappable) {
        // A wide line nobody sees, so a finger finds a thin one.
        L.polyline(points, { weight: 24, opacity: 0, bubblingMouseEvents: false })
          .on("click", () => calls.current.onLeg?.(line.from, line.to))
          .addTo(layer);
      }
      if (line.label) {
        const middle = L.latLng((line.from.lat + line.to.lat) / 2, (line.from.lon + line.to.lon) / 2);
        // Above the leg's middle, clear of the point that drags it.
        L.marker(middle, { interactive: false, keyboard: false, icon: L.divIcon({ className: "map-leg-label", html: escapeHtml(line.label), iconSize: [64, 18], iconAnchor: [32, 30] }) }).addTo(layer);
      }
    }
    for (const pin of overlay.pins) {
      L.marker([pin.lat, pin.lon], { interactive: false, keyboard: false, icon: L.divIcon({ className: "map-spot", html: "<span></span>", iconSize: [20, 20], iconAnchor: [10, 20] }) }).addTo(layer);
    }
    for (const handle of overlay.handles) dragHandle(layer, handle, handle.key ? overlay.numbers[handle.key] : undefined);
    if (overlay.pulse) {
      // A flood going out: rings spreading from this radio, under the nodes.
      L.marker([overlay.pulse.lat, overlay.pulse.lon], { pane: "overlayPane", interactive: false, keyboard: false, icon: L.divIcon({ className: "map-flood", html: "<i></i><i></i><i></i>", iconSize: [260, 260], iconAnchor: [130, 130] }) }).addTo(layer);
    }
  }, [overlay]);

  /** The node nearest to a point, within reach of a finger letting go. */
  const snapAt = (at: L.LatLng): { key: string; at: L.LatLng } | null => {
    const m = map.current;
    if (!m) return null;
    const p = m.latLngToContainerPoint(at);
    let best: { key: string; at: L.LatLng } | null = null;
    let reach = SNAP_PX;
    for (const t of targets.current) {
      const d = p.distanceTo(m.latLngToContainerPoint(t.at));
      if (d < reach) {
        best = t;
        reach = d;
      }
    }
    // Nodes gathered into a circle are let go onto through it: a repeater among them, the nearest first.
    for (const entry of nodes.current?.groups() ?? []) {
      if (entry.members.length < 2) continue;
      const at = entry.at;
      const d = p.distanceTo(m.latLngToContainerPoint(at));
      if (d >= reach) continue;
      const near = (c: ContactRecord) => p.distanceTo(m.latLngToContainerPoint([c.lat, c.lon]));
      const member = [...entry.members].sort((a, b) => Number(b.type === AdvType.Repeater) - Number(a.type === AdvType.Repeater) || near(a) - near(b))[0]!;
      best = { key: member.key, at };
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
  function dragHandle(layer: L.LayerGroup, handle: MapHandle, number: number | undefined): void {
    const size = handle.kind === "hop" ? 34 : 26;
    // A relay's place in a route being changed rides on its ring, which covers the marker's own.
    const badge = number ? `<b class="map-num">${number}</b>` : "";
    const home = L.latLng(handle.lat, handle.lon);
    const marker = L.marker(home, {
      draggable: true,
      autoPan: true,
      keyboard: false,
      zIndexOffset: handle.kind === "hop" ? 1500 : 1400,
      icon: L.divIcon({ className: `map-handle map-handle-${handle.kind}`, html: `<span></span>${badge}`, iconSize: [size, size], iconAnchor: [size / 2, size / 2] }),
    });
    let rubber: L.Polyline | null = null;
    let ring: L.Marker | null = null;
    const stretch = (tip: L.LatLng) => {
      const points: L.LatLng[] = [];
      if (handle.from) points.push(L.latLng(handle.from.lat, handle.from.lon));
      points.push(tip);
      if (handle.to) points.push(L.latLng(handle.to.lat, handle.to.lon));
      rubber?.setLatLngs(points);
    };
    marker.on("dragstart", () => {
      marker.getElement()?.classList.add("dragging");
      rubber = L.polyline([], { className: "map-leg rubber", interactive: false }).addTo(layer);
      ring = L.marker(home, { interactive: false, keyboard: false, opacity: 0, icon: L.divIcon({ className: "map-snap", html: "<span></span>", iconSize: [40, 40], iconAnchor: [20, 20] }) }).addTo(layer);
      stretch(home);
    });
    marker.on("drag", () => {
      const snap = snapAt(marker.getLatLng());
      stretch(snap?.at ?? marker.getLatLng());
      if (snap) ring?.setLatLng(snap.at);
      ring?.setOpacity(snap ? 1 : 0);
    });
    marker.on("dragend", () => {
      const snap = snapAt(marker.getLatLng());
      rubber?.remove();
      ring?.remove();
      marker.getElement()?.classList.remove("dragging");
      marker.setLatLng(home);
      if (snap) calls.current.onHandleDrop?.(handle, snap.key);
    });
    marker.on("click", (e) => {
      L.DomEvent.stopPropagation(e);
      if (handle.kind === "hop" && handle.key) calls.current.onSelect(handle.key);
      else if (handle.kind === "gap" && handle.from && handle.to) calls.current.onLeg?.(handle.from, handle.to);
    });
    marker.addTo(layer);
  }

  // A node picked from outside the map, from its profile or the list, is brought into view. On a phone the
  // pick opens its profile over the map, which then has no size; it is brought into view when the map shows again.
  const pickedKey = picked && hasPosition(picked.lat, picked.lon) ? picked.key : null;
  const unseenPick = useRef<string | null>(null);
  const bringIntoView = (key: string) => {
    const m = map.current;
    const c = contacts[key];
    if (!m || !c) return;
    m.invalidateSize();
    const at = L.latLng(c.lat, c.lon);
    const size = m.getSize();
    const { top, bottom } = cover.current;
    const clear = { left: 40, right: size.x - 64, top: top + 56, bottom: size.y - bottom - 40 };
    if (clear.right <= clear.left || clear.bottom <= clear.top) {
      unseenPick.current = key;
      return;
    }
    unseenPick.current = null;
    const p = m.latLngToContainerPoint(at);
    if (p.x > clear.left && p.x < clear.right && p.y > clear.top && p.y < clear.bottom) return;
    // In sight but under the sheet or at an edge: moved just clear. Out of sight: brought to the middle.
    if (p.x >= 0 && p.x <= size.x && p.y >= 0 && p.y <= size.y) {
      const dx = p.x < clear.left ? p.x - clear.left : p.x > clear.right ? p.x - clear.right : 0;
      const dy = p.y < clear.top ? p.y - clear.top : p.y > clear.bottom ? p.y - clear.bottom : 0;
      m.panBy([dx, dy]);
    } else {
      centerOn(at, Math.max(m.getZoom(), 13));
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
  const fitPoints = useRef(fit?.points ?? []);
  fitPoints.current = fit?.points ?? [];
  useEffect(() => {
    const m = map.current;
    if (!m || !fitId) return;
    const frame = requestAnimationFrame(() => {
      const points = fitPoints.current;
      if (m.getSize().y === 0 || points.length === 0) return;
      m.invalidateSize();
      if (points.length === 1) centerOn(points[0]!, Math.max(m.getZoom(), 13));
      else m.fitBounds(L.latLngBounds(points), { ...padding(), maxZoom: 15 });
    });
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitId]);

  // The first time there is something to show, show all of it.
  useEffect(() => {
    const m = map.current;
    // A map with no size, hidden under a profile, has nothing to fit into.
    if (!m || fitted.current || m.getSize().y === 0) return;
    const points: L.LatLngTuple[] = placed.map((c) => [c.lat, c.lon]);
    if (self) points.push([self.lat, self.lon]);
    if (points.length === 1) centerOn(points[0]!, 13);
    else if (points.length > 1) m.fitBounds(L.latLngBounds(points), { ...padding(), maxZoom: 14 });
    if (points.length > 0) fitted.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placed, self]);

  const fitAll = () => {
    const points: L.LatLngTuple[] = shown.map((c) => [c.lat, c.lon]);
    if (self) points.push([self.lat, self.lon]);
    if (points.length === 1) centerOn(points[0]!, 14);
    else if (points.length > 1) map.current?.fitBounds(L.latLngBounds(points), { ...padding(), maxZoom: 15 });
  };

  const toRadio = () => {
    const m = map.current;
    if (m && self) centerOn([self.lat, self.lon], Math.max(m.getZoom(), 14));
  };
  // "Where am I" finds the phone, and goes to this radio when the phone cannot say.
  const locate = async () => {
    if (!onLocate) return toRadio();
    if (locating) return;
    setLocating(true);
    const at = await onLocate().catch(() => null);
    setLocating(false);
    const m = map.current;
    if (at && m) centerOn([at.lat, at.lon], Math.max(m.getZoom(), 15));
    else toRadio();
  };

  return (
    <div className="map-view">
      <div ref={box} className="map" />
      <div className="map-controls">
        {zoomButtons ? (
          <>
            <IconButton label={t("mesh.map.zoomIn")} onClick={() => map.current?.zoomIn()}>
              <PlusIcon size={18} />
            </IconButton>
            <IconButton label={t("mesh.map.zoomOut")} onClick={() => map.current?.zoomOut()}>
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
        {onHears ? (
          <IconButton label={recording ? t("tools.survey.title") : t("mesh.whoHearsMe")} className={hearsOn ? "on" : ""} aria-pressed={hearsOn} disabled={state.status !== "ready" && !hearsOn && !recording} onClick={onHears}>
            <WavesIcon size={18} />
            {recording ? <span className="map-rec" aria-hidden="true" /> : null}
          </IconButton>
        ) : null}
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
