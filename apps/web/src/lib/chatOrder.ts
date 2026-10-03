import { useSyncExternalStore } from "react";
import { t, type Key } from "../i18n/index.js";
import { pinnedAt, type RadioPins } from "./chatPins.js";
import type { ConversationSummary } from "./conversations.js";
import { readSetting, writeSetting } from "./storage.js";

/**
 * How the chat list is ordered, and whether the channels keep a group of
 * their own above the direct chats. Kept on this device, like the theme.
 */

export type ChatOrder = "latest" | "name" | "unread";

/** The orders, their words as keys: `t()` them while drawing. */
export const CHAT_ORDERS: readonly { id: ChatOrder; label: Key; short: Key }[] = [
  { id: "latest", label: "chats.order.latest", short: "chats.order.latestShort" },
  { id: "name", label: "chats.order.name", short: "chats.order.nameShort" },
  { id: "unread", label: "chats.order.unread", short: "chats.order.unreadShort" },
];

export interface ChatOrderPrefs {
  order: ChatOrder;
  /** Channels in a group of their own, above the direct chats. */
  channelsFirst: boolean;
}

const KEY = "meshnet.chatOrder";

function read(): ChatOrderPrefs {
  const saved = readSetting<Partial<ChatOrderPrefs> | null>(KEY, null);
  const order = CHAT_ORDERS.find((o) => o.id === saved?.order)?.id ?? "latest";
  return { order, channelsFirst: saved?.channelsFirst === true };
}

let prefs = read();
const listeners = new Set<() => void>();

export function setChatOrder(patch: Partial<ChatOrderPrefs>): void {
  prefs = { ...prefs, ...patch };
  writeSetting(KEY, prefs);
  for (const listener of listeners) listener();
}

export function getChatOrder(): ChatOrderPrefs {
  return prefs;
}

export function useChatOrder(): ChatOrderPrefs {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => prefs,
  );
}

/** Whether the list is ordered other than the usual way, which the sort button shows in the accent. */
export function changed(p: ChatOrderPrefs): boolean {
  return p.order !== "latest" || p.channelsFirst;
}

type Row = ConversationSummary;

/** The newest first; channels nobody has spoken on last, in the order of their slots. */
const byLatest = (a: Row, b: Row) => {
  if (a.lastAt !== b.lastAt) return b.lastAt - a.lastAt;
  if (a.channel && b.channel) return a.channel.index - b.channel.index;
  return a.title.localeCompare(b.title);
};

/** A channel's "#" is not part of its name for the alphabet: #omsk stands with the O's. */
const bare = (title: string) => title.replace(/^#+/, "");
const byName = (a: Row, b: Row) => bare(a.title).localeCompare(bare(b.title), undefined, { sensitivity: "base" }) || byLatest(a, b);
const byUnread = (a: Row, b: Row) => Number(b.unread > 0) - Number(a.unread > 0) || byLatest(a, b);

export function chatComparator(order: ChatOrder): (a: Row, b: Row) => number {
  return order === "name" ? byName : order === "unread" ? byUnread : byLatest;
}

export interface ChatGroup {
  id: "pinned" | "channels" | "direct" | "all";
  title: string;
  rows: Row[];
}

/**
 * The list's groups. The pinned chats come first, the latest pinned on top,
 * whatever the order: new messages do not move them. Then the rest in the
 * order: the channels, then the direct chats; or, with channels not first,
 * one list, and then the pinned go without a title either. A lone group goes
 * without a title.
 */
export function chatGroups(rows: Row[], p: ChatOrderPrefs, pins: RadioPins = {}): ChatGroup[] {
  const at = new Map<string, number>();
  for (const row of rows) {
    const when = pinnedAt(pins, row);
    if (when !== null) at.set(row.id, when);
  }
  const pinned = rows.filter((r) => at.has(r.id)).sort((a, b) => at.get(b.id)! - at.get(a.id)! || byLatest(a, b));
  const rest = rows.filter((r) => !at.has(r.id)).sort(chatComparator(p.order));
  const groups: ChatGroup[] = p.channelsFirst
    ? [
        { id: "pinned", title: t("chats.order.pinnedGroup"), rows: pinned },
        { id: "channels", title: t("chats.order.channelsGroup"), rows: rest.filter((r) => r.kind === "channel") },
        { id: "direct", title: t("chats.order.directGroup"), rows: rest.filter((r) => r.kind !== "channel") },
      ]
    : [
        { id: "pinned", title: "", rows: pinned },
        { id: "all", title: "", rows: rest },
      ];
  const shown = groups.filter((g) => g.rows.length > 0);
  return shown.length === 1 ? [{ ...shown[0]!, title: "" }] : shown.length ? shown : [{ id: "all", title: "", rows: [] }];
}

/** The rows as the list shows them, top to bottom, for stepping through them from the keyboard. */
export function chatsInOrder(rows: Row[], p: ChatOrderPrefs, pins: RadioPins = {}): Row[] {
  return chatGroups(rows, p, pins).flatMap((g) => g.rows);
}
