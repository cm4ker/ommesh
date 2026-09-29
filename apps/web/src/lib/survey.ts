/**
 * The coverage survey in progress, and the ones kept with this radio. While
 * a survey runs, the phone's position keeps coming, the screen stays on, and
 * once a second the survey decides whether to ask "who hears me" (the rule is
 * in surveyData.ts). The asks go through the same count as the button's, so
 * the two never spend answers the repeaters will not give.
 *
 * It runs while the page is in front. A phone puts a hidden page to sleep,
 * and the position stops coming, so a survey left in the background stands
 * still and says for how long when it comes back.
 */

import { useEffect, useSyncExternalStore } from "react";
import { AdvType } from "@meshnet/meshcore";
import { t } from "../i18n/index.js";
import { hasPosition } from "./geo.js";
import { askWhoHears, asksLeft, hearsListening } from "./hears.js";
import { getPhoneState, holdPhone, locateOnce, locateText, LocateError } from "./phonePosition.js";
import { session, storage } from "./session.js";
import { readSetting, writeSetting } from "./storage.js";
import { surveyStep, type Survey, type SurveyPoint } from "./surveyData.js";
import { toast } from "./toast.js";

export type SurveyPhase = "gps" | "listening" | "wait" | "still" | "offline";

export interface SurveyRun {
  id: string;
  phase: SurveyPhase;
  lastPingAt: number | null;
  /** How long the page was away, told for a while after it came back. */
  paused: { ms: number; until: number } | null;
}

export interface SurveysState {
  /** The radio whose surveys these are. */
  radio: string | null;
  /** Newest first, the running one among them; null until read. */
  list: Survey[] | null;
  run: SurveyRun | null;
}

let state: SurveysState = { radio: null, list: null, run: null };
const listeners = new Set<() => void>();

