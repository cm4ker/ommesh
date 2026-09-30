/**
 * The coverage survey in progress, and the ones kept with this radio. While
 * a survey runs, the phone's position keeps coming, the screen stays on, and
 * the survey decides whether to ask "who hears me" (the rule is in
 * surveyData.ts). The asks go through the same count as the button's, so
 * the two never spend answers the repeaters will not give.
 *
 * Who runs it depends on where the page is. A phone puts a hidden page to
 * sleep, so on a phone linked to its radio over Bluetooth the radio core
 * behind the link runs the survey (`survey.rs` in `crates/meshcore-core`,
 * with the same rule) on the position the phone's own code reads, locked or
 * not, and this file shows what the core says and keeps its points. Anywhere
 * else the page runs it once a second while it is in front, and a survey
 * left in the background stands still and says for how long when it comes
 * back.
 */

import { useEffect, useSyncExternalStore } from "react";
import { AdvType } from "@meshnet/meshcore";
import { t } from "../i18n/index.js";
import { hasPosition } from "./geo.js";
import { askWhoHears, asksLeft, hearsListening, noteAsk, recentAsks } from "./hears.js";
import { noteHeardUs } from "./links.js";
import { getPhoneState, holdPhone, locateOnce, locateText, LocateError } from "./phonePosition.js";
import { coreSurvey, coreSurveyStart, coreSurveyStop, onCoreSurvey, relayCarries, type CoreSurveyAnswer } from "./relay.js";
import { session, storage } from "./session.js";
import { readSetting, writeSetting } from "./storage.js";
import { pointsToAdd, surveyStep, type Survey, type SurveyPoint } from "./surveyData.js";
import { toast } from "./toast.js";

export type SurveyPhase = "gps" | "listening" | "wait" | "still" | "offline";

