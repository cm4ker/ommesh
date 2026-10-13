/**
 * The radio's key on this device: saving it to a file, and what is known of
 * it for each radio, kept by radio like the pins. When it was last saved
 * shows under the save row and in the factory reset's question; whether the
 * firmware refused to give it greys the row out. Nothing of it reaches the
 * radio. The file itself is `keyFile.ts`.
 */

import { useSyncExternalStore } from "react";
import { keyFileName, writeKeyFile } from "./keyFile.js";
import { saveFile } from "./saveFile.js";
import { session } from "./session.js";
import { readSetting, writeSetting } from "./storage.js";
import { toast } from "./toast.js";
import { t } from "../i18n/index.js";
import { errorText } from "../i18n/errors.js";

export interface KeyNote {
  /** When the key was last saved to a file, ms. */
  saved?: number;
  /** The firmware answered that it does not give its key out. */
  closed?: boolean;
}

const KEY = "meshnet.radioKeys";
const NONE: KeyNote = {};
let notes = readSetting<Record<string, KeyNote>>(KEY, {});
const listeners = new Set<() => void>();

function note(radio: string, patch: KeyNote): void {
  notes = { ...notes, [radio]: { ...notes[radio], ...patch } };
  writeSetting(KEY, notes);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useKeyNote(radio: string | undefined): KeyNote {
  return useSyncExternalStore(subscribe, () => (radio ? notes[radio] : undefined) ?? NONE);
}

/**
 * Saves the connected radio's key to a file, through the share sheet on a
 * phone. False when nothing was saved: the firmware keeps its key, the share
 * sheet was put away, or it failed; each but the second is told.
 */
export async function saveKey(): Promise<boolean> {
  const self = session.getState().self;
  if (!self) return false;
  try {
    const privateKey = await session.exportKey();
    if (!privateKey) {
      note(self.key, { closed: true });
      toast(t("radio.key.closed"), "error");
      return false;
    }
    const now = Date.now();
    const name = keyFileName(self.name, now);
    const file = writeKeyFile(self, privateKey, `Ommesh ${__APP_VERSION__}`, now);
    const how = await saveFile(name, `${JSON.stringify(file, null, 2)}\n`, "application/json", t("radio.key.shareTitle"));
    if (how === "cancelled") return false;
    note(self.key, { saved: now, closed: false });
    if (how === "downloaded") toast(t("radio.key.downloaded"), "", undefined, name);
    return true;
  } catch (error) {
    toast(errorText(error), "error");
    return false;
  }
}

let awaited: string | null = null;
let watching = false;

/**
 * Says so once the link that comes back after the radio took a key finds it
 * holding that key, and so with the chats that are that key's.
 */
export function awaitKey(publicKey: string): void {
  awaited = publicKey;
  if (watching) return;
  watching = true;
  session.subscribe(() => {
    const state = session.getState();
    if (!awaited || state.status !== "ready" || state.self?.key !== awaited) return;
    awaited = null;
    toast(t("radio.key.back", { name: state.self.name }));
  });
}
