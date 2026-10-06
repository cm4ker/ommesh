/**
 * Which messages become notices, and how many notices they become.
 *
 * Only a message the radio hands over while the app runs is news: the
 * history read back from the storage at connect was announced on the run
 * that received it. News is read on arrival when its conversation is on
 * screen (the session's focus), and a notice is only ever about unread
 * messages:
 *
 * - a conversation has one notice at most, which says how many are unread
 *   and shows the latest of them, is replaced as more arrive, and is
 *   withdrawn once the conversation is read, wherever it is read;
 * - news that keeps coming, each within a moment (`QUIET_MS`) of the last,
 *   is one burst: the queue read out at connect, a hundred messages or
 *   more, is one, and a chat whose people write seconds apart is a burst
 *   per message. A burst rings once, with its first notice; after it the
 *   notices are brought up to date quietly, every few seconds while it goes
 *   on and once it is over (gh #46). A burst is told by time, not by the
 *   session's `syncing` alone: on a phone the radio core reads the radio's
 *   queue itself and hands it to the page a message at a time, each its own
 *   sync;
 * - when more than three conversations would each have a notice, one
 *   notice stands for them all, until the app is opened or all is read;
 * - only what the reader wants rings (noticePrefs.ts): a chat left at
 *   mentions has a notice for the messages that mention this radio, and
 *   counts only those.
 *
 * Pure apart from what it is handed, so the rules are testable without a
 * radio or a notification centre.
 */

import { AdvType, type MessageRecord, type SessionState } from "@meshnet/meshcore";
import { conversationAccess, type ChannelAccess } from "./channels.js";
import { titleOf } from "./conversations.js";
import { t } from "../i18n/index.js";
import { isDirect, mentionsMe, type NoticeKind } from "./noticePrefs.js";
import { textWithPlaces } from "./place.js";

export type { NoticeKind };

/**
 * Whose circle a notice shows, as `Avatar` draws it from a name: the person
 * who wrote, the chat, or the node heard.
 */
export interface Face {
  name: string;
  /** The node's advert type; a person's radio when not given. */
  type?: number;
  /** A channel, drawn as "#" when anyone can read it, as a lock when it is private and as an open lock without a key. */
  channel?: ChannelAccess;
}

export interface Notice {
  title: string;
  body: string;
  tag: string;
  /** Which channel it goes on, where the system has channels. */
  kind: NoticeKind;
  /** Whose circle it shows; none for the notice about several chats, which shows the app's. */
  face?: Face;
  /** Shown without the signal: a burst of news rings with its first notice only. */
  silent?: boolean;
}

/** At most this many conversations each have a notice of their own. */
const SEPARATE = 3;
/** How many of a conversation's unread messages its notice shows. */
const LINES = 3;
/** How many conversations the notice for several of them names. */
const NAMED = 4;
/**
 * How long news must stop for a burst of it to be over, in ms. The radio core
 * reads the radio's queue at a message per 60–450 ms; people in a chat write
 * seconds apart, and a LoRa message alone takes about a second on the air.
 */
export const QUIET_MS = 1500;
/** How often a burst that goes on brings its notices up to date, in ms. */
export const CATCH_UP_MS = 5000;

/** The tag of the notice for several conversations; a click on it opens the chat list. */
export const ALL_CHATS = "c:";

export function conversationTag(conversation: string): string {
  return `c:${conversation}`;
}

/** The unread messages of a conversation, oldest first: the last ones in, as many as are unread. */
function unreadIn(state: SessionState, conversation: string): MessageRecord[] {
  const count = state.unread[conversation] ?? 0;
  if (count === 0) return [];
  return state.messages.filter((m) => m.conversation === conversation && m.direction === "in").slice(-count);
}

/** One message on its own: who said it, and where. */
function heading(state: SessionState, message: MessageRecord, title: string): string {
  if (mentionsMe(state, message)) {
    const who = message.sender ?? title;
    return message.sender && message.sender !== title ? t("notices.mentionedIn", { who, chat: title }) : t("notices.mentioned", { who });
  }
  if (message.sender && message.conversation.startsWith("ch:")) return t("notices.inChat", { sender: message.sender, chat: title });
  return title;
}

/** One message among several: a channel's and a room's are named after their author. */
function line(message: MessageRecord, title: string): string {
  const text = textWithPlaces(message.text);
  return message.sender && message.sender !== title ? `${message.sender}: ${text}` : text;
}

/** Which unread messages a notice is about: the ones the reader wants to hear of. */
type Keep = (message: MessageRecord) => boolean;
const everything: Keep = () => true;

/** What a conversation's notice says, or nothing when nothing in it that rings is unread. */
export function conversationNotice(state: SessionState, conversation: string, keep: Keep = everything): Notice | null {
  const unread = unreadIn(state, conversation).filter(keep);
  const last = unread.at(-1);
  if (!last) return null;
  const title = titleOf(state, conversation);
  const tag = conversationTag(conversation);
  const count = unread.length;
  const direct = isDirect(state, conversation);
  const kind = direct ? "direct" : "chats";
  const face = chatFace(state, conversation, title);
  // In a channel or a room one message shows its writer's circle; in a person's chat it is theirs.
  if (count === 1) return { title: heading(state, last, title), body: textWithPlaces(last.text), tag, kind, face: direct ? face : { name: last.sender || title } };
  const mentioned = unread.some((m) => mentionsMe(state, m));
  return {
    title: t(mentioned ? "notices.chatNewMentioned" : "notices.chatNew", { chat: title, count }),
    body: unread.slice(-LINES).map((m) => line(m, title)).join("\n"),
    tag,
    kind,
    face,
  };
}

