/**
 * The upload protocol of MeshCore Wardrive, which community coverage maps
 * take: a POST of `{"samples": [...]}` in batches of a hundred, one sample
 * a ping, naming the repeater the radio heard best (Wardrive keeps one per
 * ping, and a map counts a ping once). A map answers with how many it took
 * and how many were already there; a sample's id makes a second upload of
 * the same survey a no-op.
 */

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

export function wardriveSamples(survey: Survey, name: (key: string) => string, appVersion: string): WardriveSample[] {
  return survey.points.map((point, i) => {
    const best = heardBest(point);
    return {
      id: sampleId(survey, i),
      nodeId: best ? shortId(best.key) : "Unknown",
      repeaterName: best ? name(best.key) : "Unknown",
      latitude: point.lat,
      longitude: point.lon,
      rssi: best ? Math.round(best.rssi) : null,
      snr: best ? Math.round(best.them) : null,
      pingSuccess: point.replies.length > 0,
      timestamp: new Date(point.at).toISOString(),
      appVersion: `Ommesh ${appVersion}`,
      source: "Ommesh",
    };
  });
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
