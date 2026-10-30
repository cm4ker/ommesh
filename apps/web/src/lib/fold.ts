/**
 * The fold of a phone that opens like a book (iPhone Duo). Opened, its inner screen is wide enough
 * for the list and the chat side by side, and the fold runs down its middle. The app
 * (`FoldPlugin` in MeshViewController.swift) says where the fold lies across the page, margins
 * included, and the wide layout puts the line between the list and the chat on it
 * (styles/workspace.css), so nothing a finger reaches for sits in the crease. Without a fold, in a
 * browser and in an app from before this, nothing is set.
 */

import { isCapacitor, nativePlatform } from "./platform.js";

interface Fold {
  start: number;
  end: number;
}

interface FoldPlugin {
  get(): Promise<{ fold?: Fold }>;
  addListener(event: "change", listener: (data: { fold?: Fold }) => void): Promise<unknown>;
}

function apply(fold: Fold | undefined): void {
  const root = document.documentElement;
  root.classList.toggle("on-fold", fold !== undefined);
  if (fold) {
    root.style.setProperty("--fold-start", `${fold.start}px`);
    root.style.setProperty("--fold-end", `${fold.end}px`);
  } else {
    root.style.removeProperty("--fold-start");
    root.style.removeProperty("--fold-end");
  }
}

/** Follows the fold for as long as the page lives: it moves as the phone opens, closes and turns. */
export function watchFold(): void {
  if (!isCapacitor() || nativePlatform() !== "ios") return;
  void import("@capacitor/core")
    .then(({ registerPlugin }) => {
      const plugin = registerPlugin<FoldPlugin>("Fold");
      void plugin.addListener("change", ({ fold }) => apply(fold)).catch(() => undefined);
      void plugin.get().then(({ fold }) => apply(fold)).catch(() => undefined);
    })
    .catch(() => undefined);
}
