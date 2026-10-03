/**
 * A place in a message: what Ommesh sends, and what it reads from others.
 *
 * A place goes as plain text, so any app shows something: `geo:lat,lon`, with
 * the uncertainty RFC 5870 carries in `;u=`, in metres. An exact place has
 * five decimals and the accuracy the phone gave. A rough one is the text
 * itself rounded to the 0.01° grid with `u=1000`: whoever reads it, in any
 * app, and however many times it is sent, learns the cell and no more. A
 * random shift would not hold, since the average of a few sends drifts back
 * onto the real spot.
 *
 * Other MeshCore clients' marks are read too: MeshCore Open's
 * `m:lat,lon|label|poi`, and MeshCore-Solo's `[WAY]lat,lon label` (a point)
 * and `[LOC]lat,lon` (where someone is now).
 */

import { t } from "../i18n/index.js";
import { parseLatLon } from "./geo.js";

export interface Place {
  lat: number;
  lon: number;
  /** Metres either way the real spot may be; null when the text does not say and is exact. */
  u: number | null;
  /** Drawn as a circle with no pin: the sender rounded it, or gave no more than two decimals. */
  rough: boolean;
  /** A name the mark carries itself, as MeshCore Open's does. */
  label: string;
}

export interface FoundPlace {
  start: number;
  end: number;
  place: Place;
}

/** The radius a rough place is sent with. A cell of 0.01° reaches 790 m at its corners at the equator, less further north. */
export const ROUGH_M = 1000;

const NUM = String.raw`-?\d{1,3}(?:\.\d+)?`;
/** A number cut short ("73…", "73.3...") ends no mark: the part left would read as another place. */
const WHOLE = String.raw`(?!\d|\.\d|\.\.|…)`;

/** The marks, with nothing captured, to be put among other patterns. */
export const PLACE_SOURCE = String.raw`geo:${NUM},${NUM}${WHOLE}(?:;[A-Za-z-]+=[^;\s]*)*|\bm:${NUM},${NUM}\|[^|\n]*\|[A-Za-z]+|\[(?:WAY|LOC)\]${NUM},${NUM}${WHOLE}`;

const PARTS = new RegExp(
  [
    String.raw`^geo:(${NUM}),(${NUM})((?:;[A-Za-z-]+=[^;\s]*)*)$`,
    String.raw`^m:(${NUM}),(${NUM})\|([^|\n]*)\|[A-Za-z]+$`,
    String.raw`^\[(?:WAY|LOC)\](${NUM}),(${NUM})$`,
  ].join("|"),
  "i",
);

function decimals(number: string): number {
  const dot = number.indexOf(".");
  return dot < 0 ? 0 : number.length - dot - 1;
}

/** The place one mark stands for; null when it lies off the globe. */
export function placeOfMark(mark: string): Place | null {
  const m = PARTS.exec(mark);
  if (!m) return null;
  const [latText, lonText] = m[1] !== undefined ? [m[1], m[2]!] : m[4] !== undefined ? [m[4], m[5]!] : [m[7]!, m[8]!];
  const lat = Number(latText);
  const lon = Number(lonText);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  let u: number | null = null;
  for (const param of (m[3] ?? "").split(";")) {
    const [key, value] = param.split("=");
    if (key?.toLowerCase() === "u" && value !== undefined && Number(value) >= 0) u = Number(value);
  }
  // A place written with two decimals or fewer says no more than the grid does, whoever wrote it.
  const fewest = Math.min(decimals(latText), decimals(lonText));
  const cell = fewest <= 0 ? 100_000 : fewest === 1 ? 10_000 : fewest === 2 ? ROUGH_M : null;
  if (u === null && cell !== null) u = cell;
  return { lat, lon, u, rough: u !== null && u >= 500, label: m[6]?.trim() ?? "" };
}

/** Every place marked in a text, in order. */
export function findPlaces(text: string): FoundPlace[] {
  const out: FoundPlace[] = [];
  for (const m of text.matchAll(new RegExp(PLACE_SOURCE, "gi"))) {
    const place = placeOfMark(m[0]);
    if (place) out.push({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length, place });
  }
  return out;
}

/**
 * A message that is a place: one mark, and the rest of its text as the
 * caption under the map. Null for a message with no place or several, whose
 * places stay in the text. Marks before `from`, in the line a reply quotes,
 * are the answered message's, not this one's.
 */
export function placeMessage(text: string, from = 0): { place: Place; caption: string } | null {
  const found = findPlaces(text).filter((f) => f.start >= from);
  if (found.length !== 1) return null;
  const { start, end, place } = found[0]!;
  const before = text.slice(0, start).trimEnd();
  const after = text.slice(end).trimStart();
  const caption = before && after ? `${before} ${after}` : before || after;
  return { place, caption };
}

