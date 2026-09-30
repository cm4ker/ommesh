/**
 * A coverage survey: a drive with the radio, where every so often the phone
 * asks the repeaters in direct range "who hears me" and keeps where it was
 * and who answered. What a survey holds, when the next ask is due, and what
 * a drive adds up to live here, apart from the radio and the screen, so they
 * can be tested.
 */

import { distanceKm } from "./geo.js";
import { quality } from "./los.js";

/** One repeater's answer at a point: how it heard us and how we heard it, dB, and the signal's strength, dBm. */
export interface SurveyReply {
  key: string;
  us: number;
  them: number;
  rssi: number;
}

/** Where the phone was when it asked, how sure the fix was (metres either way), and who answered; none is a point too. */
export interface SurveyPoint {
  at: number;
  lat: number;
  lon: number;
  accuracy: number;
  replies: SurveyReply[];
}

/** A repeater as it was known when it answered, so a file or the list can name it after its contact is gone. */
export interface SurveyNode {
  name: string;
  lat: number | null;
  lon: number | null;
}

export interface Survey {
  id: string;
  /** The radio's key: the surveys are kept with its history. */
  radio: string;
  startedAt: number;
  /** Null while it runs. */
  endedAt: number | null;
  points: SurveyPoint[];
  nodes: Record<string, SurveyNode>;
  /** The coverage maps it was sent to, by id: when, and how many points it had then. */
  sent?: Record<string, { at: number; points: number }>;
}

/** Whether a survey has gone to a coverage map, whichever one. */
export function onMap(survey: Survey): boolean {
  return Object.keys(survey.sent ?? {}).length > 0;
}

/** An ask every half minute at most: a repeater answers four in two minutes, whoever asks. */
export const PING_EVERY_MS = 30_000;
// The rule in these four, and `surveyStep` below, is also the phone's radio core's
// (`crates/meshcore-core/src/survey.rs`), which runs a survey while the page sleeps: change both together.
/** Standing still adds nothing to the map, so the next ask waits until the phone has moved this far. */
export const MOVE_M = 50;
/** A fix vaguer than this would put the point in the wrong street. */
export const FIX_M = 50;
/** A fix older than this is where the phone was, not where it is. */
export const FIX_AGE_MS = 20_000;

export type PointTone = "good" | "fair" | "weak" | "none";

/** How well a repeater and the radio hear each other: the worse of the two ways. */
export function replyScore(reply: SurveyReply): number {
  return Math.min(reply.us, reply.them);
}

/** The answer that makes the point: the repeater that both hears us and is heard best. */
export function bestReply(point: SurveyPoint): SurveyReply | null {
  let best: SurveyReply | null = null;
  for (const reply of point.replies) if (!best || replyScore(reply) > replyScore(best)) best = reply;
  return best;
}

/** A point's colour: green means a message would go both ways from there, grey that nobody answered. */
export function pointTone(point: SurveyPoint): PointTone {
  const best = bestReply(point);
  return best ? quality(replyScore(best)) : "none";
}

export interface Fixish {
  lat: number;
  lon: number;
  accuracy: number;
  at: number;
}

export type SurveyStep = "gps" | "wait" | "still" | "ping";

/**
 * What the survey does now: wait for a good fix, wait out the half minute,
 * wait for the phone to move, or ask. The first ask goes as soon as the fix is good.
 */
export function surveyStep(now: number, fix: Fixish | null, lastPingAt: number | null, last: SurveyPoint | null): SurveyStep {
  if (!fix || fix.accuracy > FIX_M || now - fix.at > FIX_AGE_MS) return "gps";
  if (lastPingAt !== null && now - lastPingAt < PING_EVERY_MS) return "wait";
  if (last && distanceKm(last.lat, last.lon, fix.lat, fix.lon) * 1000 < MOVE_M) return "still";
  return "ping";
}

/** How far the phone still has to go from the last point before the next ask, in metres; null with no point or no fix to measure from. */
export function metresToGo(fix: Fixish | null, last: SurveyPoint | null): number | null {
  if (!fix || !last) return null;
  return Math.max(0, Math.round(MOVE_M - distanceKm(last.lat, last.lon, fix.lat, fix.lon) * 1000));
}

/**
 * The points another hand has kept that are not here yet. A phone's radio core
 * runs a survey while the page sleeps, and tells of each step with how many
 * points it has (`count`) and the last of them (`tail`), or all of them when
 * asked. Null when the tail starts past the `have` points here: some were
 * missed, and all of them have to be asked for.
 */
export function pointsToAdd(have: number, count: number, tail: SurveyPoint[]): SurveyPoint[] | null {
  const from = count - tail.length;
  if (from > have) return null;
  return tail.slice(Math.max(0, have - from));
}

export interface SurveyStats {
  /** From the first point to the last, or to the end. */
  ms: number;
  km: number;
  points: number;
  answered: number;
}

export function surveyStats(survey: Survey, now = Date.now()): SurveyStats {
  let km = 0;
  const points = survey.points;
  for (let i = 1; i < points.length; i++) km += distanceKm(points[i - 1]!.lat, points[i - 1]!.lon, points[i]!.lat, points[i]!.lon);
  return {
    ms: Math.max(0, (survey.endedAt ?? now) - survey.startedAt),
    km,
    points: points.length,
    answered: points.filter((p) => p.replies.length > 0).length,
  };
}

export interface RepeaterRow {
  key: string;
  /** Points where it answered. */
  count: number;
  /** Its best answer, by the worse of the two ways. */
  best: SurveyReply;
}

/** The repeaters that answered, the one heard at the most points first. */
export function repeaterRows(survey: Survey): RepeaterRow[] {
  const rows = new Map<string, RepeaterRow>();
  for (const point of survey.points) {
    for (const reply of point.replies) {
      const row = rows.get(reply.key);
      if (!row) rows.set(reply.key, { key: reply.key, count: 1, best: reply });
      else {
        row.count++;
        if (replyScore(reply) > replyScore(row.best)) row.best = reply;
      }
    }
  }
  return [...rows.values()].sort((a, b) => b.count - a.count || replyScore(b.best) - replyScore(a.best));
}

/** The points' colours with one repeater picked: where it answered, by its own answer; elsewhere "off". */
export function toneFor(point: SurveyPoint, only: string | null): PointTone | "off" {
  if (!only) return pointTone(point);
  const reply = point.replies.find((r) => r.key === only);
  return reply ? quality(replyScore(reply)) : "off";
}
