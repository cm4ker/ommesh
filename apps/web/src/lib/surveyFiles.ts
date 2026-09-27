/**
 * A survey written out as a file: JSON that MeshCore Wardrive opens (its
 * `meshcore_wardrive_data` format, version 2), GPX for navigators, KML for
 * Google Earth, CSV for a spreadsheet. Wardrive keeps one repeater per point,
 * the one the radio heard best; everything else we know rides along in a
 * field of its own, which Wardrive passes over.
 */

import { pointTone, type PointTone, type Survey, type SurveyPoint, type SurveyReply } from "./surveyData.js";

export type SurveyFormat = "json" | "gpx" | "kml" | "csv";

export const FORMAT_TYPE: Record<SurveyFormat, string> = {
  json: "application/json",
  gpx: "application/gpx+xml",
  kml: "application/vnd.google-earth.kml+xml",
  csv: "text/csv",
};

/** The name a survey's file goes by: when it started, in the reader's own time. */
export function surveyFileName(survey: Survey, format: SurveyFormat): string {
  const d = new Date(survey.startedAt);
  const two = (n: number) => String(n).padStart(2, "0");
  return `ommesh-survey-${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}.${format}`;
}

const BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz";

/** The geohash of a spot, as Wardrive keeps one on every point. */
export function geohash(lat: number, lon: number, precision = 8): string {
  let latLo = -90;
  let latHi = 90;
  let lonLo = -180;
  let lonHi = 180;
  let hash = "";
  let bits = 0;
  let value = 0;
  let even = true;
  while (hash.length < precision) {
    if (even) {
      const mid = (lonLo + lonHi) / 2;
      value = (value << 1) | (lon >= mid ? 1 : 0);
      if (lon >= mid) lonLo = mid;
      else lonHi = mid;
    } else {
      const mid = (latLo + latHi) / 2;
      value = (value << 1) | (lat >= mid ? 1 : 0);
      if (lat >= mid) latLo = mid;
      else latHi = mid;
    }
    even = !even;
    if (++bits === 5) {
      hash += BASE32[value];
      bits = 0;
      value = 0;
    }
  }
  return hash;
}

/** The repeater the radio heard best at a point: the one Wardrive would have kept. */
function heardBest(point: SurveyPoint): SurveyReply | null {
  let best: SurveyReply | null = null;
  for (const reply of point.replies) if (!best || reply.them > best.them) best = reply;
  return best;
}

const shortId = (key: string) => key.slice(0, 8).toUpperCase();
const iso = (ms: number) => new Date(ms).toISOString();