export interface SurveyRun {
  id: string;
  phase: SurveyPhase;
  lastPingAt: number | null;
  /** How long the page was away, told for a while after it came back. */
  paused: { ms: number; until: number } | null;
  /** The phone's radio core runs it, so it goes on with the phone locked or the app out of sight. */
  unattended: boolean;
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

let loading: { radio: string; done: Promise<void> } | null = null;

/** Reads the radio's surveys once, however many ask at the same time. */
function loadSurveys(radio: string): Promise<void> {
  if (state.radio === radio && state.list) return Promise.resolve();
  if (loading?.radio === radio) return loading.done;
  const done = readSurveys(radio).finally(() => {
    if (loading?.done === done) loading = null;
  });
  loading = { radio, done };
  return done;
}

async function readSurveys(radio: string): Promise<void> {
  let list: Survey[] = [];
  try {
    const raw = await storage.loadExtra(storeKey(radio));
    if (Array.isArray(raw)) list = raw as Survey[];
  } catch {
    // Unreadable, the list starts empty; nothing is written over it until a survey is made.
  }
  const running = runningSurvey();
  list = list.filter((s) => s.id !== running?.id);
  // A page made anew finds what the phone's radio core has: a survey it went on with,
  // or the points it kept of one the app stopped under.
  const answer = running ? null : await coreSurvey().catch(() => null);
  const core = readCore(answer?.json);
  const here = core?.radio === radio;
  let taken: CoreSurvey | null = null;
  let added = false;
  if (answer && core && here) {
    const mine: Survey = list.find((s) => s.id === core.id) ?? { id: core.id, radio, startedAt: core.startedAt, endedAt: null, points: [], nodes: {} };
    const fresh = pointsToAdd(mine.points.length, core.count, core.points) ?? [];
    const next = withPoints(mine, fresh.map(ofContacts));
    if (answer.running && !state.run) taken = core;
    added = fresh.length > 0;
    list = list.filter((s) => s.id !== core.id);
    if (next.points.length > 0 || taken) list = [next, ...list].sort((a, b) => b.startedAt - a.startedAt);
  }
  // With its points here, the core's copy is no more use, and one it runs for another radio is
  // nobody's. One only kept for another radio waits for that radio.
  if (answer && core && !taken && (here || answer.running)) void coreSurveyStop().catch(() => undefined);
  // One the app was closed during has ended where its last point is.
  list = list.map((s) => (s.endedAt === null && s.id !== taken?.id ? { ...s, endedAt: s.points.at(-1)?.at ?? s.startedAt } : s));
  set({ radio, list: running && running.radio === radio ? [running, ...list] : list });
  if (added) persist();
  if (taken) takeUp(taken);
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

/** The survey with these points added, each repeater that answered named as its contact is now, so a file or the list can name it later. */
function withPoints(survey: Survey, points: SurveyPoint[]): Survey {
  if (points.length === 0) return survey;
  const contacts = session.getState().contacts;
  const nodes = { ...survey.nodes };
  for (const point of points) {
    for (const r of point.replies) {
      const c = contacts[r.key];
      if (c) nodes[r.key] = { name: c.name || c.prefix, lat: hasPosition(c.lat, c.lon) ? c.lat : null, lon: hasPosition(c.lat, c.lon) ? c.lon : null };
      else nodes[r.key] ??= { name: "", lat: null, lon: null };
    }
  }
  return { ...survey, points: [...survey.points, ...points], nodes };
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
  // The core went on meanwhile, and the page heard none of it.
  if (state.run.unattended) void readFromCore();
  else if (away > 60_000) setRun({ paused: { ms: away, until: Date.now() + 20_000 } });
  void keepAwake();
}

/** What every survey running has, whoever runs it: the screen kept on, and a look once a second. */
function watchRun(): void {
  document.addEventListener("visibilitychange", onVisibility);
  void keepAwake();
  timer = window.setInterval(tick, 1000);
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
  // A page made anew finds the one the radio core runs while it reads the list, and has taken it up.
  const taken = getSurveys().run;
  if (taken) return taken.id;
  const now = Date.now();
  const survey: Survey = { id: now.toString(36), radio, startedAt: now, endedAt: null, points: [], nodes: {} };
  set({ list: [survey, ...(state.list ?? [])], run: { id: survey.id, phase: "gps", lastPingAt: null, paused: null, unattended: relayCarries() } });
  watchRun();
  void follow(survey);
  return survey.id;
}

/**
 * The phone's position for the survey: leave asked first, so the watch after
 * it, and the radio core's own, run on leave given. A phone with no fix yet
 * keeps waiting; one whose location is refused or off ends the survey.
 */
async function follow(survey: Survey): Promise<void> {
  const id = survey.id;
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
  // A core that will not take it leaves it to the page, as anywhere else.
  if (state.run.unattended && !(await handToCore(survey))) setRun({ unattended: false });
  tick();
}

function tick(): void {
  const run = state.run;
  const survey = runningSurvey();
  if (!run || !survey || (run.phase === "listening" && !run.unattended)) return;
  const now = Date.now();
  const s = session.getState();
  // Another radio connected: this one's survey is over.
  if (s.self && s.self.key !== survey.radio) {
    stopSurvey();
    return;
  }
  // The radio core decides when to ask, and says what it is doing.
  if (run.unattended) return;
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
  const point: SurveyPoint = {
    at: sentAt,
    lat: at.lat,
    lon: at.lon,
    accuracy: at.accuracy,
    replies: replies.filter((r) => r.type === AdvType.Repeater).map((r) => ({ key: r.key, us: r.heardUs, them: r.heardThem, rssi: r.rssi })),
  };
  replaceSurvey(withPoints(survey, [point]));
  setRun({ phase: "wait" });
  persist();
}

// ---- run by the phone's radio core ----

/** The survey as the radio core tells it (`Status` in `survey.rs`). */
interface CoreSurvey {
  id: string;
  radio: string;
  startedAt: number;
  phase: SurveyPhase;
  lastPingAt: number | null;
  /** How many points it has; `points` holds the last of them, or all. */
  count: number;
  points: SurveyPoint[];
}

function readCore(json: string | null | undefined): CoreSurvey | null {
  if (!json) return null;
  try {
    const core = JSON.parse(json) as CoreSurvey;
    return typeof core.id === "string" && Array.isArray(core.points) ? core : null;
  } catch {
    return null;
  }
}

/** A point of the core's with each repeater under its contact's key: an answer may carry only the start of one. */
function ofContacts(point: SurveyPoint): SurveyPoint {
  const contacts = Object.values(session.getState().contacts);
  return { ...point, replies: point.replies.map((r) => ({ ...r, key: contacts.find((c) => c.key.startsWith(r.key))?.key ?? r.key })) };
}

/** What the core says of the survey running: its new points are kept, and the card shows what it is doing. */
function applyCore(core: CoreSurvey): void {
  const run = state.run;
  const survey = runningSurvey();
  if (!run?.unattended || !survey || core.id !== run.id) return;
  const fresh = pointsToAdd(survey.points.length, core.count, core.points);
  // A step was missed: the whole of it is read.
  if (fresh === null) return void readFromCore();
  if (fresh.length > 0) {
    const points = fresh.map(ofContacts);
    replaceSurvey(withPoints(survey, points));
    persist();
    for (const point of points) for (const r of point.replies) noteHeardUs(r.key, r.us, r.them);
  }
  // The core's asks count with the button's.
  if (core.lastPingAt !== null) noteAsk(core.lastPingAt);
  if (core.phase !== run.phase || core.lastPingAt !== run.lastPingAt) setRun({ phase: core.phase, lastPingAt: core.lastPingAt });
}

/** The whole survey from the core: after the page was away, or when a step of it was missed. */
async function readFromCore(): Promise<void> {
  const answer = await coreSurvey().catch(() => null);
  const core = readCore(answer?.json);
  if (answer?.running && core) applyCore(core);
}

let unhear: (() => void) | null = null;

async function hearCore(): Promise<void> {
  const stop = await onCoreSurvey((json) => {
    const core = readCore(json);
    if (core) applyCore(core);
  });
  unhear?.();
  unhear = stop;
}

/** Hands the survey to the phone's radio core to run; false when it would not take it. */
async function handToCore(survey: Survey): Promise<boolean> {
  try {
    await hearCore();
    const answer = await coreSurveyStart(JSON.stringify({ id: survey.id, radio: survey.radio, startedAt: survey.startedAt, asks: recentAsks() }));
    const core = readCore(answer.json);
    if (!answer.running || !core) throw new Error("the radio core started no survey");
    // Stopped while the core was taking it.
    if (state.run?.id !== survey.id) void coreSurveyStop().catch(() => undefined);
    else applyCore(core);
    return true;
  } catch (error) {
    console.warn("The radio core did not take the survey; it runs while the app is open", error);
    unhear?.();
    unhear = null;
    return false;
  }
}

/** A survey the radio core went on with while the page was gone (a phone lets a page out of sight go when memory is short), taken up where it is. */
function takeUp(core: CoreSurvey): void {
  set({ run: { id: core.id, phase: core.phase, lastPingAt: core.lastPingAt, paused: null, unattended: true } });
  watchRun();
  releasePhone = holdPhone(true);
  void hearCore().then(() => (state.run?.id === core.id ? readFromCore() : undefined), () => undefined);
}

/** The points the core kept that the page had not heard of when the survey was stopped. */
function addLate(answer: CoreSurveyAnswer): void {
  const core = readCore(answer.json);
  const survey = core && surveyById(core.id);
  if (!core || !survey || state.run?.id === core.id) return;
  const fresh = pointsToAdd(survey.points.length, core.count, core.points);
  if (!fresh?.length) return;
  replaceSurvey(withPoints(survey, fresh.map(ofContacts)));
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
  if (run.unattended) {
    unhear?.();
    unhear = null;
    void coreSurveyStop().then(addLate, () => undefined);
  }
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
