/**
 * What the reader wants to hear about: which messages and which new nodes
 * become notices. Settings of this app, not of the radio: a phone and a
 * computer sharing the radio keep them alike only through their shared
 * settings (`sharedSettings.ts`), and where notices show is each one's own.
 *
 * - Direct messages: on or off.
 * - Channels and rooms: every message, only the ones that mention this
 *   radio (`@[name]`), or none.
 * - New nodes: only a person's radio, any node, or none.
 * - A chat may have a level of its own, which wins over the one for its kind.
 * - Each kind rings with a sound of its own, and a chat may have its own
 *   sound, which wins the same way (gh #73): Public may chirp while a
 *   person's message says "roger".
 * - Who draws them: the system, or the app itself, Telegram's way. The app
 *   can only draw while it runs: a computer's app does in the tray, a phone's
 *   and a tab's only while on screen, and the system draws the rest.
 * - Do not disturb (`quiet.ts`): for a while by hand, and at night by a
 *   schedule. A chat may be silenced for a while of its own too, after which
 *   its level goes back to its kind's (`chatUntil`).
 *
 * The rules are pure, so they are testable without storage or a radio.
 */

import { useSyncExternalStore } from "react";
import { AdvType, type MessageRecord, type SessionState } from "@meshnet/meshcore";
import { t, type Key } from "../i18n/index.js";
import { readSetting, writeSetting } from "./storage.js";

/** What a notice is about, which on Android is its channel: the reader sets each one's sound in the system. */
export type NoticeKind = "direct" | "chats" | "nodes";
/** How much of a chat rings: a person's chat takes "all" or "off" only. */
export type ChatLevel = "all" | "mentions" | "off";
export type NodeLevel = "people" | "all" | "off";
/** Who draws a notice: the system's notification centre, or the app's own card. */
export type ShownBy = "system" | "app";
/** Where on a computer's screen the app's own cards stack. */
export type Corner = "br" | "bl" | "tr" | "tl";
/** The app's signal (`public/sounds/signal_<id>.wav`, drawn by `scripts/sound-synth.mjs`), or none. */
export type Signal = "chirp" | "roger" | "hop" | "sonar" | "none";

/**
 * Do not disturb, as the reader set it; `quiet.ts` reads when it is on. While
 * it is on, notices come without a sound and without popping up, but for the
 * ones that ring all the same.
 */
export interface QuietPrefs {
  /** Quiet by hand: not, for an hour or till morning (until `until`), or until turned off. */
  hand: "off" | "hour" | "morning" | "always";
  /** When quiet by hand ends, ms, for an hour or till morning. */
  until: number;
  /** Whether nights are quiet by the schedule. */
  nightly: boolean;
  /** When a night starts and ends, minutes after midnight; it ends the next day when `to` is not after `from`. */
  from: number;
  to: number;
  /** The days a night starts on, 0 for Sunday. */
  days: number[];
  /** Until when the schedule is set aside, ms: quiet was turned off in the middle of a night. */
  awake: number;
  /** Whether a direct message from a favourite rings all the same. */
  favourites: boolean;
  /** Whether a message that mentions this radio rings all the same. */
  mentions: boolean;
}

export const DEFAULT_QUIET: QuietPrefs = {
  hand: "off",
  until: 0,
  nightly: false,
  from: 23 * 60,
  to: 7 * 60,
  days: [0, 1, 2, 3, 4, 5, 6],
  awake: 0,
  favourites: true,
  mentions: false,
};

/** Each signal's name and what it sounds like, as keys: the view says them in the reader's language. */
export const SIGNALS: { id: Signal; label: Key; hint: Key }[] = [
  { id: "chirp", label: "radio.signals.chirp", hint: "radio.signals.chirpHint" },
  { id: "roger", label: "radio.signals.roger", hint: "radio.signals.rogerHint" },
  { id: "hop", label: "radio.signals.hop", hint: "radio.signals.hopHint" },
  { id: "sonar", label: "radio.signals.sonar", hint: "radio.signals.sonarHint" },
  { id: "none", label: "radio.signals.none", hint: "radio.signals.noneHint" },
];

