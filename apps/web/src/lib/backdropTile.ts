import { useEffect, useReducer, useRef } from "react";

/**
 * The chat pictures are SVGs of a thousand shapes and more. Used as a CSS background,
 * the browser draws every shape again whenever the chat is painted: on a phone that
 * was over 100 ms a frame while the messages scrolled, and a second of drawing when a
 * chat opened. So each picture is drawn once, here, into a bitmap the size it is shown
 * at, and that bitmap is what the chat repeats.
 */

/** The widths a tile is drawn at, in CSS pixels; a shown size takes the next one up. */
const WIDTHS = [200, 400, 520, 640];
/** Above this many device pixels, a tile is drawn a little softer rather than bigger. */
const MOST_PIXELS = 4_000_000;

/** The width a tile of `shown` CSS pixels is drawn at: few enough sizes for the slider to reuse them. */
export function tileWidth(shown: number): number {
  return WIDTHS.find((width) => width >= shown) ?? Math.ceil(shown);
}

/** The bitmap's size in device pixels for a picture of `natural` proportions drawn `width` CSS pixels wide. */
export function tilePixels(width: number, naturalWidth: number, naturalHeight: number, ratio: number): [number, number] {
  let w = width * Math.min(Math.max(ratio, 1), 3);
  let h = (w * naturalHeight) / naturalWidth;
  if (w * h > MOST_PIXELS) {
    const shrink = Math.sqrt(MOST_PIXELS / (w * h));
    w *= shrink;
    h *= shrink;
  }
  return [Math.round(w), Math.round(h)];
}

const drawn = new Map<string, string>();
const drawing = new Map<string, Promise<string>>();

const keyOf = (src: string, width: number) => `${src} ${tileWidth(width)} ${globalThis.devicePixelRatio ?? 1}`;

async function draw(src: string, width: number): Promise<string> {
  const image = new Image();
  image.src = src;
  await image.decode();
  const [w, h] = tilePixels(tileWidth(width), image.naturalWidth || 800, image.naturalHeight || 1200, globalThis.devicePixelRatio ?? 1);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const context = canvas.getContext("2d");
  if (!context) return src;
  context.drawImage(image, 0, 0, w, h);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve));
  // The canvas's memory goes at once, not when it is collected.
  canvas.width = canvas.height = 0;
  return blob ? URL.createObjectURL(blob) : src;
}

/**
 * The bitmap of the picture at `src` for a tile `width` CSS pixels wide, drawn once and
 * kept for as long as the page lives. Where a bitmap cannot be made (a canvas the
 * engine refuses to read), the picture itself.
 */
export function drawTile(src: string, width: number): Promise<string> {
  const key = keyOf(src, width);
  let job = drawing.get(key);
  if (!job) {
    job = draw(src, width)
      .catch(() => src)
      .then((url) => {
        drawn.set(key, url);
        return url;
      });
    drawing.set(key, job);
  }
  return job;
}

/**
 * The tile to show for `src` at `width`, or nothing while its first drawing is under way.
 * While the size slider moves, the last tile of the same picture stays, stretched, until
 * the new one is ready, so the picture never blinks out.
 */
export function useTile(src: string | undefined, width: number): string | undefined {
  const key = src === undefined ? undefined : keyOf(src, width);
  const ready = key === undefined ? undefined : drawn.get(key);
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const last = useRef<{ src: string; url: string }>(undefined);
  useEffect(() => {
    if (src === undefined || ready !== undefined) return;
    let live = true;
    void drawTile(src, width).then(() => live && redraw());
    return () => {
      live = false;
    };
  }, [key, ready]);
  if (src !== undefined && ready !== undefined) last.current = { src, url: ready };
  return ready ?? (last.current?.src === src ? last.current?.url : undefined);
}
