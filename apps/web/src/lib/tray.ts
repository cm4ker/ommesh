/**
 * The desktop's icon by the clock (`tray.rs`) carries a dot while anything is
 * unread, coloured by whether a person is waiting or only channels and rooms,
 * and the window's taskbar button carries the count. The page counts and says
 * it, in the reader's language; the shell draws, but for Windows' taskbar
 * badge, which the page draws too, having the fonts.
 */

import { invoke } from "@tauri-apps/api/core";
import type { SessionState } from "@meshnet/meshcore";
import { language, subscribeLanguage, t } from "../i18n/index.js";
import { isDirect } from "./noticePrefs.js";
import { shell } from "./platform.js";

export interface UnreadSplit {
  /** Messages from people. */
  direct: number;
  /** Messages in channels and rooms. */
  chats: number;
}

export function unreadSplit(state: SessionState): UnreadSplit {
  const split = { direct: 0, chats: 0 };
  for (const [conversation, count] of Object.entries(state.unread)) {
    if (count <= 0) continue;
    if (isDirect(state, conversation)) split.direct += count;
    else split.chats += count;
  }
  return split;
}

/** The tooltip's count after the app's name: "2 from people, 5 in chats". */
export function unreadDetail({ direct, chats }: UnreadSplit): string {
  if (direct && chats) return t("notices.tray.both", { people: direct, chats });
  if (direct) return t("notices.tray.people", { count: direct });
  if (chats) return t("notices.tray.chats", { count: chats });
  return "";
}

/** What the taskbar's badge reads: the count, while it fits in two digits. */
export function badgeText(count: number): string {
  return count > 99 ? "99+" : String(count);
}

/** The tray's dot colours (`tray.rs`), which the taskbar's badge takes too, each with an ink that reads on it. */
const BADGE = {
  direct: { fill: "rgb(229 72 77)", ink: "rgb(255 255 255)" },
  chats: { fill: "rgb(245 165 36)", ink: "rgb(32 24 8)" },
};

/**
 * The taskbar button's badge on Windows as base64 PNG (no `data:` prefix): the
 * whole count in a circle, red while a person waits, amber for channels and
 * rooms only. Null while nothing is unread, or where the page has no canvas.
 *
 * Windows shows it at the size of a small icon, 16 pixels at 100% and more on
 * a denser screen, so it is drawn at that size for a sharp picture.
 */
export function badgePng({ direct, chats }: UnreadSplit): string | null {
  const count = direct + chats;
  if (!count || typeof document === "undefined") return null;
  const size = Math.round(16 * Math.min(4, Math.max(1, globalThis.devicePixelRatio || 1)));
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const g = canvas.getContext("2d");
  if (!g) return null;
  const colours = direct ? BADGE.direct : BADGE.chats;
  g.fillStyle = colours.fill;
  g.beginPath();
  g.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
  g.fill();

  const text = badgeText(count);
  const px = size * (text.length === 1 ? 0.72 : text.length === 2 ? 0.6 : 0.44);
  g.font = `700 ${px}px "Segoe UI", system-ui, sans-serif`;
  g.fillStyle = colours.ink;
  g.textAlign = "center";
  g.textBaseline = "alphabetic";
  // Centred by the ink, not the line box, as the digits stand on the baseline with nothing below.
  const m = g.measureText(text);
  const ascent = m.actualBoundingBoxAscent || px * 0.72;
  const descent = m.actualBoundingBoxDescent || 0;
  g.fillText(text, size / 2, size / 2 + (ascent - descent) / 2, size * 0.9);
  return canvas.toDataURL("image/png").replace(/^data:image\/png;base64,/, "");
}

/**
 * Keeps the tray icon and the taskbar button in step with the unread counts and
 * the radio's name (which titles the window too), and the tray's words with the
 * language, in the desktop shell only.
 */
export function startTray(state: () => SessionState, subscribe: (listener: () => void) => () => void): () => void {
  if (shell() !== "tauri") return () => undefined;
  let told = "";
  const update = () => {
    const split = unreadSplit(state());
    const radio = state().self?.name ?? null;
    const key = `${split.direct}/${split.chats}/${language()}/${radio}`;
    if (key === told) return;
    told = key;
    void invoke("tray_unread", { ...split, detail: unreadDetail(split), radio, badge: badgePng(split) }).catch(() => undefined);
  };
  let spoken = "";
  const words = () => {
    if (spoken === language()) return;
    spoken = language();
    void invoke("tray_words", { open: t("notices.tray.open"), another: t("notices.tray.another"), quit: t("notices.tray.quit") }).catch(() => undefined);
    update();
  };
  words();
  const stopSession = subscribe(update);
  const stopLanguage = subscribeLanguage(words);
  return () => {
    stopSession();
    stopLanguage();
  };
}
