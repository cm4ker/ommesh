/**
 * A live map round one place: the place itself as a pin, or as a circle when
 * it is rough, where you are with a dashed line to it, and, when a point is
 * being put, the nodes of the mesh to put it on. Loaded lazily, like the Mesh
 * map, whose tiles and dark paint it shares (mapStyle.ts).
 */

import { LngLatBounds, Map as MapLibre, Marker, type GeoJSONSource } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useRef } from "react";
import { destination } from "../lib/geo.js";
import type { Place } from "../lib/place.js";
import { tileAttribution } from "../lib/tiles.js";
import { darkTheme, mapStyle, serveTiles, tilePaint } from "./mapStyle.js";

export interface LatLon {
  lat: number;
  lon: number;
}

export interface MapNode {
  key: string;
  name: string;
  lat: number;
  lon: number;
}

export interface PlaceMapProps {
  /** Where the map opens, and at what MapLibre zoom. */
  center: LatLon;
  zoom: number;
  place?: Place | null | undefined;
  me?: LatLon | null | undefined;
  /** A dashed line from you to the place. */
  line?: boolean | undefined;
  /** Nodes a point can be put on; a tap near one puts it there. */
  nodes?: MapNode[] | undefined;
  /** Putting a point: the map's middle is the point, reported as it moves; a tap brings that spot to the middle. */
  onCentre?: ((at: LatLon) => void) | undefined;
  /** Points to bring into view; a new key brings them again. */
  fit?: { key: string; points: LatLon[] } | null | undefined;
  /** A spot to go to; a new key goes again. */
  goTo?: { key: string; at: LatLon } | null | undefined;
}

const EMPTY = { type: "FeatureCollection" as const, features: [] };

/** One of the map's own sources; none before its style has loaded, or after it is gone. */
function sourceOf(m: MapLibre, id: string): GeoJSONSource | undefined {
  try {
    return m.getSource(id) as GeoJSONSource | undefined;
  } catch {
    return undefined;
  }
}

function circle(at: LatLon, metres: number) {
  const ring = Array.from({ length: 65 }, (_, i) => {
    const p = destination(at.lat, at.lon, metres / 1000, (i * 360) / 64);
    return [p.lon, p.lat];
  });
  return { type: "Feature" as const, properties: {}, geometry: { type: "Polygon" as const, coordinates: [ring] } };
}

function element(className: string, html = ""): HTMLDivElement {
  const el = document.createElement("div");
  el.className = className;
  el.innerHTML = html;
  return el;
}

const PIN = '<svg class="place-pin" viewBox="-12 -31 24 31" aria-hidden="true"><path d="M0 0c-8-10-12-15-12-21a12 12 0 1 1 24 0c0 6-4 11-12 21z"/><circle cy="-21" r="4.2"/></svg>';