function set(patch: Partial<SurveysState>): void {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

function setRun(patch: Partial<SurveyRun>): void {
  if (state.run) set({ run: { ...state.run, ...patch } });
}

export function getSurveys(): SurveysState {
  return state;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The surveys of the radio connected, read from the device the first time they are wanted. */
export function useSurveys(): SurveysState {
  const radio = session.getState().self?.key ?? null;
  useEffect(() => {
    if (radio) void loadSurveys(radio);
  }, [radio]);
  return useSyncExternalStore(subscribe, getSurveys);
}

/** Whether a survey runs, for what only needs that: it changes twice a survey rather than with every point. */
export function useSurveying(): boolean {
  return useSyncExternalStore(subscribe, () => state.run !== null);
}

export function surveyById(id: string | null): Survey | null {
  return (id && state.list?.find((s) => s.id === id)) || null;
}

export function runningSurvey(): Survey | null {
  return state.run ? surveyById(state.run.id) : null;
}

const storeKey = (radio: string) => `surveys:${radio}`;

async function loadSurveys(radio: string): Promise<void> {
  if (state.radio === radio && state.list) return;
  let list: Survey[] = [];
  try {
    const raw = await storage.loadExtra(storeKey(radio));
    if (Array.isArray(raw)) list = raw as Survey[];
  } catch {
    // Unreadable, the list starts empty; nothing is written over it until a survey is made.
  }
  const running = runningSurvey();
  // One the app was closed during has ended where its last point is.
  list = list
    .filter((s) => s.id !== running?.id)
    .map((s) => (s.endedAt === null ? { ...s, endedAt: s.points.at(-1)?.at ?? s.startedAt } : s));
  set({ radio, list: running && running.radio === radio ? [running, ...list] : list });
}

let saving = Promise.resolve();

/** Writes the list after the last write, so two in a row land in order. */
function persist(): void {
  const { radio, list } = state;
  if (!radio || !list) return;
  saving = saving.then(() => storage.saveExtra(storeKey(radio), list)).catch(() => undefined);
}

function replaceSurvey(next: Survey): void {
  set({ list: (state.list ?? []).map((s) => (s.id === next.id ? next : s)) });
}

// ---- running one ----

let timer: number | null = null;
let releasePhone: (() => void) | null = null;
let hiddenAt: number | null = null;
let lock: WakeLockSentinel | null = null;

async function keepAwake(): Promise<void> {
  if (lock || !state.run || document.visibilityState !== "visible" || !("wakeLock" in navigator)) return;
  try {
    lock = await navigator.wakeLock.request("screen");
    lock.addEventListener("release", () => {
      lock = null;
    });
  } catch {
    lock = null;
  }
}

function letSleep(): void {
  void lock?.release().catch(() => undefined);
  lock = null;
}

function onVisibility(): void {
  if (!state.run) return;
  if (document.visibilityState === "hidden") {
    hiddenAt = Date.now();
    return;
  }
  const away = hiddenAt === null ? 0 : Date.now() - hiddenAt;
  hiddenAt = null;
  if (away > 60_000) setRun({ paused: { ms: away, until: Date.now() + 20_000 } });
  void keepAwake();
}

/** Starts a survey on the radio connected; says why when it cannot. Resolves to its id. */
export async function startSurvey(): Promise<string | null> {
  const s = session.getState();
  const radio = s.self?.key;
  if (state.run) return state.run.id;
  if (!radio || s.status !== "ready") {
    toast(t("tools.survey.needRadio"), "error");
    return null;
  }
  await loadSurveys(radio);
  const now = Date.now();
  const survey: Survey = { id: now.toString(36), radio, startedAt: now, endedAt: null, points: [], nodes: {} };
  set({ list: [survey, ...(state.list ?? [])], run: { id: survey.id, phase: "gps", lastPingAt: null, paused: null } });
  document.addEventListener("visibilitychange", onVisibility);
  void keepAwake();
  timer = window.setInterval(tick, 1000);
  void follow(survey.id);
  return survey.id;
}

/**
 * The phone's position for the survey: leave asked first, so the watch after
 * it runs on leave given. A phone with no fix yet keeps waiting; one whose
 * location is refused or off ends the survey.
 */
async function follow(id: string): Promise<void> {
  try {
    await locateOnce();
  } catch (error) {
    if (error instanceof LocateError && (error.problem === "denied" || error.problem === "off")) {
      if (state.run?.id !== id) return;
      toast(locateText(error), "error");
      stopSurvey();
      return;
    }
  }
  if (state.run?.id !== id) return;
  releasePhone = holdPhone(true);
  tick();
}

function tick(): void {
  const run = state.run;
  const survey = runningSurvey();
  if (!run || !survey || run.phase === "listening") return;
  const now = Date.now();
  const s = session.getState();
  // Another radio connected: this one's survey is over.
  if (s.self && s.self.key !== survey.radio) {
    stopSurvey();
    return;
  }
  const paused = run.paused && run.paused.until < now ? null : run.paused;
  let phase: SurveyPhase;
  if (s.status !== "ready") phase = "offline";
  else {
    const fix = getPhoneState().fix;
    const step = surveyStep(now, fix, run.lastPingAt, survey.points.at(-1) ?? null);
    // An ask already out, from the button, is let finish first.
    if (step === "ping" && fix && asksLeft(now).left > 0 && !hearsListening()) {
      void ping(run.id, { lat: fix.lat, lon: fix.lon, accuracy: fix.accuracy });
      return;
    }
    phase = step === "ping" ? "wait" : step;
  }
  if (phase !== run.phase || paused !== run.paused) setRun({ phase, paused });
}

async function ping(id: string, at: { lat: number; lon: number; accuracy: number }): Promise<void> {
  const sentAt = Date.now();
  setRun({ phase: "listening", lastPingAt: sentAt });
  const replies = await askWhoHears();
  const survey = runningSurvey();
  if (state.run?.id !== id || !survey) return;
  // With no ask, or the radio gone while listening, silence says nothing about the spot.
  if (replies === null || session.getState().status !== "ready") {
    setRun({ phase: session.getState().status === "ready" ? "wait" : "offline" });
    return;
  }
  const contacts = session.getState().contacts;
  const nodes = { ...survey.nodes };
  const point: SurveyPoint = {
    at: sentAt,
    lat: at.lat,
    lon: at.lon,
    accuracy: at.accuracy,
    replies: replies.filter((r) => r.type === AdvType.Repeater).map((r) => ({ key: r.key, us: r.heardUs, them: r.heardThem, rssi: r.rssi })),
  };
  for (const r of point.replies) {
    const c = contacts[r.key];
    if (c) nodes[r.key] = { name: c.name || c.prefix, lat: hasPosition(c.lat, c.lon) ? c.lat : null, lon: hasPosition(c.lat, c.lon) ? c.lon : null };
    else nodes[r.key] ??= { name: "", lat: null, lon: null };
  }
  replaceSurvey({ ...survey, points: [...survey.points, point], nodes });
  setRun({ phase: "wait" });
  persist();
}

/** Ends the survey running; its id, or null when it had no points and was let go. */
export function stopSurvey(): string | null {
  const run = state.run;
  if (!run) return null;
  if (timer !== null) window.clearInterval(timer);
  timer = null;
  releasePhone?.();
  releasePhone = null;
  document.removeEventListener("visibilitychange", onVisibility);
  hiddenAt = null;
  letSleep();
  const survey = surveyById(run.id);
  set({ run: null });
  if (!survey) return null;
  if (survey.points.length === 0) {
    set({ list: (state.list ?? []).filter((s) => s.id !== survey.id) });
    persist();
    return null;
  }
  replaceSurvey({ ...survey, endedAt: Date.now() });
  persist();
  return survey.id;
}

/** Ends the survey running and keeps nothing of it, as when a hold started it by mistake. */
export function discardSurvey(id: string): void {
  if (state.run?.id !== id) return;
  stopSurvey();
  deleteSurvey(id);
}

const HOLD_KEY = "survey.holdUsed";

/** Whether a survey was ever started by holding ≋; until then its sheet says it can be. */
export function surveyHoldUsed(): boolean {
  return readSetting(HOLD_KEY, false);
}

export function noteSurveyHold(): void {
  writeSetting(HOLD_KEY, true);
}

/** Takes a kept survey off the device; the survey, so an Undo can put it back. */
export function deleteSurvey(id: string): Survey | null {
  const survey = surveyById(id);
  if (!survey || state.run?.id === id) return null;
  set({ list: (state.list ?? []).filter((s) => s.id !== id) });
  persist();
  return survey;
}

export function restoreSurvey(survey: Survey): void {
  if (state.radio !== survey.radio || surveyById(survey.id)) return;
  set({ list: [...(state.list ?? []), survey].sort((a, b) => b.startedAt - a.startedAt) });
  persist();
}

/** Notes that a survey went to a coverage map, so its sheet says so and when. */
export function markSurveySent(id: string, mapId: string, points: number): void {
  const survey = surveyById(id);
  if (!survey) return;
  replaceSurvey({ ...survey, sent: { ...survey.sent, [mapId]: { at: Date.now(), points } } });
  persist();
}

/** A repeater's name as the survey knew it, or as the contacts know it now. */
export function surveyNodeName(survey: Survey, key: string): string {
  const c = session.getState().contacts[key];
  return c?.name || survey.nodes[key]?.name || t("tools.hears.repeater", { id: key.slice(0, 8) });
}