/** A chat's own circle: a channel's "#" or lock, a room's or a person's by their advert. */
function chatFace(state: SessionState, conversation: string, title: string): Face {
  if (conversation.startsWith("ch:")) return { name: title, channel: conversationAccess(conversation, state.channels) };
  const contact = conversation.startsWith("c:") ? state.contacts[conversation.slice(2)] : undefined;
  return { name: title, type: contact?.type ?? AdvType.Chat };
}

/** What the notice for several conversations says: every unread one, busiest first. */
export function allChatsNotice(state: SessionState, keep: Keep = everything): Notice | null {
  const chats = Object.entries(state.unread)
    .filter(([, n]) => n > 0)
    .map(([c]) => [c, unreadIn(state, c).filter(keep).length] as const)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1]);
  if (chats.length === 0) return null;
  const total = chats.reduce((sum, [, n]) => sum + n, 0);
  const named = chats.slice(0, NAMED).map(([c, n]) => `${titleOf(state, c)} ${n}`);
  if (chats.length > NAMED) named.push("…");
  return {
    title: t("notices.allChats", { messages: t("notices.newMessages", { count: total }), chats: t("notices.inChats", { count: chats.length }) }),
    body: named.join(", "),
    tag: ALL_CHATS,
    kind: "chats",
  };
}

export interface Announcer {
  /** A message the radio has handed over (`MeshSession.onReceived`). */
  received(message: MessageRecord): void;
  /** The session changed: a drained queue is announced, and what was read loses its notice. */
  changed(): void;
  /** The app is in front of the reader, so the notice for several conversations has done its work. */
  opened(): void;
}

export function createAnnouncer(deps: {
  state: () => SessionState;
  /** Whether this message should ring (noticePrefs.ts). */
  wanted: Keep;
  show: (notice: Notice) => void;
  withdraw: (tag: string) => void;
}): Announcer {
  /** Messages handed over and not yet announced, by id. */
  const pending = new Set<string>();
  /** Conversations with a notice of their own out. */
  const out = new Set<string>();
  /** Whether the notice for several conversations is out. */
  let allOut = false;
  /** The unread counts at the last change, to see what has been read since. */
  let before = deps.state().unread;
  /** The wait for the burst of news coming now to stop; none between bursts. */
  let quiet: ReturnType<typeof setTimeout> | null = null;
  /** Whether the burst has yet to ring. */
  let unrung = false;
  /** When the burst's notices were last brought up to date. */
  let shownAt = 0;

  /** Shows what is pending, the first notice with the signal if `ring`; whether anything was shown. */
  function announce(state: SessionState, ring: boolean): boolean {
    // Each message by the conversation it is in now: one from an unknown
    // sender moves under the contact once the contact is read.
    const fresh = new Set<string>();
    for (const m of state.messages) {
      if (pending.has(m.id) && (state.unread[m.conversation] ?? 0) > 0 && deps.wanted(m)) fresh.add(m.conversation);
    }
    pending.clear();
    if (fresh.size === 0) return false;

    let shown = false;
    const show = (notice: Notice): void => {
      deps.show(ring && !shown ? notice : { ...notice, silent: true });
      shown = true;
    };
    if (allOut || new Set([...out, ...fresh]).size > SEPARATE) {
      for (const c of out) deps.withdraw(conversationTag(c));
      out.clear();
      const notice = allChatsNotice(state, deps.wanted);
      if (notice) {
        show(notice);
        allOut = true;
      }
      return shown;
    }
    for (const c of fresh) {
      const notice = conversationNotice(state, c, deps.wanted);
      if (!notice) continue;
      show(notice);
      out.add(c);
    }
    return shown;
  }

  /**
   * What is pending goes out once the queue is drained: at once, ringing, when
   * the burst has not rung; after that every `CATCH_UP_MS` while it goes on,
   * and once it is over.
   */
  function flush(): void {
    const state = deps.state();
    if (pending.size === 0 || state.syncing) return;
    const now = Date.now();
    if (unrung) {
      // What nobody wants to hear of leaves the burst still to ring for what they do.
      if (announce(state, true)) unrung = false;
      shownAt = now;
    } else if (!quiet || now - shownAt >= CATCH_UP_MS) {
      announce(state, false);
      shownAt = now;
    }
  }

  /** News came: the first after a quiet starts a burst, and each holds it open a moment longer. */
  function news(): void {
    if (quiet) clearTimeout(quiet);
    else unrung = true;
    quiet = setTimeout(() => {
      quiet = null;
      flush();
    }, QUIET_MS);
  }

  return {
    received(message) {
      pending.add(message.id);
      news();
      flush();
    },

    changed() {
      const state = deps.state();
      if (state.unread !== before) {
        // Read here, in a chat or with "Mark as read", or deleted. A notice
        // from an earlier run has the same tag, so it goes as well.
        for (const [c, n] of Object.entries(before)) {
          if (n > 0 && !state.unread[c]) {
            deps.withdraw(conversationTag(c));
            out.delete(c);
          }
        }
        if (!Object.values(state.unread).some((n) => n > 0) && Object.values(before).some((n) => n > 0)) {
          deps.withdraw(ALL_CHATS);
          allOut = false;
        }
        before = state.unread;
      }
      flush();
    },

    opened() {
      if (!allOut) return;
      deps.withdraw(ALL_CHATS);
      allOut = false;
    },
  };
}
