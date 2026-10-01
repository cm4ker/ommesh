/**
 * A notification's circle as a PNG, for the systems that draw notices
 * themselves (gh #25): the same swatch `Avatar` draws in the page, a hue
 * hashed from the name with the emoji it ends with or its initials, or the
 * glyph of a repeater, a room or a sensor, or "#" for a channel anyone can
 * read and a lock for a private one.
 *
 * Every shell but a browser crops the picture itself (Windows' circle crop,
 * Android's and iOS's person icons), so it is drawn square and full; a
 * browser shows it as given, so there it is drawn round on a clear ground.
 *
 * The page's theme may set other lightness and chroma for its swatches; a
 * system notice is not in the page's theme, so it takes the default ones.
 */

import { AdvType } from "@meshnet/meshcore";
import type { Face } from "./announce.js";
import { hue, initials, trailingEmoji } from "./format.js";
import { LOCK_GLYPH, REPEATER_GLYPH, ROOM_GLYPH, SENSOR_GLYPH } from "./glyphs.js";

/** Pixels on a side: twice what a notice shows at the most, for a sharp picture on a dense screen. */
const SIZE = 192;

/** `--avatar-l` and `--avatar-c` of the default themes (styles.css). */
const SWATCH = { l: 0.62, c: 0.11 };
const INK = { l: 0.2, c: 0.03 };

const GLYPHS: Partial<Record<number, string>> = {
  [AdvType.Repeater]: REPEATER_GLYPH,
  [AdvType.Room]: ROOM_GLYPH,
  [AdvType.Sensor]: SENSOR_GLYPH,
};

/** An OKLCH colour as sRGB, for a canvas that may not know `oklch()` (iOS before 15.4). */
export function oklchToRgb(l: number, c: number, h: number): string {
  const a = c * Math.cos((h * Math.PI) / 180);
  const b = c * Math.sin((h * Math.PI) / 180);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const linear = [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ];
  const channel = (x: number) => {
    const v = x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
    return Math.round(Math.min(1, Math.max(0, v)) * 255);
  };
  return `rgb(${linear.map(channel).join(" ")})`;
}

const cache = new Map<string, Promise<string | null>>();

/**
 * The circle as base64 PNG (no `data:` prefix), or null where the page has
 * no canvas to draw on, such as under the tests.
 */
export function avatarPng(face: Face, round = false): Promise<string | null> {
  const key = `${face.name}\u0000${face.type ?? AdvType.Chat}\u0000${face.channel ?? ""}\u0000${round ? 1 : 0}`;
  let drawn = cache.get(key);
  if (!drawn) {
    drawn = draw(face, round).catch(() => null);
    cache.set(key, drawn);
  }
  return drawn;
}

async function draw(face: Face, round: boolean): Promise<string | null> {
  if (typeof document === "undefined" || typeof document.createElement !== "function") return null;
  const canvas = document.createElement("canvas");
  canvas.width = SIZE;
  canvas.height = SIZE;
  const g = canvas.getContext("2d");
  if (!g) return null;
  const h = hue(face.name);
  const ink = oklchToRgb(INK.l, INK.c, h);

  g.fillStyle = oklchToRgb(SWATCH.l, SWATCH.c, h);
  if (round) {
    g.beginPath();
    g.arc(SIZE / 2, SIZE / 2, SIZE / 2, 0, Math.PI * 2);
    g.fill();
  } else {
    g.fillRect(0, 0, SIZE, SIZE);
  }

  const glyph = face.channel === "private" ? LOCK_GLYPH : face.channel ? null : GLYPHS[face.type ?? AdvType.Chat];
  if (glyph) {
    await drawGlyph(g, glyph, ink);
  } else {
    const emoji = face.channel ? null : trailingEmoji(face.name);
    const text = face.channel ? "#" : (emoji ?? initials(face.name));
    const px = Math.round(SIZE * (emoji ? 0.55 : 0.38));
    g.font = emoji
      ? `${px}px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif`
      : `600 ${px}px "IBM Plex Sans", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
    g.fillStyle = ink;
    g.textAlign = "center";
    g.textBaseline = "alphabetic";
    // Centred by the ink, not the line box, which sits emoji and capitals low.
    const m = g.measureText(text);
    const ascent = m.actualBoundingBoxAscent || px * 0.72;
    const descent = m.actualBoundingBoxDescent || 0;
    g.fillText(text, SIZE / 2, SIZE / 2 + (ascent - descent) / 2);
  }
  return canvas.toDataURL("image/png").replace(/^data:image\/png;base64,/, "");
}

/** A node kind's glyph, stroked in the ink colour at 55% of the circle, as `Avatar` sizes it. */
function drawGlyph(g: CanvasRenderingContext2D, markup: string, ink: string): Promise<void> {
  // `color` as well as `stroke`: a glyph's filled parts take `currentColor`, which an SVG drawn as an image would leave black.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" color="${ink}" fill="none" stroke="${ink}" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${markup}</svg>`;
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const side = SIZE * 0.55;
      g.drawImage(image, (SIZE - side) / 2, (SIZE - side) / 2, side, side);
      resolve();
    };
    image.onerror = () => reject(new Error("could not draw the glyph"));
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  });
}
