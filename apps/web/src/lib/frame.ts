/**
 * The desktop window's frame, drawn by the page as in VS Code: a title bar in
 * the theme's colours instead of the system's. On Windows and Linux the bar
 * carries the window's own buttons; on macOS the traffic lights stay, laid
 * over the bar by the shell (`tauri.macos.conf.json`), and the bar leaves
 * room for them.
 *
 * Windows 11 still draws the window's thin edge, its rounded corners and its
 * shadow, and takes the edge's colour from the shell (`frame.rs`): the
 * theme's accent while the window is in front. Linux has no edge of the
 * system's around a window without a frame, so the page draws one, in the
 * same colours (styles/frame.css).
 */

import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isTauri } from "./platform.js";
import { getActiveTheme, subscribeTheme } from "../theme/store.js";

export type FrameKind = "windows" | "macos" | "linux";

/** Which frame the page draws, or null where the window has the system's (a browser tab, a phone). */
export function frameKind(): FrameKind | null {
  if (!isTauri()) return null;
  const agent = navigator.userAgent;
  if (/Macintosh|Mac OS X/.test(agent)) return "macos";
  if (/Windows/.test(agent)) return "windows";
  return "linux";
}

export interface WindowState {
  focused: boolean;
  maximized: boolean;
}

let state: WindowState = { focused: true, maximized: false };
const listeners = new Set<() => void>();

function set(next: Partial<WindowState>): void {
  const merged = { ...state, ...next };
  if (merged.focused === state.focused && merged.maximized === state.maximized) return;
  state = merged;
  document.documentElement.classList.toggle("window-away", !state.focused);
  document.documentElement.classList.toggle("window-maximized", state.maximized);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Whether the window is in front, and whether it fills the screen: the bar dims behind, and its middle button turns. */
export function useWindowState(): WindowState {
  return useSyncExternalStore(subscribe, () => state);
}

/** A colour as `#rrggbb`, whatever way the theme wrote it, through a canvas, which says it so. */
function hex(color: string): string {
  const context = document.createElement("canvas").getContext("2d");
  if (!context) return color;
  context.fillStyle = color;
  return String(context.fillStyle);
}

function tellColors(): void {
  const { tokens } = getActiveTheme();
  void invoke("frame_colors", { active: hex(tokens.accent), inactive: hex(tokens.borderStrong) }).catch(() => undefined);
}

/**
 * Before the first render: the page makes room for its bar from the first
 * paint, and the window's edge takes the theme's colours, then follows them.
 */
export function initFrame(): void {
  const kind = frameKind();
  if (!kind) return;
  const root = document.documentElement;
  root.classList.add("framed");
  root.dataset["frame"] = kind;

  tellColors();
  subscribeTheme(tellColors);

  const window = getCurrentWindow();
  void window.isFocused().then((focused) => set({ focused }), () => undefined);
  void window.isMaximized().then((maximized) => set({ maximized }), () => undefined);
  void window.onFocusChanged(({ payload }) => set({ focused: payload }));
  void window.onResized(() => {
    void window.isMaximized().then((maximized) => set({ maximized }), () => undefined);
  });
}

export function minimizeWindow(): void {
  void getCurrentWindow().minimize();
}

export function toggleMaximized(): void {
  void getCurrentWindow().toggleMaximize();
}

/** The close button: the shell hides the window to the tray where there is one, as with the system's button. */
export function closeWindow(): void {
  void getCurrentWindow().close();
}
