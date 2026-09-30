/**
 * The app's signal (noticePrefs `signal`), played where the app itself
 * plays it: with its own notices, and on a computer with every notice, since
 * a Windows toast from an app without a package can only take the system's
 * own sounds. A system notice on a phone carries the signal itself (its
 * channel on Android, its sound file on iOS), so nothing plays it here.
 *
 * Each shell plays it the way that respects the system's quiet: the desktop
 * shell stays silent in a full-screen game, a presentation or Do not disturb;
 * Android plays it on the notification stream, which the ringer mode and Do
 * not disturb silence; iOS plays it as an alert sound, which the silent
 * switch turns into a vibration.
 */

import { invoke } from "@tauri-apps/api/core";
import { withNotices, withWatch } from "./nativeNotices.js";
import type { Signal } from "./noticePrefs.js";
import { shell } from "./platform.js";

/** Where the page finds a signal's sound. */
export function signalUrl(signal: Exclude<Signal, "none">): string {
  return `./sounds/signal_${signal}.wav`;
}

/** The file a native shell finds it by: iOS in Library/Sounds, Android as a raw resource by its name without the extension. */
export function signalFile(signal: Signal): string | null {
  return signal === "none" ? null : `signal_${signal}.wav`;
}

/** Plays the signal for a notice the app shows itself, unless the system is keeping quiet. */
export async function chime(signal: Signal): Promise<void> {
  if (signal === "none") return;
  try {
    switch (shell()) {
      case "tauri":
        await invoke("chime", { signal });
        return;
      case "capacitor":
        await withWatch((w) => w.chime({ signal }));
        await withNotices((n) => n.chime({ signal }));
        return;
      default:
        await new Audio(signalUrl(signal)).play();
    }
  } catch {
    // A sound that cannot play leaves the notice as it is.
  }
}

/** What a coverage survey says after an ask: somebody answered, or nobody did (`CUES` in `scripts/sound-synth.mjs`). */
export type Cue = "heard" | "unheard";

/**
 * Plays a survey's cue. A phone plays it as it plays the signal, so its
 * silent mode quiets this too. A computer plays it from the page: the survey
 * is on screen there, and started by the reader's own click.
 */
export async function cue(which: Cue): Promise<void> {
  try {
    if (shell() === "capacitor") {
      await withWatch((w) => w.chime({ signal: which }));
      await withNotices((n) => n.chime({ signal: which }));
    } else {
      await new Audio(`./sounds/signal_${which}.wav`).play();
    }
  } catch {
    // A cue that cannot play leaves the survey as it is.
  }
}

let previewing: HTMLAudioElement | null = null;

/** Lets the reader hear a signal while choosing one: from the page, at the media volume, whatever the system's quiet. */
export function previewSignal(signal: Signal): void {
  previewing?.pause();
  previewing = null;
  if (signal === "none") return;
  previewing = new Audio(signalUrl(signal));
  void previewing.play().catch(() => undefined);
}
