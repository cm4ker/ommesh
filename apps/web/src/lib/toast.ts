/**
 * A short note at the bottom of the screen for what an action did: one at a
 * time, a line and at most a smaller second one, and a button such as Undo.
 */

import { useSyncExternalStore } from "react";
import { errorText } from "../i18n/errors.js";

export interface Toast {
  id: number;
  text: string;
  tone: "" | "error";
  /** A button in the toast, such as Undo; the toast stays longer for it. */
  action?: { label: string; run: () => void } | undefined;
  /** A smaller second line: the detail behind the first. */
  detail?: string | undefined;
  /** How long it stays, ms: the action's countdown runs over it. */
  ms: number;
}

let current: Toast | null = null;
let next = 1;
let timer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function toast(text: string, tone: Toast["tone"] = "", action?: Toast["action"], detail?: string): void {
  const ms = action ? 8000 : tone === "error" ? 5000 : 2800;
  current = { id: next++, text, tone, action, detail, ms };
  if (timer) clearTimeout(timer);
  timer = setTimeout(dismissToast, ms);
  emit();
}

export function dismissToast(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  current = null;
  emit();
}

export function useToast(): Toast | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
  );
}

/** The gap between the toast and what it sits by, px. */
const GAP = 8;
/** What the top of the screen keeps for a phone's status bar, px. */
const TOP_ROOM = 56;

/** Where the toast goes: this far from the bottom, px, or the top of the screen. */
export type ToastSpot = { bottom: number } | "top";

/**
 * Where the toast sits, from what is on the screen. Over an open sheet it goes above the sheet,
 * onto the dimmed page, so it covers none of the rows it is about; a sheet too tall to leave
 * room there sends it to the top of the screen. Else it goes just above a field being typed in
 * at the bottom of the screen (a chat, a console), so it covers no message. Null leaves it
 * where the stylesheet puts it, above the tab bar. Tops and heights are px.
 */
export function toastSpot(screen: { height: number; toast: number; sheetTop: number | null; fieldTop: number | null }): ToastSpot | null {
  const { height, toast, sheetTop, fieldTop } = screen;
  if (sheetTop !== null) return sheetTop - GAP - toast >= TOP_ROOM ? { bottom: height - sheetTop + GAP } : "top";
  if (fieldTop !== null) return { bottom: height - fieldTop + GAP };
  return null;
}

/** Runs an action, says what it did, or why it failed. */
export async function act(action: () => Promise<unknown>, done?: string): Promise<boolean> {
  try {
    await action();
    if (done) toast(done);
    return true;
  } catch (error) {
    toast(errorText(error), "error");
    return false;
  }
}
