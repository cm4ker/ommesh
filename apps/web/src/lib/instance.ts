/**
 * Which copy of the desktop app this is (#12). The shell runs several at
 * once, each with a radio of its own, numbers them from 1 and tells the page
 * its number before any of the page's code runs (`instance.rs`). Copies share
 * `localStorage`; what has to stay apart (the remembered link, the open
 * screens) is kept under the setting's own name by the first copy, so a single
 * window reads what it always did, and with the copy's number after it by any
 * other. In a browser and on a phone there is only the one.
 */

import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "./platform.js";

export function copyNumber(): number {
  const number = (globalThis as { __OMMESH_COPY__?: unknown }).__OMMESH_COPY__;
  return typeof number === "number" && Number.isInteger(number) && number > 1 ? number : 1;
}

/** A setting's name for this copy alone. */
export function ownKey(key: string, copy = copyNumber()): string {
  return copy === 1 ? key : `${key}@${copy}`;
}

/** Whether one more copy can be opened here, for another radio. */
export function canOpenAnother(): boolean {
  return isTauri();
}

export async function openAnother(): Promise<void> {
  await invoke("desktop_open_another");
}
