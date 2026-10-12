/**
 * Voice messages (#89), an experiment on the desktop alone: Settings ›
 * Experimental features › Voice. What is said is recognised on this computer
 * (Whisper, in the shell), sent as text packed small into the public channel
 * #voice, and read out on the listener's computer in the voice its sender
 * asked for. The heavy parts (the dictionary, the model) live in the shell,
 * which is why a phone does not offer it yet.
 *
 * The demo radio speaks voice too, so the screens can be tried in a browser:
 * there the text goes unpacked, and only to the demo radio.
 */

import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { VoiceGender, type ChannelRecord, type SessionState, type VoicePacker } from "@meshnet/meshcore";
import { hashtagSecret } from "./channels.js";
import { speechOnly } from "./speechOnly.js";
import { isTauri } from "./platform.js";
import { session } from "./session.js";
import { readSetting, writeSetting } from "./storage.js";

/** The one channel voice messages go to while they are tried. */
export const VOICE_CHANNEL = "#voice";
/** The longest a recording runs before it stops by itself, seconds. */
export const VOICE_MAX_SECONDS = 30;
/** The demo radio's name: the only one a browser sends voice to. */
const DEMO_RADIO = "MeshCore-demo";

/** The recognition models the shell can fetch (`voice.rs`). */
export type VoiceModel = "small" | "base";

export interface VoicePrefs {
  on: boolean;
  /** The recognised text waits in the field to be checked before it goes. */
  review: boolean;
  /** Voice messages are read out by a tap, or as soon as they come. */
  readAloud: "tap" | "auto";
  /** How others should hear us. */
  gender: VoiceGender;
  model: VoiceModel;
  /** Our last announce, per radio key: when, and with which voice. */
  announced: Record<string, { at: number; gender: VoiceGender }>;
}

const KEY = "meshnet.voice";
const DEFAULTS: VoicePrefs = { on: false, review: true, readAloud: "tap", gender: VoiceGender.Any, model: "small", announced: {} };

let prefs: VoicePrefs = { ...DEFAULTS, ...readSetting<Partial<VoicePrefs>>(KEY, {}) };
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useVoicePrefs(): VoicePrefs {
  return useSyncExternalStore(subscribe, () => prefs);
}

export function getVoicePrefs(): VoicePrefs {
  return prefs;
}

export function setVoicePrefs(patch: Partial<VoicePrefs>): void {
  prefs = { ...prefs, ...patch };
  writeSetting(KEY, prefs);
  session.setVoicePacker(prefs.on && voiceAvailable() ? packer : null);
  if (patch.on === false && isTauri()) void invoke("voice_unload").catch(() => undefined);
  emit();
}

/** Whether this app can make voice messages at all: the desktop shell, or a browser trying the demo radio. */
export function voiceAvailable(): boolean {
  return isTauri() || import.meta.env.DEV || new URLSearchParams(window.location.search).has("demo");
}

/** Whether the radio on the link is the demo one, which a browser may send unpacked text to. */
function onDemoRadio(): boolean {
  return session.getState().link?.label === DEMO_RADIO;
}

/**
 * Packs and unpacks a part's text: zstd and the dictionary in the shell; in
 * a browser, plain UTF-8 to the demo radio and nothing to a real one, which
 * would hear text that no Ommesh could read.
 */
const packer: VoicePacker = {
  async pack(text) {
    if (isTauri()) return new Uint8Array(await invoke<number[]>("voice_pack", { text }));
    if (!onDemoRadio()) throw new Error("voice messages are made on the desktop app");
    return new TextEncoder().encode(text);
  },
  async unpack(data) {
    if (isTauri()) return invoke<string>("voice_unpack", { data: Array.from(data) });
    if (!onDemoRadio()) throw new Error("voice messages are read on the desktop app");
    return new TextDecoder("utf-8", { fatal: true }).decode(data);
  },
};

/** The packer the demo radio packs its own voice messages with, so they read as the app reads them. */
export function voicePacker(): VoicePacker {
  return packer;
}

session.setVoicePacker(prefs.on && voiceAvailable() ? packer : null);

