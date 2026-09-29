/**
 * What the chat list shows: one row per conversation, from the session's
 * flat message list. Pure, so the shape of the list is testable without a
 * radio.
 */

import {
  channelConversation,
  contactConversation,
  parseConversation,
  TxtType,
  type ChannelRecord,
  type ContactRecord,
  type MessageRecord,
  type SessionState,
} from "@meshnet/meshcore";
import { t } from "../i18n/index.js";

export interface ConversationSummary {
  id: string;
  kind: "channel" | "contact" | "prefix";
  title: string;
  /** The last message, with its sender on a channel. */
  preview: string | null;
  /** Local ms of the last message, or 0 for a channel nobody has spoken on. */
  lastAt: number;
  unread: number;
  contact: ContactRecord | null;
  channel: ChannelRecord | null;
}

function preview(message: MessageRecord, kind: ConversationSummary["kind"]): string {
  if (message.direction === "out") return t("chats.conversation.you", { text: message.text });
  // A room's posts carry their author the way a channel's messages do.
  if ((kind === "channel" || message.txtType === TxtType.SignedPlain) && message.sender) return `${message.sender}: ${message.text}`;
  return message.text;
}

export function summarize(state: SessionState): ConversationSummary[] {
  // The one at the bottom of the chat, so the row says what the chat ends with.
  const last = new Map<string, MessageRecord>();
  for (const m of state.messages) {
    const prior = last.get(m.conversation);
    if (!prior || placedAt(m) >= placedAt(prior)) last.set(m.conversation, m);
  }

  const rows: ConversationSummary[] = [];
  const seen = new Set<string>();

  for (const channel of state.channels) {
    const id = channelConversation(channel.index);
    seen.add(id);
    const m = last.get(id);
    rows.push({
      id,
      kind: "channel",
      title: channel.name || t("chats.conversation.channel", { index: channel.index }),
      preview: m ? preview(m, "channel") : null,
      lastAt: m ? placedAt(m) : 0,
      unread: state.unread[id] ?? 0,
      contact: null,
      channel,
    });
  }

  for (const [id, m] of last) {
    if (seen.has(id)) continue;
    seen.add(id);
    const target = parseConversation(id);
    if (target.kind === "channel") {
      rows.push({
        id,
        kind: "channel",
        title: t("chats.conversation.channel", { index: target.index }),
        preview: preview(m, "channel"),
        lastAt: placedAt(m),
        unread: state.unread[id] ?? 0,
        contact: null,
        channel: null,
      });
    } else if (target.kind === "contact") {
      const contact = state.contacts[target.key] ?? null;
      rows.push({
        id,
        kind: "contact",
        title: contact?.name || target.key.slice(0, 12),
        preview: preview(m, "contact"),
        lastAt: placedAt(m),
        unread: state.unread[id] ?? 0,
        contact,
        channel: null,
      });
    } else {
      rows.push({
        id,
        kind: "prefix",
        title: t("chats.conversation.unknown", { prefix: target.prefix }),
        preview: preview(m, "prefix"),
        lastAt: placedAt(m),
        unread: state.unread[id] ?? 0,
        contact: null,
        channel: null,
      });
    }
  }

  rows.sort((a, b) => {
    if (a.lastAt !== b.lastAt) return b.lastAt - a.lastAt;
    if (a.channel && b.channel) return a.channel.index - b.channel.index;
    return a.title.localeCompare(b.title);
  });
  return rows;
}

/** A chat's messages in the order they came. */
export function messagesIn(state: SessionState, conversation: string): MessageRecord[] {
  return state.messages.filter((m) => m.conversation === conversation).sort((a, b) => placedAt(a) - placedAt(b));
}

/**
 * Where a message stands in its chat, local ms: when it came in, by this
 * device's clock, and ours when it last went. Not by the sender's stamp: a
 * radio that lost its clock stamps a date years back, and its message would
 * go up into the history where nobody sees it come. The radio hands its queue
 * up in the order it heard, so a batch fetched late still stands in order.
 */
export function placedAt(m: MessageRecord): number {
  return m.direction === "in" ? m.receivedAt : Math.max(m.receivedAt, (m.sentAt ?? m.timestamp) * 1000);
}

/** How far a sender's clock may stray, seconds, before its stamp is not believed. */
const CLOCK_SLACK = 600;

/** A message as its chat shows it. */
export interface Shown {
  /** The time on it, unix seconds. */
  at: number;
  /** The sender's stamp was not believed, and `at` is when the message came in. */
  clockOff: boolean;
  /** The first of a day later than any before it, so a line with the date goes above it. */
  newDay: boolean;
}

/**
 * The time each of a chat's messages shows, by id, for the messages in the
 * order `messagesIn` gives. A message shows when its sender says it went, which
 * holds for one fetched hours late. That stamp is not believed when it is
 * later than the message came in, or well before a message that came earlier;
 * the message then shows when it came in.
 */
export function shownIn(messages: readonly MessageRecord[]): Map<string, Shown> {
  const out = new Map<string, Shown>();
  // The latest believed time so far. Not moved by a message whose stamp was not believed:
  // one fetched late shows when the batch came, and the rest of the batch goes by its stamps.
  let latest: number | null = null;
  let lastDay = -Infinity;
  for (const m of messages) {
    let at = m.sentAt ?? m.timestamp;
    let clockOff = false;
    if (m.direction === "in") {
      const came = Math.floor(m.receivedAt / 1000);
      clockOff = at > came + CLOCK_SLACK || (latest !== null && at < latest - CLOCK_SLACK);
      at = clockOff ? came : Math.min(at, came);
    }
    if (!clockOff) latest = Math.max(latest ?? at, at);
    // A stamp a little behind the one above it stays under that day, rather than bringing yesterday back after midnight.
    const day = dayNumber(at);
    out.set(m.id, { at, clockOff, newDay: day > lastDay });
    lastDay = Math.max(lastDay, day);
  }
  return out;
}

/** The local calendar day of a time, as a number that grows with the date. */
function dayNumber(unixSeconds: number): number {
  const date = new Date(unixSeconds * 1000);
  return date.getFullYear() * 512 + date.getMonth() * 32 + date.getDate();
}

export function titleOf(state: SessionState, conversation: string): string {
  const target = parseConversation(conversation);
  if (target.kind === "channel") {
    const channel = state.channels.find((c) => c.index === target.index);
    return channel?.name || t("chats.conversation.channel", { index: target.index });
  }
  if (target.kind === "contact") return (state.contacts[target.key] ?? state.removed[target.key]?.contact)?.name || target.key.slice(0, 12);
  return t("chats.conversation.unknown", { prefix: target.prefix });
}

export function totalUnread(state: SessionState): number {
  let n = 0;
  for (const v of Object.values(state.unread)) n += v;
  return n;
}

export { contactConversation, channelConversation };
