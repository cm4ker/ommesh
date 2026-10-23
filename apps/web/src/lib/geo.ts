import { AdvType } from "@meshnet/meshcore";
import { t } from "../i18n/index.js";

/** A node that has not set a position advertises 0, 0; nobody's radio sits there. */
export function hasPosition(lat: number, lon: number): boolean {
  return (lat !== 0 || lon !== 0) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
}

/**
 * Both halves of a position in one line, as a map copies them
 * ("55.75580, 37.61730") or as a geo: link carries them; null when the text
 * is not that, or lies off the globe.
 */
export function parseLatLon(text: string): { lat: number; lon: number } | null {
  const bare = text.trim().replace(/^geo:/i, "").split(/[;?]/)[0]!;
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*(?:,|\s)\s*(-?\d+(?:\.\d+)?)\s*$/.exec(bare);
  if (!m) return null;
  const lat = Number(m[1]);
  const lon = Number(m[2]);
  return Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : null;
}

/**
 * One half of a position with its decimal comma made a point, as a number pad
 * in a comma locale types it: "55,7558" is one half, not two whole degrees.
 * Anything else comes back trimmed and otherwise as it was.
 */
export function pointDecimal(text: string): string {
  return text.trim().replace(/^(-?\d+),(\d+)$/, "$1.$2");
}

/** A spot as a map copies it: five decimals, about a metre. */
export function formatLatLon(lat: number, lon: number): string {
  return `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
}

const EARTH_KM = 6371.0088;
const rad = (deg: number) => (deg * Math.PI) / 180;

/** Great-circle distance, km. */
export function distanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Initial bearing from the first point to the second, degrees clockwise from north. */
export function bearingDeg(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const y = Math.sin(rad(lon2 - lon1)) * Math.cos(rad(lat2));
  const x = Math.cos(rad(lat1)) * Math.sin(rad(lat2)) - Math.sin(rad(lat1)) * Math.cos(rad(lat2)) * Math.cos(rad(lon2 - lon1));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/** The point `km` away from a place along a bearing, degrees clockwise from north. */
export function destination(lat: number, lon: number, km: number, bearing: number): { lat: number; lon: number } {
  const d = km / EARTH_KM;
  const b = rad(bearing);
  const la = rad(lat);
  const to = Math.asin(Math.sin(la) * Math.cos(d) + Math.cos(la) * Math.sin(d) * Math.cos(b));
  const lo = rad(lon) + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(la), Math.cos(d) - Math.sin(la) * Math.sin(to));
  return { lat: (to * 180) / Math.PI, lon: ((((lo * 180) / Math.PI + 540) % 360) - 180) };
}

const POINTS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"] as const;

export function compass(deg: number): string {
  return t(`common.compass.${POINTS[Math.round(deg / 45) % 8]!}`);
}

export function formatDistance(km: number): string {
  if (km < 1) return t("common.meters", { value: Math.round(km * 1000) });
  return t("common.kilometers", { value: km < 100 ? km.toFixed(1) : Math.round(km) });
}

/** A distance picked on a slider, with no figure it was not picked to: 500 m, 2.5 km, 20 km. */
export function formatRoundDistance(km: number): string {
  if (km < 1) return t("common.meters", { value: Math.round(km * 1000) });
  return t("common.kilometers", { value: km < 10 ? Math.round(km * 10) / 10 : Math.round(km) });
}

/** How much ground a pixel of the map covers at a latitude and a zoom, in metres; the map's world is 512 pixels wide at zoom 0. */
export function metresPerPixel(lat: number, zoom: number): number {
  return (2 * Math.PI * EARTH_KM * 1000 * Math.cos(rad(lat))) / (512 * 2 ** zoom);
}

/** The longest round length (1, 2 or 5 times a power of ten) a map's scale of `maxPx` can show, and how long it is drawn. */
export function scaleBar(metresPerPx: number, maxPx: number): { metres: number; px: number } {
  const most = metresPerPx * maxPx;
  const ten = 10 ** Math.floor(Math.log10(most));
  const metres = ten * (most >= 5 * ten ? 5 : most >= 2 * ten ? 2 : 1);
  return { metres, px: Math.round(metres / metresPerPx) };
}

/** Slower than this, in metres a second (about 7 km/h), the phone's fixes wander more than it moves. */
const COURSE_SPEED = 2;
/** A fix that has stayed this near the last one this long starts the next measure afresh. */
const COURSE_STALE_MS = 20_000;

/**
 * The way the phone goes, in degrees clockwise from north, measured from
 * `from`, the fix the last course was taken at, to a new fix once the phone
 * is far enough from it to tell: ten metres at least, and half of how sure
 * the fix is. Standing at a light or creeping along, the course is kept, so a
 * map turned by it does not spin. Hands back where to measure from next.
 */
export function courseStep(from: { lat: number; lon: number; at: number } | null, fix: { lat: number; lon: number; at: number; accuracy: number }, kept: number | null): { from: { lat: number; lon: number; at: number }; course: number | null } {
  if (!from) return { from: fix, course: kept };
  const metres = distanceKm(from.lat, from.lon, fix.lat, fix.lon) * 1000;
  const seconds = (fix.at - from.at) / 1000;
  if (metres < Math.max(10, fix.accuracy / 2)) return { from: fix.at - from.at > COURSE_STALE_MS ? fix : from, course: kept };
  if (seconds <= 0 || metres / seconds < COURSE_SPEED) return { from: fix, course: kept };
  return { from: fix, course: bearingDeg(from.lat, from.lon, fix.lat, fix.lon) };
}

export type Freshness = "fresh" | "aging" | "stale";

/**
 * How lately a node was heard. Repeaters advertise every few hours on their
 * own, so they are held to a longer clock than people and rooms.
 */
export function freshness(type: number, heardAgeSec: number): Freshness {
  const [fresh, day] = type === AdvType.Repeater ? [6 * 3600, 48 * 3600] : [3600, 24 * 3600];
  if (heardAgeSec <= fresh) return "fresh";
  return heardAgeSec <= day ? "aging" : "stale";
}