// ---- the channel ----

/** The radio's #voice, told by its key: a rename keeps it. */
export function voiceChannel(state: Pick<SessionState, "channels">): ChannelRecord | null {
  const secret = hashtagSecret(VOICE_CHANNEL);
  return state.channels.find((c) => c.secret.toLowerCase() === secret) ?? null;
}

// ---- recognition ----

export interface ModelInfo {
  id: VoiceModel;
  file: string;
  bytes: number;
  present: boolean;
}

/** What the shell has of the recognition models; in a browser, a pretend one already there. */
export async function voiceModels(): Promise<ModelInfo[]> {
  if (!isTauri()) return [{ id: "small", file: "demo", bytes: 0, present: true }, { id: "base", file: "demo", bytes: 0, present: true }];
  return invoke<ModelInfo[]>("voice_models");
}

/** Fetches a model, telling `progress` how far it has got. */
export async function downloadVoiceModel(id: VoiceModel, progress: (done: number, total: number | null) => void): Promise<void> {
  if (!isTauri()) return;
  const stop = await listen<{ model: string; done: number; total: number | null }>("voice-model-progress", (event) => {
    if (event.payload.model === id) progress(event.payload.done, event.payload.total);
  });
  try {
    await invoke("voice_model_download", { id });
  } finally {
    stop();
  }
}

export async function deleteVoiceModel(id: VoiceModel): Promise<void> {
  if (isTauri()) await invoke("voice_model_delete", { id });
}

/** The model last found on disk, so that each recording does not ask the shell again. */
let found: VoiceModel | null = null;

/** Whether the model picked is here to recognise with; a browser's demo needs none. */
export async function modelReady(): Promise<boolean> {
  if (!isTauri() || found === prefs.model) return true;
  const models = await voiceModels().catch(() => []);
  const here = models.some((m) => m.id === prefs.model && m.present);
  if (here) found = prefs.model;
  return here;
}

/** Lines the demo hears in place of speech: a browser has no model. */
const DEMO_SPEECH = ["Буду у вышки через десять минут, возьми запасную батарею.", "Слышу хорошо, приём.", "Проверка голоса в канале, как слышно?"];
let demoSpeech = 0;

/** What was said, from 16 kHz samples; empty for silence. */
export async function transcribe(samples: Float32Array): Promise<string> {
  if (!isTauri()) return DEMO_SPEECH[demoSpeech++ % DEMO_SPEECH.length]!;
  return speechOnly(await invoke<string>("voice_transcribe", { id: prefs.model, samples: Array.from(samples) }));
}

// ---- recording ----

export interface Recording {
  /** Seconds recorded so far. */
  seconds(): number;
  /** How loud it is now, 0 to 1, for the dot to pulse with. */
  level(): number;
  stop(): Promise<{ samples: Float32Array; seconds: number }>;
  cancel(): void;
}

/**
 * Records from the microphone at 16 kHz, mono, the way Whisper hears. The
 * browser resamples; the samples are kept as they come, in memory only.
 */
export async function startRecording(onLimit: () => void): Promise<Recording> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  const context = new AudioContext({ sampleRate: 16_000 });
  const source = context.createMediaStreamSource(stream);
  // A ScriptProcessor rather than a worklet: a worklet needs a module of its own, and this is a few seconds of audio.
  const processor = context.createScriptProcessor(4096, 1, 1);
  const chunks: Float32Array[] = [];
  let count = 0;
  let loud = 0;
  let stopped = false;
  processor.onaudioprocess = (event) => {
    if (stopped) return;
    const input = event.inputBuffer.getChannelData(0);
    chunks.push(new Float32Array(input));
    count += input.length;
    let peak = 0;
    for (const s of input) peak = Math.max(peak, Math.abs(s));
    loud = peak;
    if (count >= VOICE_MAX_SECONDS * context.sampleRate) onLimit();
  };
  source.connect(processor);
  processor.connect(context.destination);
  const close = () => {
    stopped = true;
    processor.disconnect();
    source.disconnect();
    for (const track of stream.getTracks()) track.stop();
    void context.close();
  };
  return {
    seconds: () => count / context.sampleRate,
    level: () => loud,
    async stop() {
      close();
      const samples = new Float32Array(count);
      let at = 0;
      for (const chunk of chunks) {
        samples.set(chunk, at);
        at += chunk.length;
      }
      return { samples, seconds: count / context.sampleRate };
    },
    cancel: close,
  };
}

