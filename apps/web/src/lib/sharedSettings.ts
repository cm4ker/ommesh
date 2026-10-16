/**
 * The settings two apps sharing one radio through a phone keep alike (`peer.ts`
 * in @meshnet/meshcore), by the rules of `settingsSync.ts`: how the app looks
 * and sounds, and what each chat and node is set to. What belongs to the
 * device stays its own: the text size, the language, where notices show,
 * windows, links, ports, drafts and passwords. What is read goes alike
 * always, through the session; these only while "Shared settings" is on, and
 * each app takes them only while it is on there.
 *
 * The stores need not know of it: each writes through `writeSetting`, after
 * which every setting here is compared with what it was.
 */

import { useSyncExternalStore } from "react";
import type { PeerSide } from "@meshnet/meshcore";
import { findTheme } from "../theme/themes.js";
import { getPreference, setPreference } from "../theme/store.js";
import { setAntennaHeight, antennaHeights } from "./antennas.js";
import { BATTERY_TYPES, batteryTypes, setBatteryType } from "./batteryType.js";
import { BACKGROUNDS, backgroundPrefs, setBackground, setBackgroundScale, setBackgroundStrength, setChatBackground, type Background } from "./chatBackground.js";
import { CHAT_ORDERS, getChatOrder, setChatOrder, type ChatOrderPrefs } from "./chatOrder.js";
import { getPins, setPin, type Pin } from "./chatPins.js";
import { getOpenAtUnread, setOpenAtUnread } from "./firstUnread.js";
import { getJumboEmoji, setJumboEmoji } from "./jumboEmoji.js";
import { previewMode, setPreviewMode, type PreviewMode } from "./linkPreview.js";
import { getLookalikePrefs, setLookalikePrefs, type LookalikePrefs } from "./lookalikes.js";
import { getNeighbourSort, NEIGHBOUR_SORTS, setNeighbourSort } from "./neighbourSort.js";
import { DEFAULT_NODE_ORDER, getNodeOrder, NODE_ORDERS, setNodeOrder, type NodeOrderPrefs } from "./nodeOrder.js";
import { getNoticePrefs, setChatLevel, setChatSound, setNoticePrefs, SIGNALS, type ChatLevel, type NodeLevel, type NoticeKind, type Signal } from "./noticePrefs.js";
import { recentReactions, setRecentReactions } from "./reactions.js";
import { getSendTries, SEND_TRIES_MAX, setSendTries } from "./sendTries.js";
import { session } from "./session.js";
import { SettingsSync } from "./settingsSync.js";
import { onSettingWritten, readSetting, writeSetting } from "./storage.js";

const ON_KEY = "meshnet.shared";
const TIMES_KEY = "meshnet.shared.at";
const HELD_KEY = "meshnet.shared.held";

let on = readSetting<boolean>(ON_KEY, true);
const onListeners = new Set<() => void>();

/** Straight to the slot: through `writeSetting` it would set off another look. */
function keep(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private window: it lives for this page only.
  }
}

/** Which app this is on a radio shared through a phone, once the radio is ready. */
function side(): PeerSide | null {
  const state = session.getState();
  return state.status === "ready" ? state.peer : null;
}

const sync = new SettingsSync({
  side,
  tell: (key, value) => void session.tellPeer(key, value),
  enabled: () => on,
  times: readSetting<Record<string, number>>(TIMES_KEY, {}),
  saveTimes: (times) => keep(TIMES_KEY, times),
  held: readSetting<Record<string, string>>(HELD_KEY, {}),
  saveHeld: (held) => keep(HELD_KEY, held),
  now: Date.now,
});

export function setSharedSettings(next: boolean): void {
  on = next;
  writeSetting(ON_KEY, next);
  for (const listener of onListeners) listener();
  if (next) sync.resume();
}

export function useSharedSettings(): boolean {
  return useSyncExternalStore(
    (listener) => {
      onListeners.add(listener);
      return () => onListeners.delete(listener);
    },
    () => on,
  );
}

let looking = false;

/** After a write, once the store is done with it. */
function lookSoon(): void {
  if (looking) return;
  looking = true;
  queueMicrotask(() => {
    looking = false;
    sync.look();
  });
}

/** Follows every setting written, and the other app; returns the stop. */
export function startSharedSettings(): () => void {
  const stops = [onSettingWritten(lookSoon), session.onPeerEntry((key, value) => sync.take(key, value)), session.onPeerReady(() => sync.tellAll())];
  return () => {
    for (const stop of stops) stop();
  };
}

// ---- what is shared ----

const isBool = (value: unknown): value is boolean => typeof value === "boolean";
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
function oneOf<T extends string>(values: readonly T[]): (value: unknown) => value is T {
  return (value: unknown): value is T => values.includes(value as T);
}
const isSignal = oneOf<Signal>(SIGNALS.map((s) => s.id));
const isLevel = oneOf<ChatLevel>(["all", "mentions", "off"]);
const isBackground = oneOf<Background>(BACKGROUNDS);
const inRange = (low: number, high: number) => (value: unknown): value is number => typeof value === "number" && value >= low && value <= high;

/** The radio the session is on, whose pins are shown. */
function radio(): { key: string; channels: Parameters<typeof getPins>[1] } | null {
  const state = session.getState();
  return state.self ? { key: state.self.key, channels: state.channels } : null;
}