export default function PlaceMap({ center, zoom, place, me, line, nodes, onCentre, fit, goTo }: PlaceMapProps) {
  const box = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibre | null>(null);
  const ready = useRef<Promise<void> | null>(null);
  const calls = useRef({ onCentre, nodes });
  calls.current = { onCentre, nodes };

  // The map itself, once.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    serveTiles();
    const m = new MapLibre({
      container: el,
      style: mapStyle(darkTheme()),
      center: [center.lon, center.lat],
      zoom,
      minZoom: 1,
      maxZoom: 18,
      maxPitch: 0,
      pitchWithRotate: false,
      touchPitch: false,
      dragRotate: false,
      attributionControl: false,
    });
    m.touchZoomRotate.disableRotation();
    map.current = m;
    ready.current = new Promise((resolve) => {
      m.once("load", () => {
        m.addSource("area", { type: "geojson", data: EMPTY });
        m.addSource("line", { type: "geojson", data: EMPTY });
        const accent = getComputedStyle(el).getPropertyValue("--accent").trim() || "#5c78e2";
        const muted = getComputedStyle(el).getPropertyValue("--text-muted").trim() || "#5c5e63";
        m.addLayer({ id: "area-fill", type: "fill", source: "area", paint: { "fill-color": accent, "fill-opacity": 0.14 } });
        m.addLayer({ id: "area-edge", type: "line", source: "area", paint: { "line-color": accent, "line-width": 1.6, "line-dasharray": [3, 2] } });
        m.addLayer({ id: "line", type: "line", source: "line", paint: { "line-color": muted, "line-width": 1.8, "line-dasharray": [2.5, 2] } });
        resolve();
      });
    });
    const report = () => {
      const c = m.getCenter().wrap();
      calls.current.onCentre?.({ lat: c.lat, lon: c.lng });
    };
    m.on("move", report);
    // Putting a point, a tap brings the spot to the middle, or a node near it.
    m.on("click", (e) => {
      if (!calls.current.onCentre) return;
      let to = { lat: e.lngLat.lat, lon: e.lngLat.lng };
      let best = e.originalEvent && (e.originalEvent as PointerEvent).pointerType === "mouse" ? 10 : 22;
      for (const n of calls.current.nodes ?? []) {
        const p = m.project([n.lon, n.lat]);
        const gap = Math.hypot(p.x - e.point.x, p.y - e.point.y);
        if (gap < best) {
          best = gap;
          to = { lat: n.lat, lon: n.lon };
        }
      }
      m.easeTo({ center: [to.lon, to.lat], duration: 250 });
    });
    const resize = new ResizeObserver(() => m.resize());
    resize.observe(el);
    const theme = new MutationObserver(() => {
      const paint = tilePaint(darkTheme());
      if (m.getLayer("osm")) for (const [key, value] of Object.entries(paint)) m.setPaintProperty("osm", key, value);
    });
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ["data-appearance"] });
    return () => {
      theme.disconnect();
      resize.disconnect();
      m.remove();
      map.current = null;
    };
    // The map is made once; what it shows follows below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The place: a pin, or a circle drawn in metres so it holds at any zoom.
  const placeKey = place ? `${place.lat},${place.lon},${place.rough},${place.u}` : "";
  useEffect(() => {
    const m = map.current;
    if (!m || !place) return;
    let marker: Marker | null = null;
    let gone = false;
    if (place.rough) {
      void ready.current?.then(() => {
        if (!gone) sourceOf(m, "area")?.setData(circle(place, place.u ?? 1000));
      });
    } else {
      marker = new Marker({ element: element("place-marker", PIN), anchor: "bottom" }).setLngLat([place.lon, place.lat]).addTo(m);
    }
    return () => {
      gone = true;
      marker?.remove();
      if (place.rough) sourceOf(m, "area")?.setData(EMPTY);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placeKey]);

  // You, and the line from you to the place.
  const meKey = me ? `${me.lat},${me.lon}` : "";
  useEffect(() => {
    const m = map.current;
    if (!m || !me) return;
    const marker = new Marker({ element: element("place-me", '<span class="map-phone-ring"></span>') }).setLngLat([me.lon, me.lat]).addTo(m);
    let gone = false;
    if (line && place) {
      void ready.current?.then(() => {
        if (!gone)
          sourceOf(m, "line")?.setData({
            type: "Feature",
            properties: {},
            geometry: { type: "LineString", coordinates: [[me.lon, me.lat], [place.lon, place.lat]] },
          });
      });
    }
    return () => {
      gone = true;
      marker.remove();
      sourceOf(m, "line")?.setData(EMPTY);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meKey, placeKey, line]);

  // The nodes a point can be put on, with their names.
  const nodesKey = (nodes ?? []).map((n) => n.key).join(",");
  useEffect(() => {
    const m = map.current;
    if (!m || !nodes?.length) return;
    const markers = nodes.map((n) => {
      const el = element("place-node", `<span class="place-node-dot"></span><span class="map-name"></span>`);
      el.querySelector(".map-name")!.textContent = n.name;
      return new Marker({ element: el }).setLngLat([n.lon, n.lat]).addTo(m);
    });
    return () => {
      for (const marker of markers) marker.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodesKey]);

  useEffect(() => {
    const m = map.current;
    if (!m || !fit || fit.points.length === 0) return;
    const bounds = new LngLatBounds();
    for (const p of fit.points) bounds.extend([p.lon, p.lat]);
    m.fitBounds(bounds, { padding: 56, maxZoom: 16, duration: 400 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fit?.key]);

  useEffect(() => {
    const m = map.current;
    if (!m || !goTo) return;
    m.jumpTo({ center: [goTo.at.lon, goTo.at.lat] });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [goTo?.key]);

  return (
    <div className="map-view place-map">
      <div className="map" ref={box} />
      <div className="map-attribution" dangerouslySetInnerHTML={{ __html: tileAttribution() }} />
    </div>
  );
}