// ---- reading out ----

/** Which message is being read out, and the letter it has got to. */
export interface Speaking {
  id: string;
  at: number;
}

let speaking: Speaking | null = null;
const speakingListeners = new Set<() => void>();

function setSpeaking(next: Speaking | null): void {
  speaking = next;
  for (const listener of speakingListeners) listener();
}

export function useSpeaking(): Speaking | null {
  return useSyncExternalStore(
    (listener) => {
      speakingListeners.add(listener);
      return () => speakingListeners.delete(listener);
    },
    () => speaking,
  );
}

/** The voices this computer has for Russian, the ones named for a man told apart: the system says no more. */
function russianVoice(gender: VoiceGender): SpeechSynthesisVoice | null {
  const voices = speechSynthesis.getVoices().filter((v) => v.lang.toLowerCase().startsWith("ru"));
  if (!voices.length) return null;
  const male = (v: SpeechSynthesisVoice) => /pavel|dmitr|yuri|maxim|павел|дмитр|юри|максим/i.test(v.name);
  const local = (list: SpeechSynthesisVoice[]) => list.find((v) => v.localService) ?? list[0] ?? null;
  if (gender === VoiceGender.Male) return local(voices.filter(male)) ?? local(voices);
  if (gender === VoiceGender.Female) return local(voices.filter((v) => !male(v))) ?? local(voices);
  return local(voices);
}

/** Whether this computer can read Russian aloud at all. */
export function canSpeak(): boolean {
  return typeof speechSynthesis !== "undefined" && speechSynthesis.getVoices().some((v) => v.lang.toLowerCase().startsWith("ru"));
}

/** Reads a message out; a second call for the same one stops it. */
export function speak(id: string, text: string, gender: VoiceGender): void {
  if (typeof speechSynthesis === "undefined") return;
  const again = speaking?.id === id;
  speechSynthesis.cancel();
  if (again) {
    setSpeaking(null);
    return;
  }
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = "ru-RU";
  const voice = russianVoice(gender);
  if (voice) utterance.voice = voice;
  utterance.onboundary = (event) => {
    if (event.name === "word" && speaking?.id === id) setSpeaking({ id, at: event.charIndex });
  };
  const done = () => {
    if (speaking?.id === id) setSpeaking(null);
  };
  utterance.onend = done;
  utterance.onerror = done;
  setSpeaking({ id, at: 0 });
  speechSynthesis.speak(utterance);
}

export function stopSpeaking(): void {
  if (typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
  setSpeaking(null);
}

/** The Russian voices' names, once the system has listed them: the list fills in a moment after the page loads. */
export function useRussianVoices(): string {
  return useSyncExternalStore(
    (listener) => {
      if (typeof speechSynthesis === "undefined") return () => undefined;
      speechSynthesis.addEventListener("voiceschanged", listener);
      return () => speechSynthesis.removeEventListener("voiceschanged", listener);
    },
    () =>
      typeof speechSynthesis === "undefined"
        ? ""
        : speechSynthesis
            .getVoices()
            .filter((v) => v.lang.toLowerCase().startsWith("ru"))
            .map((v) => v.name)
            .join(", "),
  );
}

// Read out as they come, when the settings ask for it: a moment after the first part, so that the
// rest of a short message joins it, and never over one already being read.
session.onReceived((message) => {
  if (!message.voice || !prefs.on || prefs.readAloud !== "auto") return;
  setTimeout(() => {
    const state = session.getState();
    const now = state.messages.find((m) => m.id === message.id);
    if (!now?.voice || speaking) return;
    speak(now.id, now.text, state.voicePeers[now.voice.speaker]?.gender ?? VoiceGender.Any);
  }, 2500);
});
