/**
 * The port's log: one serial port opened bare, everything that goes along the
 * cable both ways, the lines set by hand, and the check, which tries speeds
 * and lines until the radio answers. The log holds the port while it is open,
 * so a connect closes it first (`closeJournal`).
 */

import { useSyncExternalStore } from "react";
import { commands, decodeFrame, frameForStream } from "@meshnet/meshcore";
import type { Connector, FoundDevice, PortAccess } from "../transports/types.js";
import { autoLines, boardKind, choiceOf, linesOf, mayBeEsp32, portSettings, setPortSettings, type Lines } from "../transports/portSettings.js";
import type { RawPort } from "../transports/rawPort.js";
import { ESP_SYNC, isLoaderAnswer, judge, PieceSplitter, planProbes, type Piece, type Verdict } from "./portLog.js";
import { connectWith } from "./link.js";
import { locale, t } from "../i18n/index.js";
import { errorText } from "../i18n/errors.js";

export interface JournalEntry {
  id: number;
  at: number;
  /** out: sent; in: came; lines: the lines were set; note: the log about itself; rule: a check starts or ends. */
  kind: "out" | "in" | "lines" | "note" | "rule";
  text: string;
  /** Went or came as words, not as a frame. */
  words?: boolean;
  /** Came as neither a frame nor words: bytes at the wrong speed, or a loader's. */
  noise?: boolean;
  bytes?: Uint8Array;
  /** The probe of a check it belongs to. */
  probe?: number | undefined;
}

export interface JournalProbe {
  n: number;
  baud: number;
  lines: Lines;
  /** What Connect would use now. */
  current: boolean;
  /** The last probe, which asks whether an ESP32's ROM loader is on the port. */
  loader: boolean;
  result: Verdict["kind"] | "busy" | null;
}

export type CheckOutcome =
  | { kind: "answered"; baud: number; lines: Lines; current: boolean; name: string | null; firmware: string | null; probe: number; total: number; ms: number }
  | { kind: "text"; text: string }
  | { kind: "loader" }
  | { kind: "garbage" }
  | { kind: "silent" }
  | { kind: "busy"; error: string };

export interface JournalState {
  connector: Connector | null;
  device: FoundDevice | null;
  /** The port is open for the log; a check opens it afresh for each probe. */
  open: boolean;
  lines: Lines;
  signals: { cts: boolean; dsr: boolean } | null;
  entries: JournalEntry[];
  probes: JournalProbe[];
  checking: boolean;
  outcome: CheckOutcome | null;
}

/** How long a probe lets the board settle after the port opens and its lines are set. */
const SETTLE_MS = 300;
/** How long a probe waits for the radio's answer: a board restarted by the opening boots in a second or two. */
const ANSWER_MS = 3000;
/** How long the loader probe waits for an answer to its SYNC. */
const LOADER_MS = 1000;
/** Bytes that stop coming for this long are let out of the splitter as they are. */
const QUIET_MS = 150;
const SIGNALS_MS = 1000;
/** How long RTS holds an ESP32's EN low to restart it: esptool's hard reset over USB. */
const RESTART_PULSE_MS = 200;
/** The oldest lines go past this many. */
const MAX_ENTRIES = 1500;
const OFF: Lines = { dtr: false, rts: false };

const empty: JournalState = {
  connector: null,
  device: null,
  open: false,
  lines: OFF,
  signals: null,
  entries: [],
  probes: [],
  checking: false,
  outcome: null,
};

let state: JournalState = empty;
const listeners = new Set<() => void>();
let raw: RawPort | null = null;
let signalTimer: ReturnType<typeof setInterval> | null = null;
let nextId = 1;
/** Bumped by every close and every check: what an older one was doing is no longer wanted. */
let generation = 0;
/** The check under way, which holds the port until its probe ends. */
let checkRun: Promise<void> | null = null;

function set(patch: Partial<JournalState>): void {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

export function getJournal(): JournalState {
  return state;
}

export function useJournal(): JournalState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
  );
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function add(entry: Omit<JournalEntry, "id" | "at">): void {
  const entries = [...state.entries, { ...entry, id: nextId++, at: Date.now() }];
  set({ entries: entries.length > MAX_ENTRIES ? entries.slice(entries.length - MAX_ENTRIES) : entries });
}

export function linesText(lines: Lines): string {
  return t(`connect.serial.lines.${choiceOf(lines)}`);
}

/** What a frame from the radio says, in a few words. */
function incoming(payload: Uint8Array): string {
  const frame = decodeFrame(payload);
  if (frame.kind === "deviceInfo") return t("connect.journal.entry.radio", { model: frame.info.manufacturer || "?", firmware: frame.info.firmwareVersion || "?" });
  if (frame.kind === "selfInfo") return t("connect.journal.entry.self", { name: frame.info.name });
  return t("connect.journal.entry.frame", { code: payload[0] ?? -1 });
}

