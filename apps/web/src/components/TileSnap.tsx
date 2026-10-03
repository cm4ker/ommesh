/**
 * A still picture of the map round a spot, cut from the OSM tiles the app
 * keeps (lib/tiles.ts). A place in a message is drawn this way rather than as
 * a live map: a chat can hold dozens of them, and a live map is heavy. A tile
 * not kept is fetched as the map would fetch it; when none can be had, which
 * is often so where a mesh is used, `onNone` lets the caller draw something
 * else. A dark theme turns the picture over as the map turns its tiles.
 */

import { useEffect, useRef, type ReactNode } from "react";
import { TILE_URL, tileBlob } from "../lib/tiles.js";

type Bitmap = ImageBitmap | HTMLImageElement;

/** Decoded tiles, the latest few: a chat scrolled back and forth draws the same ones again. */
const decoded = new Map<string, Promise<Bitmap>>();
const KEEP = 64;

function loadImage(blob: Blob): Promise<HTMLImageElement> {
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

function bitmapOf(url: string): Promise<Bitmap> {
  const held = decoded.get(url);
  if (held) {
    decoded.delete(url);
    decoded.set(url, held);
    return held;
  }
  const loading = tileBlob(url).then((blob): Promise<Bitmap> => (typeof createImageBitmap === "function" ? createImageBitmap(blob) : loadImage(blob)));
  loading.catch(() => decoded.delete(url));
  decoded.set(url, loading);
  if (decoded.size > KEEP) decoded.delete(decoded.keys().next().value!);
  return loading;
}

/** Web Mercator, in pixels of a world 256 × 2^zoom wide. */
function worldPixel(lat: number, lon: number, zoom: number): { x: number; y: number } {
  const size = 256 * 2 ** zoom;
  const r = (Math.max(-85.05, Math.min(85.05, lat)) * Math.PI) / 180;
  return { x: ((lon + 180) / 360) * size, y: ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * size };
}

export function TileSnap({ lat, lon, zoom, onNone, children }: { lat: number; lon: number; zoom: number; onNone?: () => void; children?: ReactNode }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const none = useRef(onNone);
  none.current = onNone;

  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    let gone = false;
    const draw = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (w === 0 || h === 0) return;
      const dpr = Math.min(3, window.devicePixelRatio || 1);
      el.width = Math.round(w * dpr);
      el.height = Math.round(h * dpr);
      const ctx = el.getContext("2d");
      if (!ctx) return;
      // A sharp screen gets the next zoom's tiles at half size.
      const tileZoom = Math.min(19, zoom + (dpr >= 1.5 ? 1 : 0));
      const scale = 2 ** (zoom - tileZoom) * dpr;
      const centre = worldPixel(lat, lon, tileZoom);
      const left = centre.x - el.width / 2 / scale;
      const top = centre.y - el.height / 2 / scale;
      const count = 2 ** tileZoom;
      const tiles: Promise<boolean>[] = [];
      for (let ty = Math.floor(top / 256); ty <= Math.floor((top + el.height / scale) / 256); ty++) {
        if (ty < 0 || ty >= count) continue;
        for (let tx = Math.floor(left / 256); tx <= Math.floor((left + el.width / scale) / 256); tx++) {
          const wrapped = ((tx % count) + count) % count;
          const url = TILE_URL.replace("{z}", String(tileZoom)).replace("{x}", String(wrapped)).replace("{y}", String(ty));
          tiles.push(
            bitmapOf(url).then(
              (bitmap) => {
                if (gone) return true;
                const size = 256 * scale;
                ctx.drawImage(bitmap, Math.round((tx * 256 - left) * scale), Math.round((ty * 256 - top) * scale), Math.ceil(size), Math.ceil(size));
                return true;
              },
              () => false,
            ),
          );
        }
      }
      void Promise.all(tiles).then((got) => {
        if (!gone && !got.some(Boolean)) none.current?.();
      });
    };
    // Drawn when first measured, and again when the box changes size.
    const resize = new ResizeObserver(draw);
    resize.observe(el);
    return () => {
      gone = true;
      resize.disconnect();
    };
  }, [lat, lon, zoom]);

  return (
    <div className="snap">
      <canvas ref={canvas} aria-hidden="true" />
      {children}
    </div>
  );
}
