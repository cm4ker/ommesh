/**
 * The desktop's icon by the clock (`tray.rs`) carries a dot while anything is
 * unread, coloured by whether a person is waiting or only channels and rooms.
 * The page counts and says it, in the reader's language; the shell draws.
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

/**
 * Keeps the tray icon in step with the unread counts and the radio's name (which titles the window too),
 * and its words with the language, in the desktop shell only.
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
    void invoke("tray_unread", { ...split, detail: unreadDetail(split), radio }).catch(() => undefined);
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