function addPiece(piece: Piece, probe?: number): void {
  if (piece.kind === "frame") add({ kind: "in", text: incoming(piece.payload), bytes: piece.bytes, probe });
  else if (piece.kind === "text") add({ kind: "in", text: piece.text, words: true, bytes: piece.bytes, probe });
  else if (isLoaderAnswer(piece.bytes)) add({ kind: "in", text: t("connect.journal.entry.loaderAnswer"), noise: true, bytes: piece.bytes, probe });
  else add({ kind: "in", text: t("connect.journal.entry.noise", { count: piece.bytes.length }), noise: true, bytes: piece.bytes, probe });
}

/** Hands what comes in to `onPiece` as frames, lines and loose bytes; `flush` lets out what is held. */
function listen(port: RawPort, onPiece: (piece: Piece) => void): { flush: () => void } {
  const splitter = new PieceSplitter();
  let quiet: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    if (quiet) clearTimeout(quiet);
    quiet = null;
    for (const piece of splitter.flush()) onPiece(piece);
  };
  port.onData((bytes) => {
    for (const piece of splitter.push(bytes)) onPiece(piece);
    if (quiet) clearTimeout(quiet);
    quiet = setTimeout(flush, QUIET_MS);
  });
  return { flush };
}

function accessOf(): { access: PortAccess; connector: Connector; device: FoundDevice } | null {
  const { connector, device } = state;
  return connector?.port && device ? { access: connector.port, connector, device } : null;
}

/** The lines the port is opened with: as its settings say, and for a browser's "auto", as the board's kind wants. */
function settingsLines(access: PortAccess, device: FoundDevice): Lines {
  const settings = portSettings(access.key(device));
  return settings.lines === "auto" ? (access.autoLines(device) ?? autoLines(device.usb)) : linesOf(settings.lines);
}

/** Lowers what is up, RTS first, and closes: an ESP32 on its own USB closed with both up stays in its loader. */
async function release(port: RawPort, lines: Lines): Promise<void> {
  try {
    if (lines.rts) await port.setLines({ dtr: lines.dtr, rts: false });
    if (lines.dtr || lines.rts) await port.setLines(OFF);
  } catch {
    // The port is going anyway.
  }
  await port.close();
}

/** Opens the log on a port. Another port's log is closed first. */
export function openJournal(connector: Connector, device: FoundDevice): void {
  if (state.connector === connector && state.device?.id === device.id) return;
  void (async () => {
    await closeJournal();
    set({ ...empty, connector, device });
    await openLog(generation);
  })();
}

/** Closes the log and lets the port go: before a connect, and when the connect screen goes. */
export async function closeJournal(): Promise<void> {
  generation++;
  await checkRun;
  await closeLog();
  set(empty);
}

async function closeLog(): Promise<void> {
  if (signalTimer) clearInterval(signalTimer);
  signalTimer = null;
  const port = raw;
  raw = null;
  if (port) await release(port, state.lines);
  if (state.open) set({ open: false, signals: null });
}

async function openLog(gen: number): Promise<void> {
  const target = accessOf();
  if (!target) return;
  const { access, device } = target;
  const baud = portSettings(access.key(device)).baud;
  let port: RawPort;
  try {
    port = await access.openRaw(device, baud);
  } catch (error) {
    if (gen === generation) add({ kind: "note", text: t("connect.journal.entry.notOpened", { error: errorText(error) }) });
    return;
  }
  if (gen !== generation) {
    await port.close();
    return;
  }
  raw = port;
  listen(port, (piece) => addPiece(piece));
  port.onClose((reason) => {
    if (raw !== port) return;
    raw = null;
    if (signalTimer) clearInterval(signalTimer);
    signalTimer = null;
    set({ open: false, signals: null });
    if (reason) add({ kind: "note", text: t("connect.journal.entry.closed", { error: errorText(reason) }) });
  });
  const lines = settingsLines(access, device);
  add({ kind: "note", text: t("connect.journal.entry.opened", { baud }) });
  try {
    await port.setLines(lines);
    add({ kind: "lines", text: t("connect.journal.entry.lines", { lines: linesText(lines) }) });
  } catch (error) {
    add({ kind: "note", text: errorText(error) });
  }
  set({ open: true, lines });
  signalTimer = setInterval(() => {
    void port.readSignals().then((signals) => {
      if (raw !== port) return;
      if (signals?.cts !== state.signals?.cts || signals?.dsr !== state.signals?.dsr) set({ signals });
    });
  }, SIGNALS_MS);
}