export interface NoticePrefs {
  direct: boolean;
  chats: ChatLevel;
  nodes: NodeLevel;
  /** Chats with a level of their own, by conversation. */
  chat: Record<string, ChatLevel>;
  /** Chats whose own level is for a while, when the while ends, ms (Telegram's "mute for 8 hours"). */
  chatUntil: Record<string, number>;
  shownBy: ShownBy;
  corner: Corner;
  /** The sound of each kind's notices, on every shell; the system still decides when to be quiet. */
  sounds: Record<NoticeKind, Signal>;
  /** Chats with a sound of their own, by conversation. */
  chatSound: Record<string, Signal>;
  quiet: QuietPrefs;
}

export const DEFAULT_PREFS: NoticePrefs = {
  direct: true,
  chats: "all",
  nodes: "people",
  chat: {},
  chatUntil: {},
  shownBy: "system",
  corner: "br",
  sounds: { direct: "chirp", chats: "chirp", nodes: "chirp" },
  chatSound: {},
  quiet: DEFAULT_QUIET,
};

const KEY = "meshnet.notices";
/** The two switches before there were levels; off stays off. */
const OLD_MESSAGES = "meshnet.notify";
const OLD_NODES = "meshnet.notify.nodes";

/** What an earlier build stored: one `signal` for every notice came before a sound for each kind. */
type Stored = Partial<NoticePrefs> & { signal?: Signal };

export function fromStored(stored: Stored): NoticePrefs {
  const { signal, ...rest } = stored;
  const before = signal ? { direct: signal, chats: signal, nodes: signal } : {};
  return {
    ...DEFAULT_PREFS,
    ...rest,
    chat: { ...stored.chat },
    chatUntil: { ...stored.chatUntil },
    sounds: { ...DEFAULT_PREFS.sounds, ...before, ...stored.sounds },
    chatSound: { ...stored.chatSound },
    quiet: { ...DEFAULT_QUIET, ...stored.quiet },
  };
}

function load(): NoticePrefs {
  const stored = readSetting<Stored | null>(KEY, null);
  if (stored) return fromStored(stored);
  const messages = readSetting<boolean>(OLD_MESSAGES, true);
  const nodes = readSetting<boolean>(OLD_NODES, true);
  return { ...DEFAULT_PREFS, direct: messages, chats: messages ? "all" : "off", nodes: nodes ? DEFAULT_PREFS.nodes : "off" };
}

let prefs = load();
const listeners = new Set<() => void>();

export function getNoticePrefs(): NoticePrefs {
  return prefs;
}

export function setNoticePrefs(patch: Partial<NoticePrefs>): void {
  prefs = { ...prefs, ...patch };
  writeSetting(KEY, prefs);
  for (const listener of listeners) listener();
}

/**
 * Gives a chat a level of its own, or, with null, back to the one for its kind;
 * with `until` (ms) only for a while, after which it goes back by itself.
 */
export function setChatLevel(conversation: string, level: ChatLevel | null, until?: number): void {
  const chat = { ...prefs.chat };
  const chatUntil = { ...prefs.chatUntil };
  if (level) chat[conversation] = level;
  else delete chat[conversation];
  if (level && until !== undefined) chatUntil[conversation] = until;
  else delete chatUntil[conversation];
  setNoticePrefs({ chat, chatUntil });
}

/** When a chat's own level ends, from the other app sharing the radio; null, never. */
export function setChatUntil(conversation: string, until: number | null): void {
  const chatUntil = { ...prefs.chatUntil };
  if (until !== null) chatUntil[conversation] = until;
  else delete chatUntil[conversation];
  setNoticePrefs({ chatUntil });
}

/** Gives the chats whose while is over the level of their kind again; whether any was. */
export function endChatWhiles(now = Date.now()): boolean {
  const over = Object.entries(prefs.chatUntil).filter(([, until]) => until <= now);
  if (over.length === 0) return false;
  const chat = { ...prefs.chat };
  const chatUntil = { ...prefs.chatUntil };
  for (const [conversation] of over) {
    delete chat[conversation];
    delete chatUntil[conversation];
  }
  setNoticePrefs({ chat, chatUntil });
  return true;
}

export function setQuietPrefs(patch: Partial<QuietPrefs>): void {
  setNoticePrefs({ quiet: { ...prefs.quiet, ...patch } });
}