/** A text with its places put in words, for a line with no room for a map: a chat's last message, a notice. */
export function textWithPlaces(text: string): string {
  const found = findPlaces(text);
  if (found.length === 0) return text;
  // A place message says its words after the pin; one with no words is a place.
  const whole = placeMessage(text);
  if (whole) return `📍 ${[whole.place.label, whole.caption].filter(Boolean).join(" · ") || t("chats.place.preview")}`;
  let out = "";
  let at = 0;
  for (const f of found) {
    out += `${text.slice(at, f.start)}📍 ${f.place.label || t("chats.place.preview")}`;
    at = f.end;
  }
  return (out + text.slice(at)).replace(/ {2,}/g, " ").trim();
}

/** A place sent rough: the grid's node nearest to the spot. */
export function roughPoint(lat: number, lon: number): { lat: number; lon: number } {
  return { lat: Number(lat.toFixed(2)), lon: Number(lon.toFixed(2)) };
}

/** The text that carries a place: exact with the accuracy known, or rounded to the grid. */
export function placeText(lat: number, lon: number, rough: boolean, accuracy: number | null = null): string {
  if (rough) return `geo:${lat.toFixed(2)},${lon.toFixed(2)};u=${ROUGH_M}`;
  const u = accuracy !== null && accuracy > 0 ? `;u=${Math.max(1, Math.round(accuracy))}` : "";
  return `geo:${lat.toFixed(5)},${lon.toFixed(5)}${u}`;
}

const onGlobe = (lat: number, lon: number) => (Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : null);
const N = String.raw`(-?\d+(?:\.\d+)?)`;

/**
 * A spot pasted or typed to point at a place: coordinates as a map copies them
 * or a phone with a comma for a decimal point types them, a mark of any client,
 * or a link from Yandex, Google, Apple or OpenStreetMap. A short "share" link
 * says nothing until the network opens it, so it is not read.
 */
export function pointFromText(text: string): { lat: number; lon: number } | null {
  const t = text.trim();
  if (!t) return null;
  const mark = findPlaces(t)[0];
  if (mark) return { lat: mark.place.lat, lon: mark.place.lon };
  let m: RegExpExecArray | null;
  // Yandex puts the longitude first, in ll and in pt.
  if (/yandex\./i.test(t) && (m = new RegExp(String.raw`[?&](?:ll|pt)=${N}(?:,|%2C)${N}`, "i").exec(t))) return onGlobe(Number(m[2]), Number(m[1]));
  if ((m = new RegExp(String.raw`#map=\d+(?:\.\d+)?/${N}/${N}`).exec(t))) return onGlobe(Number(m[1]), Number(m[2]));
  if ((m = new RegExp(String.raw`[?&]mlat=${N}&mlon=${N}`).exec(t))) return onGlobe(Number(m[1]), Number(m[2]));
  if ((m = new RegExp(String.raw`@${N},${N}`).exec(t))) return onGlobe(Number(m[1]), Number(m[2]));
  if ((m = new RegExp(String.raw`[?&](?:q|query|ll|daddr|destination)=${N}(?:,|%2C)\s*(?:\+|%20)?${N}`, "i").exec(t))) return onGlobe(Number(m[1]), Number(m[2]));
  const plain = parseLatLon(t);
  if (plain) return plain;
  // "55,7558 37,6173": the comma is a decimal point when a space or a second comma parts the halves.
  if ((m = /^(-?\d+,\d+)\s*[;,]?\s+(-?\d+,\d+)$|^(-?\d+,\d+),\s*(-?\d+,\d+)$/.exec(t))) {
    const [a, b] = m[1] !== undefined ? [m[1], m[2]!] : [m[3]!, m[4]!];
    return onGlobe(Number(a.replace(",", ".")), Number(b.replace(",", ".")));
  }
  return null;
}

/** OSM's raster tiles are 256 px: metres a pixel covers at a latitude and a tile zoom. */
export function tileMetresPerPixel(lat: number, zoom: number): number {
  return (156_543.033_92 * Math.cos((lat * Math.PI) / 180)) / 2 ** zoom;
}

/** The tile zoom at which `metres` take about `px` pixels, so a place's circle or street fits its picture. */
export function zoomToFit(lat: number, metres: number, px: number): number {
  const z = Math.floor(Math.log2((156_543.033_92 * Math.cos((lat * Math.PI) / 180) * px) / Math.max(1, metres)));
  return Math.max(2, Math.min(17, z));
}