/** Raises or lowers one line on the open port, by hand. */
export async function setLine(which: keyof Lines, level: boolean): Promise<void> {
  if (!raw) return;
  const lines = { ...state.lines, [which]: level };
  try {
    await raw.setLines(lines);
    set({ lines });
    add({ kind: "lines", text: t("connect.journal.entry.linesHand", { lines: linesText(lines) }) });
  } catch (error) {
    add({ kind: "note", text: errorText(error) });
  }
}

/**
 * Restarts an ESP32, as esptool's hard reset over USB: RTS up with DTR down
 * pulls EN low, and the chip boots normally once RTS goes down. An nRF52
 * takes no notice.
 */
export async function restartRadio(): Promise<void> {
  if (!raw) await openLog(generation);
  const port = raw;
  if (!port) return;
  try {
    add({ kind: "lines", text: t("connect.journal.entry.restart") });
    await port.setLines({ dtr: false, rts: true });
    await sleep(RESTART_PULSE_MS);
    await port.setLines(OFF);
    set({ lines: OFF });
  } catch (error) {
    add({ kind: "note", text: errorText(error) });
  }
}

async function sendFrame(port: RawPort, payload: Uint8Array, text: string, probe?: number): Promise<void> {
  const bytes = frameForStream(payload);
  await port.write(bytes);
  add({ kind: "out", text, bytes, probe });
}

/** Asks the radio which it is: the first thing the app asks on connecting. */
export async function askRadio(): Promise<void> {
  if (!raw) return;
  try {
    await sendFrame(raw, commands.deviceQuery(), t("connect.journal.entry.ask"));
  } catch (error) {
    add({ kind: "note", text: errorText(error) });
  }
}

/** Sends words to the port, for a board that talks in words: a console, or firmware in another mode. */
export async function sendText(text: string, ending: string): Promise<void> {
  if (!raw) return;
  const bytes = new TextEncoder().encode(text + ending);
  try {
    await raw.write(bytes);
    add({ kind: "out", text, words: true, bytes });
  } catch (error) {
    add({ kind: "note", text: errorText(error) });
  }
}

export function clearJournal(): void {
  set({ entries: [], probes: [], outcome: state.checking ? state.outcome : null });
}

function setProbe(n: number, patch: Partial<JournalProbe>): void {
  set({ probes: state.probes.map((p) => (p.n === n ? { ...p, ...patch } : p)) });
}

async function waitFor(done: () => boolean, ms: number): Promise<void> {
  const until = Date.now() + ms;
  while (!done() && Date.now() < until) await sleep(50);
}

/** One probe: the port opened at a speed with its lines set, the radio asked which it is, and what came back. */
async function runProbe(access: PortAccess, device: FoundDevice, probe: { baud: number; lines: Lines }, n: number, gen: number): Promise<Verdict | { kind: "busy"; error: string }> {
  let port: RawPort;
  try {
    port = await access.openRaw(device, probe.baud);
  } catch (error) {
    const text = errorText(error);
    add({ kind: "note", text: t("connect.journal.entry.notOpened", { error: text }), probe: n });
    return { kind: "busy", error: text };
  }
  const pieces: Piece[] = [];
  const listener = listen(port, (piece) => {
    pieces.push(piece);
    addPiece(piece, n);
  });
  try {
    await port.setLines(probe.lines);
    await sleep(SETTLE_MS);
    await sendFrame(port, commands.deviceQuery(), t("connect.journal.entry.ask"), n);
    await waitFor(() => gen !== generation || pieces.some((p) => p.kind === "frame"), ANSWER_MS);
    listener.flush();
    if (pieces.length === 0) add({ kind: "note", text: t("connect.journal.entry.nothing", { seconds: ANSWER_MS / 1000 }), probe: n });
  } catch (error) {
    add({ kind: "note", text: errorText(error), probe: n });
  } finally {
    await release(port, probe.lines);
  }
  return judge(pieces);
}

/** The last probe: esptool's SYNC at 115200, which only an ESP32's ROM loader answers. */
async function runLoaderProbe(access: PortAccess, device: FoundDevice, n: number, gen: number): Promise<boolean> {
  let port: RawPort;
  try {
    port = await access.openRaw(device, 115200);
  } catch {
    return false;
  }
  const pieces: Piece[] = [];
  const listener = listen(port, (piece) => {
    pieces.push(piece);
    addPiece(piece, n);
  });
  try {
    await port.setLines(OFF);
    await sleep(SETTLE_MS);
    // Sent a few times, as esptool does: the loader may miss the first.
    for (let i = 0; i < 3 && gen === generation; i++) {
      await port.write(ESP_SYNC);
      if (i === 0) add({ kind: "out", text: t("connect.journal.entry.sync"), bytes: ESP_SYNC, probe: n });
      await sleep(100);
    }
    await waitFor(() => gen !== generation || pieces.some((p) => p.kind === "bytes" && isLoaderAnswer(p.bytes)), LOADER_MS);
    listener.flush();
  } catch (error) {
    add({ kind: "note", text: errorText(error), probe: n });
  } finally {
    await port.close();
  }
  return judge(pieces).kind === "loader";
}

