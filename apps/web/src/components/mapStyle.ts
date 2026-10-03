/**
 * What every map in the app is drawn from: OSM's raster tiles, served through
 * lib/tiles.ts so the ones seen are kept for use with no network, and turned
 * over on the GPU for a dark theme. Shared by the Mesh map and a place's map;
 * both load lazily, and this comes with whichever loads first.
 */

import { addProtocol, type StyleSpecification } from "maplibre-gl";
import { TILE_URL, tileBlob } from "../lib/tiles.js";

export function darkTheme(): boolean {
  return document.documentElement.dataset["appearance"] === "dark";
}

/** Tiles through lib/tiles.ts, which keeps them for use with no network; registered once for every map. */
let tilesServed = false;
export function serveTiles(): void {
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
export function tilePaint(dark: boolean) {
  return dark
    ? { "raster-hue-rotate": 180, "raster-saturation": -0.45, "raster-contrast": -0.12, "raster-brightness-min": 0.92, "raster-brightness-max": 0 }
    : { "raster-hue-rotate": 0, "raster-saturation": 0, "raster-contrast": 0, "raster-brightness-min": 0, "raster-brightness-max": 1 };
}

export function mapStyle(dark: boolean): StyleSpecification {
  return {
    version: 8,
    sources: { osm: { type: "raster", tiles: ["osm-cache://{z}/{x}/{y}"], tileSize: 256, maxzoom: 19 } },
    layers: [{ id: "osm", type: "raster", source: "osm", paint: tilePaint(dark) }],
  };
}
