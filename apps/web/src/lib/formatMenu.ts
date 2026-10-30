/**
 * Formatting in the menu an iPhone shows over selected text. The page cannot add to that menu, so
 * while the composer has the focus it hands the app the items (`FormatMenuPlugin` in
 * MeshViewController.swift), and a choice comes back to the composer as from its own menu. Not
 * from when text is selected: a long press builds the menu as it selects the word, before the
 * page hears of it, so the app itself tells selected text from a bare caret. On iOS before 16, on
 * Android and in a browser nothing is offered: the keys still work.
 */

import { t } from "../i18n/index.js";
import { isCapacitor, nativePlatform } from "./platform.js";
import { FORMAT_CHOICES, type FormatChoice } from "./textFormat.js";

interface FormatMenuPlugin {
  set(options: { title?: string; items?: { choice: FormatChoice; title: string }[] }): Promise<void>;
  addListener(event: "pick", listener: (data: { choice: FormatChoice }) => void): Promise<unknown>;
}

/** Whether this shell has the menu to offer formatting in. */
export const nativeFormatMenu = isCapacitor() && nativePlatform() === "ios";

let picked: ((choice: FormatChoice) => void) | null = null;
let offered = false;
// Kept in a box: a promise resolved with the plugin's proxy itself would ask it for `then` and hang.
let plugin: Promise<{ it: FormatMenuPlugin } | null> | null = null;

function load(): Promise<{ it: FormatMenuPlugin } | null> {
  plugin ??= import("@capacitor/core")
    .then(({ registerPlugin }) => {
      const it = registerPlugin<FormatMenuPlugin>("FormatMenu");
      void it.addListener("pick", ({ choice }) => picked?.(choice)).catch(() => undefined);
      return { it };
    })
    .catch(() => null);
  return plugin;
}

/**
 * Offers formatting in the selection menu while `pick` is given, and takes it away with null.
 * The app is told only when that changes.
 */
export function offerFormatMenu(pick: ((choice: FormatChoice) => void) | null): void {
  picked = pick;
  if (!nativeFormatMenu || offered === (pick !== null)) return;
  offered = pick !== null;
  const options = offered ? { title: t("chats.format.menu"), items: FORMAT_CHOICES.map((choice) => ({ choice, title: t(`chats.format.${choice}`) })) } : {};
  void load().then((box) => box?.it.set(options).catch(() => undefined));
}