/**
 * Tries the port's speeds and lines until the radio answers (planProbes has
 * the order), and says what was found. A speed that brought back noise is not
 * tried again with other lines. The log's own port is closed meanwhile and
 * opened again after.
 */
export async function startCheck(): Promise<void> {
  if (state.checking || checkRun) return;
  checkRun = runCheck();
  try {
    await checkRun;
  } finally {
    checkRun = null;
  }
}

async function runCheck(): Promise<void> {
  const target = accessOf();
  if (!target) return;
  const { access, device } = target;
  const gen = ++generation;
  await closeLog();
  const started = Date.now();
  set({ checking: true, outcome: null, probes: [] });
  add({ kind: "rule", text: t("connect.journal.rule.start", { time: new Date(started).toLocaleTimeString(locale()) }) });
  const settings = portSettings(access.key(device));
  const plan = planProbes(boardKind(device.usb), settings, access.autoLines(device));
  const noisy = new Set<number>();
  let outcome: CheckOutcome | null = null;
  let n = 0;
  for (const probe of plan) {
    if (gen !== generation) return;
    if (noisy.has(probe.baud)) continue;
    n++;
    set({ probes: [...state.probes, { n, ...probe, loader: false, result: null }] });
    const verdict = await runProbe(access, device, probe, n, gen);
    if (gen !== generation) return;
    setProbe(n, { result: verdict.kind });
    if (verdict.kind === "busy") outcome = { kind: "busy", error: verdict.error };
    else if (verdict.kind === "answered") {
      outcome = {
        kind: "answered",
        baud: probe.baud,
        lines: probe.lines,
        current: probe.current,
        name: verdict.info?.manufacturer || null,
        firmware: verdict.info?.firmwareVersion || null,
        probe: n,
        total: plan.length,
        ms: Date.now() - started,
      };
    } else if (verdict.kind === "text") outcome = { kind: "text", text: verdict.text };
    else if (verdict.kind === "loader") outcome = { kind: "loader" };
    else if (verdict.kind === "garbage") noisy.add(probe.baud);
    if (outcome) break;
  }
  if (!outcome && mayBeEsp32(device.usb)) {
    n++;
    set({ probes: [...state.probes, { n, baud: 115200, lines: OFF, current: false, loader: true, result: null }] });
    const loader = await runLoaderProbe(access, device, n, gen);
    if (gen !== generation) return;
    setProbe(n, { result: loader ? "loader" : "silent" });
    if (loader) outcome = { kind: "loader" };
  }
  outcome ??= noisy.size > 0 ? { kind: "garbage" } : { kind: "silent" };
  add({ kind: "rule", text: t("connect.journal.rule.end", { seconds: Math.max(1, Math.round((Date.now() - started) / 1000)) }) });
  set({ checking: false, outcome });
  // The log goes on, on the port as its settings have it.
  await openLog(gen);
}

/** Stops a check under way; the log opens the port again. */
export async function stopCheck(): Promise<void> {
  if (!state.checking) return;
  const gen = ++generation;
  set({ checking: false });
  // The probe under way lets the port go first.
  await checkRun;
  if (gen === generation) await openLog(gen);
}

/**
 * Keeps what the check found in the port's settings and, with `connect`,
 * connects with them. Lines that are what "auto" would raise stay "auto",
 * so the port goes on following its board.
 */
export async function applyOutcome(connect: boolean): Promise<void> {
  const target = accessOf();
  const outcome = state.outcome;
  if (!target || outcome?.kind !== "answered") return;
  const { access, connector, device } = target;
  const key = access.key(device);
  const settings = portSettings(key);
  const auto = access.autoLines(device);
  const sameAsAuto = auto !== null && auto.dtr === outcome.lines.dtr && auto.rts === outcome.lines.rts;
  setPortSettings(key, {
    baud: outcome.baud,
    lines: outcome.current ? settings.lines : sameAsAuto ? "auto" : choiceOf(outcome.lines),
  });
  if (!connect) return;
  await closeJournal();
  void connectWith(connector, device).catch(() => undefined);
}
