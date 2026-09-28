/**
 * Notifications, for a message outside the visible chat or a node heard for
 * the first time. Who draws one is the reader's choice (noticePrefs
 * `shownBy`), Telegram's way:
 *
 * - the system, as every app's notices are drawn, each shell its own way:
 *   a browser tab with the Web Notification API; the desktop shell natively
 *   (`announce.rs`), since WebView2 draws none; the phone app natively too
 *   (`MeshWatch.swift`, `NoticesPlugin.java`), since neither WKWebView nor
 *   Android's WebView has a `Notification`, and the system notice should say
 *   who wrote, with their circle, which Capacitor's plugin cannot draw;
 * - or the app itself: on a computer, cards in a corner of the screen from
 *   the desktop shell's own window, the main one open or in the tray; on a
 *   phone or in a tab a banner at the top, only while the app is on screen,
 *   since nothing but the system draws over other apps. Hidden, it is the
 *   system's again.
 *
 * On iOS the page's scripts are suspended soon after the app leaves the
 * screen, so a native watch announces what the radio pushes while the phone
 * is locked; the page tells it which notices are wanted.
 *
 * Each notice carries a tag saying what it is about, `c:<conversation>` or
 * `n:<contact key>`, and a click on it hands the tag back to open that. A
 * notice replaces the one out with its tag, and `withdraw` takes it back
 * once what it was about has been read.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Face, Notice } from "./announce.js";
import { dismissBanner, showBanner, withdrawBanner } from "./banner.js";
import { chime, signalFile } from "./chime.js";
import { withNotices, withWatch, type NativeNotice } from "./nativeNotices.js";
import { avatarPng } from "./noticeAvatar.js";
import { anyMessageWanted, getNoticePrefs, subscribeNoticePrefs, type NoticePrefs } from "./noticePrefs.js";
import { nativePlatform, shell } from "./platform.js";
import { coreAnnounced } from "./relay.js";

export type { NoticeKind } from "./announce.js";

/**
 * Makes Android's notification channels ring with the reader's signal: a
 * channel's sound is fixed when it is made. (What the radio core behind the
 * phone's link needs to announce in the page's place is `coreWatch.ts`'s.)
 */
export async function tellChannels(): Promise<void> {
  const sound = signalFile(getNoticePrefs().signal);
  try {
    await withNotices((n) => n.channels({ sound }));
  } catch (error) {
    console.warn("Could not configure native notifications", error);
  }
}

let told = "";
subscribeNoticePrefs(() => {
  // Only what the channels keep: a corner moved on the desktop is not news to a phone.
  const now = getNoticePrefs().signal;
  if (now === told) return;
  told = now;
  void tellChannels();
});

type LocalNotificationsModule = typeof import("@capacitor/local-notifications");

let local: Promise<LocalNotificationsModule> | null = null;
function localNotifications(): Promise<LocalNotificationsModule> {
  // Resolve with the module, never the thenable native plugin proxy inside it.
  local ??= import("@capacitor/local-notifications");
  return local;
}

/**
 * Whether notices may be shown, asking the system when it has not been
 * asked. The desktop shell needs no permission for a toast.
 */
export async function askPermission(): Promise<boolean> {
  switch (shell()) {
    case "tauri":
      return true;
    case "capacitor": {
      const { LocalNotifications: api } = await localNotifications();
      const { display } = await api.checkPermissions();
      if (display === "granted") return true;
      if (display === "denied") return false;
      return (await api.requestPermissions()).display === "granted";
    }
    default:
      if (!("Notification" in window)) return false;
      if (Notification.permission === "granted") return true;
      if (Notification.permission === "denied") return false;
      return (await Notification.requestPermission()) === "granted";
  }
}

/**
 * The phone asks once, the first time there is a radio to hear from: its
 * notifications are on by default, and a default the system was never asked
 * about shows nothing. A browser asks only when the switch is moved, since
 * a prompt out of nowhere is what browsers learn to block.
 */
