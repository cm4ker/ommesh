/**
 * Voices cloned from voice cards (#89), on the desktop: the shell keeps the
 * cards it was handed, works out each voice once with XTTS, and reads a
 * voice message in its sender's own voice when it holds their card. Without
 * the model or the card, the computer's own voices read it instead.
 */

import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { isTauri } from "./platform.js";
import type { VoiceCard } from "./voiceCard.js";

/** A card the shell holds. */
export interface CardEntry {
  speaker: string;
  name: string;
  print: string;
  /** Whether its voice has been worked out, which takes the model. */
  ready: boolean;
}

export interface CloneModel {
  present: boolean;
  bytes: number;
}

let cards: CardEntry[] = [];
let model: CloneModel | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Reads again what the shell holds: the cards and whether the model is here. */
export async function refreshClones(): Promise<void> {
  if (!isTauri()) return;
  try {
    [cards, model] = await Promise.all([invoke<CardEntry[]>("voice_cards"), invoke<CloneModel>("voice_clone_model")]);
  } catch {
    // An older shell, or one without the model's runtime: nothing is cloned.
    cards = [];
    model = null;
  }
  emit();
}

export function useCards(): CardEntry[] {
  return useSyncExternalStore(subscribe, () => cards);
}

export function useCloneModel(): CloneModel | null {
  return useSyncExternalStore(subscribe, () => model);
}

/** Whether a message from this speaker can be read in their own voice here. */
export function canClone(speaker: string): boolean {
  return !!model?.present && cards.some((c) => c.speaker === speaker);
}

export async function downloadCloneModel(progress: (done: number, total: number | null) => void): Promise<void> {
  const stop = await listen<{ done: number; total: number | null }>("voice-clone-progress", (event) => progress(event.payload.done, event.payload.total));
  try {
    await invoke("voice_clone_download");
  } finally {
    stop();
    await refreshClones();
  }
}

export async function deleteCloneModel(): Promise<void> {
  await invoke("voice_clone_delete");
  await refreshClones();
}

/** Keeps a card: ours, made here, or someone's, opened from a file. A newer one of the same speaker replaces theirs. */
export async function keepCard(card: VoiceCard, wav: Uint8Array): Promise<void> {
  await invoke("voice_card_keep", { speaker: card.speaker, name: card.name, print: card.print, text: card.text, wav: Array.from(wav) });
  heard.clear();
  await refreshClones();
}

export async function dropCard(speaker: string): Promise<void> {
  await invoke("voice_card_drop", { speaker });
  heard.clear();
  await refreshClones();
}

/** A card's file as kept, to save it again. */
export async function cardFile(speaker: string): Promise<Uint8Array> {
  return new Uint8Array(await invoke<ArrayBuffer>("voice_card_file", { speaker }));
}

/** What each message sounds like once worked out, by message: XTTS takes about as long as the speech itself. */
const heard = new Map<string, Promise<Float32Array | null>>();
/** The rate XTTS speaks at. */
export const CLONE_RATE = 24_000;

/**
 * A message read in its sender's voice, worked out once and kept for the
 * session; null when it cannot be cloned here. Started as a message comes, so
 * that it is ready by the time someone presses Listen.
 */
export function clonedSpeech(id: string, speaker: string, text: string): Promise<Float32Array | null> {
  const key = `${id}:${text}`;
  let found = heard.get(key);
  if (!found) {
    found = canClone(speaker)
      ? invoke<ArrayBuffer>("voice_clone_speak", { speaker, text })
          .then((bytes) => {
            const view = new DataView(bytes);
            const pcm = new Float32Array(bytes.byteLength / 2);
            for (let i = 0; i < pcm.length; i++) pcm[i] = view.getInt16(i * 2, true) / 32767;
            return pcm;
          })
          .catch(() => null)
      : Promise.resolve(null);
    heard.set(key, found);
  }
  return found;
}

void refreshClones();
