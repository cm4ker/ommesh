/**
 * The upload protocol of MeshCore Wardrive, which community coverage maps
 * take: a POST of `{"samples": [...]}` in batches of a hundred, a sample for
 * each repeater that answered a ping, or one naming none where nobody did.
 * Wardrive itself sent only the repeater heard best, which left the others
 * off the map; its fork that sends them all is what MeshCoreTel takes now.
 * A map answers with how many it took and how many were already there; a
 * sample's id makes a second upload of the same survey a no-op.
 */

import { sha256 } from "../sha256.js";
import type { Survey, SurveyPoint, SurveyReply } from "../surveyData.js";

export interface WardriveSample {
  id: string;
  /** The repeater's first 8 hex digits, upper case; "Unknown" where nobody answered. */
  nodeId: string;
  repeaterName: string;
  latitude: number;
  longitude: number;
  rssi: number | null;
  /** How well the radio heard the repeater, whole dB. */
  snr: number | null;
  pingSuccess: boolean;
  timestamp: string;
  appVersion: string;
  source: string;
}

export const WARDRIVE_BATCH = 100;

/** The repeater the radio heard best at a point: the one Wardrive would keep. */
export function heardBest(point: SurveyPoint): SurveyReply | null {
  let best: SurveyReply | null = null;
  for (const reply of point.replies) if (!best || reply.them > best.them) best = reply;
  return best;
}

export const shortId = (key: string) => key.slice(0, 8).toUpperCase();

/** A point's id, the same in an uploaded sample and in the exported file, so a map takes the two as one. */
export function sampleId(survey: Survey, index: number): string {
  return `${survey.points[index]!.at}_${shortId(survey.radio)}_${index}`;
}

/**
 * A survey's samples: at each point the repeater heard best first, under the
 * point's own id as before, so a survey sent when only that one went adds
 * just the others when sent again; each other answer under the point's id
 * and the repeater's. A map that counts pings tells them apart by that tail.
 */
export function wardriveSamples(survey: Survey, name: (key: string) => string, appVersion: string): WardriveSample[] {
  return survey.points.flatMap((point, i) => {
    const id = sampleId(survey, i);
    const sample = (reply: SurveyReply | null, tail: string): WardriveSample => ({
      id: id + tail,
      nodeId: reply ? shortId(reply.key) : "Unknown",
      repeaterName: reply ? name(reply.key) : "Unknown",
      latitude: point.lat,
      longitude: point.lon,
      rssi: reply?.rssi == null ? null : Math.round(reply.rssi),
      snr: reply ? Math.round(reply.them) : null,
      pingSuccess: reply !== null,
      timestamp: new Date(point.at).toISOString(),
      appVersion: `Ommesh ${appVersion}`,
      source: "Ommesh",
    });
    const best = heardBest(point);
    if (!best) return [sample(null, "")];
    return [sample(best, ""), ...point.replies.filter((r) => r !== best).map((r) => sample(r, `_${shortId(r.key)}`))];
  });
}

/** The reader's leave for the map to publish the points under the radio's name, in the words a map reads. */
export const AUTHOR_CONSENT = "publish-named";

/**
 * Who made a survey, beside a batch's samples, for a map that names whose
 * points they are (Ommesh's own): the radio's public key and name, the
 * reader's leave to publish them under it, and the radio's signature of
 * `authorMessage`, the key and the signature in hex.
 */
export interface WardriveAuthor {
  key: string;
  name: string;
  consent: typeof AUTHOR_CONSENT;
  sig: string;
}

/**
 * What the radio signs to put its name to a batch: SHA-256 of
 * "ommesh-wardrive", the leave to publish under its name, and the batch's
 * sample ids, a line each. The map works the same out from the samples it
 * got and names the radio only when the signature fits its key: every
 * advert carries a radio's key, so a name without the signature anyone
 * could send, and the leave cannot be cut off it.
 */
export function authorMessage(samples: WardriveSample[]): Uint8Array {
  return sha256(new TextEncoder().encode(["ommesh-wardrive", AUTHOR_CONSENT, ...samples.map((s) => s.id)].join("\n")));
}

export function batches<T>(items: T[], size = WARDRIVE_BATCH): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** What a map says it did with a batch; fields it leaves out count as none. */
export interface UploadReply {
  received: number;
  processed: number;
  deduped: number;
  cellsCreated: number;
  cellsUpdated: number;
}

export function readUploadReply(body: unknown): UploadReply {
  const data = (typeof body === "string" ? safeJson(body) : body) as Record<string, unknown> | null;
  const n = (key: string) => (data && typeof data[key] === "number" ? (data[key] as number) : 0);
  return { received: n("samplesReceived"), processed: n("samplesProcessed"), deduped: n("samplesDeduped"), cellsCreated: n("cellsCreated"), cellsUpdated: n("cellsUpdated") };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function addReplies(a: UploadReply, b: UploadReply): UploadReply {
  return { received: a.received + b.received, processed: a.processed + b.processed, deduped: a.deduped + b.deduped, cellsCreated: a.cellsCreated + b.cellsCreated, cellsUpdated: a.cellsUpdated + b.cellsUpdated };
}