export async function askPermissionOnce(): Promise<void> {
  if (shell() !== "capacitor") return;
  const prefs = getNoticePrefs();
  if (!anyMessageWanted(prefs) && prefs.nodes === "off") return;
  await askPermission().catch(() => false);
}

/**
 * Whether the reader can see the page: shown, and on a computer, in the
 * window in front. A phone's page is either on screen or hidden; WKWebView
 * may even report focus after the phone locks, so a phone goes by
 * visibility alone.
 */
export function pageOnScreen(): boolean {
  if (document.visibilityState !== "visible") return false;
  return shell() === "capacitor" || document.hasFocus();
}

/**
 * The phone's number for the notice with this tag, the same every time, so
 * a notice replaces the one out with its tag and can be withdrawn by it.
 * FNV-1a, kept positive for Android's `int` ids.
 */
export function noticeId(tag: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < tag.length; i++) {
    hash ^= tag.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash & 0x7fffffff) || 1;
}

/** The browser's notices that are out, by tag, to be closed when withdrawn. */
const shown = new Map<string, Notification>();

/** Whether this shell can open the system's notification settings for the app. */
export function hasNoticeSettings(): boolean {
  return shell() === "capacitor" || (shell() === "tauri" && navigator.userAgent.includes("Windows"));
}

/** Sound, vibration and quiet hours are the system's: this opens its page for the app. */
export async function openNoticeSettings(): Promise<void> {
  if (shell() === "tauri") {
    await invoke("plugin:opener|open_url", { url: "ms-settings:notifications" });
    return;
  }
  await withWatch((w) => w.openSettings());
  await withNotices((n) => n.openSettings());
}

/** What the desktop's corner window draws for a notice. */
export interface Card {
  tag: string;
  title: string;
  body: string;
  face: Face | null;
  /** Whether it is about a conversation, so it can be answered and marked read from where it is. */
  chat: boolean;
}

/** The caller checks preferences and whether what it announces is already on screen. */
export async function notify(notice: Notice): Promise<void> {
  const prefs = getNoticePrefs();
  // A quiet notice plays nothing, whichever signal the reader picked.
  const signal = notice.silent ? "none" : prefs.signal;
  if (prefs.shownBy === "app") {
    if (shell() === "tauri") {
      const card: Card = { tag: notice.tag, title: notice.title, body: notice.body, face: notice.face ?? null, chat: notice.tag.startsWith("c:") && notice.tag !== "c:" };
      await invoke("notice_card", { card, corner: prefs.corner, signal }).catch(() => undefined);
      return;
    }
    // Only while the app is on screen: a hidden app's notices are the system's to draw.
    if (pageOnScreen()) {
      showBanner(notice);
      void chime(signal);
      return;
    }
  }
  await system(notice, prefs);
}

/** A notice the system draws. */
async function system(notice: Notice, prefs: NoticePrefs): Promise<void> {
  const { title, body, tag } = notice;
  switch (shell()) {
    case "tauri": {
      const avatar = notice.face ? await avatarPng(notice.face) : null;
      await invoke("announce", { title, body, tag, avatar, signal: notice.silent ? "none" : prefs.signal }).catch(() => undefined);
      return;
    }
    case "capacitor": {
      const native = await nativeNotice(notice, prefs);
      try {
        await withWatch((w) => w.post(native));
        await withNotices((n) => n.post(native));
      } catch (error) {
        // Nothing shown, so the radio core's stand-in, if any, is left to show.
        console.warn("Could not show notification", error);
        return;
      }
      // One notice per news: the radio core's for the same news waits no more.
      await coreAnnounced(tag).catch(() => undefined);
      return;
    }
    default: {
      if (!("Notification" in window) || Notification.permission !== "granted") return;
      const avatar = notice.face ? await avatarPng(notice.face, true) : null;
      try {
        const shownNotice = new Notification(title, { body, tag, icon: avatar ? `data:image/png;base64,${avatar}` : "./icon-192.png", badge: "./notification-badge.png", silent: notice.silent ?? false });
        shownNotice.onclick = () => {
          window.focus();
          clicked?.(tag);
          shownNotice.close();
        };
        shownNotice.onclose = () => {
          if (shown.get(tag) === shownNotice) shown.delete(tag);
        };
        shown.set(tag, shownNotice);
      } catch {
        // Some webviews throw on construction; there is nothing to do about it.
      }
    }
  }
}