function distanceMeters(survey: Survey): number {
  let m = 0;
  const p = survey.points;
  for (let i = 1; i < p.length; i++) {
    const a = p[i - 1]!;
    const b = p[i]!;
    const rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad;
    const dLon = (b.lon - a.lon) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
    m += 2 * 6_371_000 * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  return Math.round(m);
}

export function surveyJson(survey: Survey, name: (key: string) => string): string {
  const deviceId = shortId(survey.radio);
  const samples = survey.points.map((point, i) => {
    const best = heardBest(point);
    return {
      id: `${point.at}_${deviceId}_${i}`,
      lat: point.lat,
      lon: point.lon,
      timestamp: iso(point.at),
      path: best ? shortId(best.key) : null,
      geohash: geohash(point.lat, point.lon, 8),
      rssi: best ? Math.round(best.rssi) : null,
      snr: best ? Math.round(best.them) : null,
      pingSuccess: point.replies.length > 0,
      responseTimeMs: null,
      ductingRisk: null,
      source: "Ommesh",
      deviceId,
      ommesh: {
        accuracy: Math.round(point.accuracy),
        replies: point.replies.map((r) => ({ id: shortId(r.key), key: r.key, name: name(r.key), heardUs: r.us, heardThem: r.them, rssi: r.rssi })),
      },
    };
  });
  const answered = survey.points.filter((p) => p.replies.length > 0).length;
  const session = {
    startTime: iso(survey.startedAt),
    endTime: survey.endedAt === null ? null : iso(survey.endedAt),
    distanceMeters: distanceMeters(survey),
    sampleCount: survey.points.length,
    pingCount: survey.points.length,
    successCount: answered,
    notes: "Ommesh",
  };
  return `${JSON.stringify({ _format: "meshcore_wardrive_data", _version: 2, samples, sessions: [session] }, null, 2)}\n`;
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const db = (v: number) => `${v > 0 ? "+" : ""}${v}`;

/** Who answered at a point, in one line a map app shows: ↑ how it heard us, ↓ how we heard it. */
function answers(point: SurveyPoint, name: (key: string) => string): string {
  if (point.replies.length === 0) return "—";
  return [...point.replies]
    .sort((a, b) => Math.min(b.us, b.them) - Math.min(a.us, a.them))
    .map((r) => `${name(r.key)}: ↑${db(r.us)} ↓${db(r.them)} dB, ${Math.round(r.rssi)} dBm`)
    .join("; ");
}

export function surveyGpx(survey: Survey, name: (key: string) => string): string {
  const title = xml(surveyFileName(survey, "gpx").replace(/\.gpx$/, ""));
  const points = survey.points
    .map((p) => `      <trkpt lat="${p.lat.toFixed(6)}" lon="${p.lon.toFixed(6)}"><time>${iso(p.at)}</time><desc>${xml(answers(p, name))}</desc></trkpt>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Ommesh" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>${title}</name><time>${iso(survey.startedAt)}</time></metadata>
  <trk>
    <name>${title}</name>
    <trkseg>
${points}
    </trkseg>
  </trk>
</gpx>
`;
}

/** KML colours are aabbggrr: the app's green, amber, red, and grey for no answer. */
const KML_COLOUR: Record<PointTone, string> = { good: "ff589f65", fair: "ff2c8fb4", weak: "ff5161d3", none: "ff918c8a" };

export function surveyKml(survey: Survey, name: (key: string) => string): string {
  const title = xml(surveyFileName(survey, "kml").replace(/\.kml$/, ""));
  const styles = (Object.keys(KML_COLOUR) as PointTone[])
    .map((tone) => `    <Style id="${tone}"><IconStyle><color>${KML_COLOUR[tone]}</color><scale>0.7</scale><Icon><href>http://maps.google.com/mapfiles/kml/shapes/shaded_dot.png</href></Icon></IconStyle></Style>`)
    .join("\n");
  const track = survey.points.map((p) => `${p.lon.toFixed(6)},${p.lat.toFixed(6)},0`).join(" ");
  const marks = survey.points
    .map((p) => `    <Placemark><name>${new Date(p.at).toTimeString().slice(0, 8)}</name><description>${xml(answers(p, name))}</description><styleUrl>#${pointTone(p)}</styleUrl><TimeStamp><when>${iso(p.at)}</when></TimeStamp><Point><coordinates>${p.lon.toFixed(6)},${p.lat.toFixed(6)},0</coordinates></Point></Placemark>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>${title}</name>
${styles}
    <Style id="track"><LineStyle><color>ffe8ad74</color><width>3</width></LineStyle></Style>
    <Placemark><name>${title}</name><styleUrl>#track</styleUrl><LineString><tessellate>1</tessellate><coordinates>${track}</coordinates></LineString></Placemark>
${marks}
  </Document>
</kml>
`;
}

const cell = (v: string | number) => {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** A row for every answer, and one with the repeater left empty where nobody answered. */
export function surveyCsv(survey: Survey, name: (key: string) => string): string {
  const rows = [["time", "lat", "lon", "accuracy_m", "repeater", "repeater_name", "snr_to_repeater_db", "snr_from_repeater_db", "rssi_dbm"].join(",")];
  for (const p of survey.points) {
    const place = [iso(p.at), p.lat.toFixed(6), p.lon.toFixed(6), Math.round(p.accuracy)];
    if (p.replies.length === 0) rows.push([...place, "", "", "", "", ""].map(cell).join(","));
    for (const r of p.replies) rows.push([...place, shortId(r.key), name(r.key), r.us, r.them, Math.round(r.rssi)].map(cell).join(","));
  }
  return `${rows.join("\n")}\n`;
}

export function surveyFile(survey: Survey, format: SurveyFormat, name: (key: string) => string): string {
  if (format === "json") return surveyJson(survey, name);
  if (format === "gpx") return surveyGpx(survey, name);
  if (format === "kml") return surveyKml(survey, name);
  return surveyCsv(survey, name);
}