sync.share<string>({
  key: "theme",
  read: getPreference,
  write: setPreference,
  valid: (value): value is string => value === "system" || (typeof value === "string" && findTheme(value) !== undefined),
  fallback: "system",
});
sync.share<Background>({ key: "background", read: () => backgroundPrefs().background, write: setBackground, valid: isBackground, fallback: "none" });
sync.share<number>({ key: "backgroundStrength", read: () => backgroundPrefs().strength, write: setBackgroundStrength, valid: inRange(0, 100), fallback: 100 });
sync.share<number>({ key: "backgroundScale", read: () => backgroundPrefs().scale, write: setBackgroundScale, valid: inRange(80, 160), fallback: 100 });
sync.share<boolean>({ key: "noticeDirect", read: () => getNoticePrefs().direct, write: (direct) => setNoticePrefs({ direct }), valid: isBool, fallback: true });
sync.share<ChatLevel>({ key: "noticeChats", read: () => getNoticePrefs().chats, write: (chats) => setNoticePrefs({ chats }), valid: isLevel, fallback: "all" });
sync.share<NodeLevel>({
  key: "noticeNodes",
  read: () => getNoticePrefs().nodes,
  write: (nodes) => setNoticePrefs({ nodes }),
  valid: oneOf<NodeLevel>(["people", "all", "off"]),
  fallback: "people",
});
sync.share<Record<NoticeKind, Signal>>({
  key: "sounds",
  read: () => getNoticePrefs().sounds,
  write: (sounds) => setNoticePrefs({ sounds }),
  valid: (value): value is Record<NoticeKind, Signal> => isObject(value) && isSignal(value["direct"]) && isSignal(value["chats"]) && isSignal(value["nodes"]),
  fallback: { direct: "chirp", chats: "chirp", nodes: "chirp" },
});
sync.share<boolean>({ key: "openAtUnread", read: getOpenAtUnread, write: setOpenAtUnread, valid: isBool, fallback: true });
sync.share<boolean>({ key: "jumboEmoji", read: getJumboEmoji, write: setJumboEmoji, valid: isBool, fallback: true });
sync.share<ChatOrderPrefs>({
  key: "chatOrder",
  read: getChatOrder,
  write: setChatOrder,
  valid: (value): value is ChatOrderPrefs => isObject(value) && oneOf(CHAT_ORDERS.map((o) => o.id))(value["order"]) && isBool(value["channelsFirst"]),
  fallback: { order: "latest", channelsFirst: false },
});
sync.share<NodeOrderPrefs>({
  key: "nodeOrder",
  read: getNodeOrder,
  write: setNodeOrder,
  valid: (value): value is NodeOrderPrefs => isObject(value) && oneOf(NODE_ORDERS.map((o) => o.id))(value["order"]) && isBool(value["pinned"]),
  fallback: DEFAULT_NODE_ORDER,
});
sync.share({ key: "neighbourSort", read: getNeighbourSort, write: setNeighbourSort, valid: oneOf(NEIGHBOUR_SORTS.map((s) => s.id)), fallback: "signal" });
sync.share<PreviewMode>({ key: "linkPreview", read: previewMode, write: setPreviewMode, valid: oneOf<PreviewMode>(["off", "tap", "auto"]), fallback: "auto" });
sync.share<number>({ key: "sendTries", read: getSendTries, write: setSendTries, valid: inRange(1, SEND_TRIES_MAX), fallback: 5 });
sync.share<LookalikePrefs>({
  key: "lookalikes",
  read: getLookalikePrefs,
  write: setLookalikePrefs,
  valid: (value): value is LookalikePrefs => isObject(value) && isBool(value["on"]) && isBool(value["near"]),
  fallback: { on: true, near: false },
});
sync.share<readonly string[]>({
  key: "recentReactions",
  read: recentReactions,
  write: setRecentReactions,
  valid: (value): value is string[] => Array.isArray(value) && value.length <= 6 && value.every((e) => typeof e === "string" && e.length <= 16),
  fallback: [],
});

sync.shareEach<Background>({ key: "chatBackground", entries: () => backgroundPrefs().chat, write: setChatBackground, valid: isBackground });
sync.shareEach<ChatLevel>({ key: "chatLevel", entries: () => getNoticePrefs().chat, write: setChatLevel, valid: isLevel });
sync.shareEach<Signal>({ key: "chatSound", entries: () => getNoticePrefs().chatSound, write: setChatSound, valid: isSignal });
// A pin is the radio's: named `<radio>/<conversation>`, so the time it changed on one radio says nothing of another's.
sync.shareEach<Pin>({
  key: "pin",
  entries: () => {
    const on = radio();
    if (!on) return null;
    const owner = on.key.slice(0, 12);
    return Object.fromEntries(Object.entries(getPins(on.key, on.channels)).map(([conversation, pin]) => [`${owner}/${conversation}`, pin]));
  },
  write: (id, pin) => {
    const on = radio();
    const at = id.indexOf("/");
    if (on && id.slice(0, at) === on.key.slice(0, 12)) setPin(on.key, on.channels, id.slice(at + 1), pin);
  },
  valid: (value): value is Pin => isObject(value) && typeof value["at"] === "number" && (value["name"] === undefined || typeof value["name"] === "string"),
  untouched: (pin) => pin.at === 0,
  scope: () => radio()?.key ?? "",
});
sync.shareEach({ key: "battery", entries: batteryTypes, write: setBatteryType, valid: oneOf(BATTERY_TYPES.map((b) => b.value)) });
sync.shareEach<number>({ key: "antenna", entries: antennaHeights, write: setAntennaHeight, valid: inRange(0, 1000) });