/** A notice as the phone's native side draws it: with circles for who wrote and where. */
async function nativeNotice(notice: Notice, prefs: NoticePrefs): Promise<NativeNotice> {
  const thread = notice.thread;
  let native: NativeNotice["thread"] = null;
  if (thread) {
    const names = [...new Set(thread.lines.map((l) => l.sender))];
    // A person's chat is theirs, circle and all; in a channel a writer who shares its name is still a person.
    const faces = await Promise.all(names.map((name) => avatarPng(!thread.group && name === thread.title ? thread.face : { name })));
    const people = Object.fromEntries(names.map((name, i) => [name, faces[i] ?? null]));
    native = { title: thread.title, group: thread.group, avatar: await avatarPng(thread.face), lines: thread.lines, people };
  }
  return {
    id: noticeId(notice.tag),
    tag: notice.tag,
    title: notice.title,
    body: notice.body,
    kind: notice.kind,
    sound: signalFile(prefs.signal),
    silent: notice.silent ?? false,
    avatar: notice.face ? await avatarPng(notice.face) : null,
    thread: native,
  };
}

/** Takes back the notice out with this tag, if there is one: what it said has been read. */
export async function withdraw(tag: string): Promise<void> {
  withdrawBanner(tag);
  switch (shell()) {
    case "tauri":
      await invoke("withdraw", { tag }).catch(() => undefined);
      await invoke("notice_withdraw", { tag }).catch(() => undefined);
      return;
    case "capacitor":
      try {
        if (nativePlatform() === "android") {
          await withNotices((n) => n.cancel({ id: noticeId(tag) }));
        } else {
          const { LocalNotifications: api } = await localNotifications();
          await api.removeDeliveredNotificationsById({ ids: [noticeId(tag)] });
        }
      } catch (error) {
        console.warn("Could not withdraw notification", error);
      }
      return;
    default:
      shown.get(tag)?.close();
      shown.delete(tag);
  }
}

let clicked: ((tag: string) => void) | null = null;

/** What a click on a notice opens. Set once, by the app. */
export function onNotificationClick(open: (tag: string) => void): void {
  // A banner tapped opens as a system notice clicked does.
  clicked = (tag) => {
    dismissBanner();
    open(tag);
  };
  switch (shell()) {
    case "tauri":
      void listen<{ tag: string | null }>("notification-opened", (event) => {
        if (event.payload.tag) open(event.payload.tag);
      }).catch(() => undefined);
      return;
    case "capacitor":
      // The native notices are posted with the plugin's own extras, so a tap on one reaches this listener too.
      void localNotifications()
        .then(({ LocalNotifications: api }) =>
          api.addListener("localNotificationActionPerformed", (action) => {
            const tag = (action.notification.extra as { tag?: string } | undefined)?.tag;
            if (tag) open(tag);
          }),
        )
        .catch(() => undefined);
      return;
    default:
      // A browser notice carries its own click handler, set in `notify`.
      return;
  }
}

/** A tap on the app's own banner: opens what it is about. */
export function openNotice(tag: string): void {
  clicked?.(tag);
}

/** What was done on one of the desktop's own cards, other than opening it (the shell does that). */
export type CardAction = { action: "reply"; tag: string; text: string } | { action: "read"; tag: string };

/** Hands the page what was done on a desktop card, until the returned function is called. */
export function onCardAction(act: (action: CardAction) => void): () => void {
  if (shell() !== "tauri") return () => undefined;
  const listening = listen<CardAction>("notice-action", (event) => act(event.payload));
  return () => void listening.then((unlisten) => unlisten()).catch(() => undefined);
}