/** Gives a chat a sound of its own, or, with null, back to the one for its kind. */
export function setChatSound(conversation: string, signal: Signal | null): void {
  const chatSound = { ...prefs.chatSound };
  if (signal) chatSound[conversation] = signal;
  else delete chatSound[conversation];
  setNoticePrefs({ chatSound });
}

export function subscribeNoticePrefs(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useNoticePrefs(): NoticePrefs {
  return useSyncExternalStore(subscribeNoticePrefs, getNoticePrefs);
}

/** Whether a conversation is with a person (or a sender not yet in the contacts), rather than a channel or a room. */
export function isDirect(state: SessionState, conversation: string): boolean {
  if (conversation.startsWith("ch:")) return false;
  if (!conversation.startsWith("c:")) return true;
  return state.contacts[conversation.slice(2)]?.type !== AdvType.Room;
}

/** The level its kind gives a conversation, before any of its own. */
export function kindLevel(p: NoticePrefs, direct: boolean): ChatLevel {
  return direct ? (p.direct ? "all" : "off") : p.chats;
}

/** A chat's own level, while it lasts. */
export function ownLevel(p: NoticePrefs, conversation: string, now = Date.now()): ChatLevel | undefined {
  const until = p.chatUntil[conversation];
  return until !== undefined && until <= now ? undefined : p.chat[conversation];
}

export function chatLevel(p: NoticePrefs, state: SessionState, conversation: string, now = Date.now()): ChatLevel {
  return ownLevel(p, conversation, now) ?? kindLevel(p, isDirect(state, conversation));
}

export function mentionsMe(state: SessionState, message: MessageRecord): boolean {
  const me = state.self?.name;
  return !!me && message.text.includes(`@[${me}]`);
}

/** Whether a message the radio handed over should ring. */
export function messageWanted(p: NoticePrefs, state: SessionState, message: MessageRecord, now = Date.now()): boolean {
  const level = chatLevel(p, state, message.conversation, now);
  return level === "all" || (level === "mentions" && mentionsMe(state, message));
}

/** Whether a node heard for the first time should ring, by its advert type. */
export function nodeWanted(p: NoticePrefs, type: number): boolean {
  return p.nodes === "all" || (p.nodes === "people" && type === AdvType.Chat);
}

/** Whether any message at all may ring: a chat of its own may, with the rest off. */
export function anyMessageWanted(p: NoticePrefs): boolean {
  return p.direct || p.chats !== "off" || Object.values(p.chat).some((l) => l !== "off");
}

/** The sound a notice rings with: its chat's own, or its kind's. The notice about several chats is one of channels and rooms. */
export function noticeSignal(p: NoticePrefs, notice: { tag: string; kind: NoticeKind }): Signal {
  const conversation = notice.tag.startsWith("c:") ? notice.tag.slice(2) : "";
  return (conversation ? p.chatSound[conversation] : undefined) ?? p.sounds[notice.kind];
}

/** The one sound every notice rings with, or null when they differ. */
export function oneSignal(p: NoticePrefs): Signal | null {
  const all = [...Object.values(p.sounds), ...Object.values(p.chatSound)];
  return all.every((s) => s === all[0]) ? (all[0] ?? null) : null;
}

/**
 * The sounds each kind's notices ring with: the kind's own first, then every
 * other one a chat of that kind has. Android makes a channel of each, since a
 * channel's sound is fixed once it is made.
 */
export function kindSounds(p: NoticePrefs, state: SessionState): { kind: NoticeKind; signal: Signal; own: boolean }[] {
  const kinds: NoticeKind[] = ["direct", "chats", "nodes"];
  const sounds = kinds.map((kind) => ({ kind, signal: p.sounds[kind], own: true }));
  for (const [conversation, signal] of Object.entries(p.chatSound)) {
    const kind: NoticeKind = isDirect(state, conversation) ? "direct" : "chats";
    if (!sounds.some((s) => s.kind === kind && s.signal === signal)) sounds.push({ kind, signal, own: false });
  }
  return sounds;
}

/** One word for the Radio screen's row. */
export function summaryOf(p: NoticePrefs): string {
  if (!anyMessageWanted(p) && p.nodes === "off") return t("common.off");
  if (p.direct && p.chats === "all" && p.nodes !== "off") return t("common.on");
  if (p.direct && p.chats === "mentions") return t("radio.notifications.mentions");
  return t("radio.notifications.custom");
}
