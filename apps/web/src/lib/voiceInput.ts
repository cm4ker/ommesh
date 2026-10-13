/**
 * Voice input (#89): a microphone beside the message field in every chat.
 * What is said is written into the field phrase by phrase while it is said,
 * recognised on this device by Whisper (`crates/speech`), and sent as an
 * ordinary message once the writer has looked it over. The sound goes from
 * the microphone to the recogniser in memory and is forgotten once heard.
 *
 * Settings › Messages › Voice input turns it on and fetches a model. The
 * desktop shell hears; a browser has no recogniser, except with the demo
 * radio, where the microphone "hears" set lines so that the screens can be
 * tried.
 */

import { useEffect, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { language } from "../i18n/index.js";
import { isTauri } from "./platform.js";
import { speechOnly } from "./speechOnly.js";
import { readSetting, writeSetting } from "./storage.js";

/** The recognition models there are (`crates/speech/src/models.rs`). */
export type VoiceModel = "small" | "base";

export interface VoiceInputPrefs {
  on: boolean;
  model: VoiceModel;
}

/** The key voice messages kept their settings under: a model picked then stays picked. */
const KEY = "meshnet.voice";
const DEFAULTS: VoiceInputPrefs = { on: false, model: "small" };

function load(): VoiceInputPrefs {
  const saved = readSetting<Partial<VoiceInputPrefs>>(KEY, {});
  return { on: saved.on === true, model: saved.model === "base" ? "base" : "small" };
}

let prefs = load();
/** Whether the picked model is here to hear with; null until asked. */
let ready: boolean | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useVoiceInputPrefs(): VoiceInputPrefs {
  return useSyncExternalStore(subscribe, () => prefs);
}

export function setVoiceInputPrefs(patch: Partial<VoiceInputPrefs>): void {
  prefs = { ...prefs, ...patch };
  writeSetting(KEY, { ...DEFAULTS, ...prefs });
  if (patch.on === false && isTauri()) void invoke("speech_unload").catch(() => undefined);
  if (patch.model) void refreshReady();
  emit();
}

/** Whether this app can hear speech at all: the desktop shell, or a browser trying the demo radio. */
export function voiceInputAvailable(): boolean {
  return isTauri() || demo();
}

function demo(): boolean {
  return !isTauri() && (import.meta.env.DEV || new URLSearchParams(window.location.search).has("demo"));
}

/**
 * Whether the message field shows the microphone: voice input on, and the
 * picked model downloaded. Asked of the shell once, then kept up to date by
 * downloads and deletions here.
 */
export function useVoiceInputReady(): boolean {
  const { on } = useVoiceInputPrefs();
  useEffect(() => {
    if (on && ready === null) void refreshReady();
  }, [on]);
  return useSyncExternalStore(subscribe, () => prefs.on && voiceInputAvailable() && ready === true);
}

let asking: Promise<void> | null = null;

function refreshReady(): Promise<void> {
  asking ??= voiceModels()
    .then((models) => {
      ready = models.some((m) => m.id === prefs.model && m.present);
    })
    .catch(() => {
      ready = false;
    })
    .finally(() => {
      asking = null;
      emit();
    });
  return asking;
}

// ---- models ----

export interface ModelInfo {
  id: VoiceModel;
  /** The model's size once here; before, what is left to fetch. */
  bytes: number;
  present: boolean;
}

/** What the shell has of the models; in a browser's demo, both already there. */
export async function voiceModels(): Promise<ModelInfo[]> {
  if (!isTauri()) return [{ id: "small", bytes: 190_085_487, present: true }, { id: "base", bytes: 59_707_625, present: true }];
  return invoke<ModelInfo[]>("speech_models");
}

/** Fetches a model and the voice detector with it, telling `progress` how far it has got. */
export async function downloadVoiceModel(id: VoiceModel, progress: (done: number, total: number) => void): Promise<void> {
  if (!isTauri()) return;
  const stop = await listen<{ model: string; done: number; total: number }>("speech-model-progress", (event) => {
    if (event.payload.model === id) progress(event.payload.done, event.payload.total);
  });
  try {
    await invoke("speech_model_download", { id });
  } finally {
    stop();
    await refreshReady();
  }
}

export async function deleteVoiceModel(id: VoiceModel): Promise<void> {
  try {
    if (isTauri()) await invoke("speech_model_delete", { id });
  } finally {
    await refreshReady();
  }
}

// ---- listening ----

export interface ListenOptions {
  /** What the field holds before the caret: a clue to how the text goes on. */
  before: string;
  /** A phrase heard, to be written in. */
  onPhrase: (text: string) => void;
  /** A long quiet: the microphone may go off. */
  onQuiet: () => void;
  /** Hearing failed; the microphone is off. */
  onError: (error: unknown) => void;
}

/** One turn of the microphone. */
export interface Listening {
  /** How loud it is now, 0 to 1. */
  level(): number;
  /** Someone is speaking, or a phrase is being heard. */
  speaking(): boolean;
  /** Off, once what was said last is written in. */
  stop(): Promise<void>;
  /** Off at once, and what is not heard yet is dropped. */
  cancel(): void;
}

/** Turns the microphone on. Rejects when there is no microphone or no model. */
export function startListening(options: ListenOptions): Promise<Listening> {
  return isTauri() ? listenDesktop(options) : listenDemo(options);
}

/** How often the sound recorded goes to the shell: often enough that the text keeps close behind. */
const FEED_MS = 250;

interface Fed {
  phrases: string[];
  speaking: boolean;
  ended: boolean;
}

async function listenDesktop(options: ListenOptions): Promise<Listening> {
  const started = invoke("speech_start", { model: prefs.model, language: language(), before: options.before });
  let mic: Microphone;
  try {
    mic = await openMicrophone();
  } catch (error) {
    void started.then(() => invoke("speech_cancel")).catch(() => undefined);
    throw error;
  }
  try {
    await started;
  } catch (error) {
    mic.close();
    throw error;
  }
  let speaking = false;
  let over = false;
  const put = (phrases: string[]) => {
    for (const phrase of phrases) {
      const text = speechOnly(phrase);
      if (text) options.onPhrase(text);
    }
  };
  // One call at a time, in order, so that phrases come back as they were said.
  let chain = Promise.resolve();
  const send = () => {
    const samples = mic.take();
    if (!samples) return chain;
    chain = chain.then(async () => {
      if (over) return;
      try {
        const fed = await invoke<Fed>("speech_feed", { samples: Array.from(samples) });
        speaking = fed.speaking;
        put(fed.phrases);
        if (fed.ended) options.onQuiet();
      } catch (error) {
        end();
        void invoke("speech_cancel").catch(() => undefined);
        options.onError(error);
      }
    });
    return chain;
  };
  const timer = setInterval(() => void send(), FEED_MS);
  const end = () => {
    over = true;
    clearInterval(timer);
    mic.close();
  };
  return {
    level: () => mic.level(),
    speaking: () => speaking,
    async stop() {
      if (over) return;
      clearInterval(timer);
      mic.close();
      await send();
      if (over) return;
      over = true;
      put(await invoke<string[]>("speech_finish"));
    },
    cancel() {
      if (over) return;
      end();
      void invoke("speech_cancel").catch(() => undefined);
    },
  };
}

interface Microphone {
  /** The sound recorded since the last call; null for none. */
  take(): Float32Array | null;
  level(): number;
  close(): void;
}

/**
 * The microphone, mono, at the 16 kHz Whisper hears: the browser resamples.
 * The sound is kept only until it is handed on.
 */
async function openMicrophone(): Promise<Microphone> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  const context = new AudioContext({ sampleRate: 16_000 });
  const source = context.createMediaStreamSource(stream);
  // A ScriptProcessor rather than a worklet: a worklet needs a module of its own, and this is a few chunks a second.
  const processor = context.createScriptProcessor(2048, 1, 1);
  let chunks: Float32Array[] = [];
  let loud = 0;
  let closed = false;
  processor.onaudioprocess = (event) => {
    if (closed) return;
    const input = event.inputBuffer.getChannelData(0);
    chunks.push(new Float32Array(input));
    let peak = 0;
    for (const s of input) peak = Math.max(peak, Math.abs(s));
    loud = peak;
  };
  source.connect(processor);
  processor.connect(context.destination);
  return {
    take() {
      if (!chunks.length) return null;
      const all = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
      let at = 0;
      for (const chunk of chunks) {
        all.set(chunk, at);
        at += chunk.length;
      }
      chunks = [];
      return all;
    },
    level: () => (closed ? 0 : loud),
    close() {
      if (closed) return;
      closed = true;
      processor.disconnect();
      source.disconnect();
      for (const track of stream.getTracks()) track.stop();
      void context.close();
    },
  };
}

/** Lines the demo hears in place of speech, a phrase every few seconds. */
const DEMO_SPEECH: Record<string, string[]> = {
  ru: ["Буду у вышки через десять минут.", "Возьми запасную батарею.", "Как слышно, приём?"],
  en: ["I'll be at the tower in ten minutes.", "Bring the spare battery.", "How do you read me, over?"],
};

async function listenDemo(options: ListenOptions): Promise<Listening> {
  const lines = DEMO_SPEECH[language()] ?? DEMO_SPEECH.en!;
  let said = 0;
  let over = false;
  const started = Date.now();
  const timer = setInterval(() => {
    if (said < lines.length) options.onPhrase(lines[said++]!);
    else options.onQuiet();
  }, 2500);
  const end = () => {
    over = true;
    clearInterval(timer);
  };
  return {
    level: () => (over ? 0 : 0.15 + 0.25 * Math.abs(Math.sin((Date.now() - started) / 180))),
    speaking: () => !over,
    async stop() {
      end();
    },
    cancel: end,
  };
}
