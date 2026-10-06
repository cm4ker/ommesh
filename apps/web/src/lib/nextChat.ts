/**
 * The chat a pull up past the end of one opens on the phone (#80), as Telegram
 * goes on to the next unread channel: the first one down the chat list with
 * messages unread, so the reader goes through them without the list.
 */

import type { SessionState } from "@meshnet/meshcore";
import { chatsInOrder, getChatOrder } from "./chatOrder.js";
import { getPins } from "./chatPins.js";
import { summarize, type ConversationSummary } from "./conversations.js";
import { openConversation } from "./nav.js";
import { chatLevel, getNoticePrefs } from "./noticePrefs.js";

/** The first of the rows, in the list's order, with unread messages; not this one, nor one the reader keeps quiet. */
export function nextUnread(rows: readonly ConversationSummary[], current: string, quiet: (id: string) => boolean): ConversationSummary | null {
  return rows.find((r) => r.id !== current && r.unread > 0 && !quiet(r.id)) ?? null;
}

/** The next unread chat after this one, the way the chat list orders them now. */
export function nextUnreadChat(state: SessionState, current: string): ConversationSummary | null {
  const rows = chatsInOrder(summarize(state), getChatOrder(), getPins(state.self?.key ?? "", state.channels));
  const prefs = getNoticePrefs();
  return nextUnread(rows, current, (id) => chatLevel(prefs, state, id) === "off");
}

let arriving: { conversation: string; at: number } | null = null;

/** Opens it in place of this one, so Back still goes to the list; its messages rise in from below. */
export function openNextChat(conversation: string): void {
  arriving = { conversation, at: Date.now() };
  openConversation(conversation);
}

/**
 * Whether the chat opening now came by a pull. Read, not taken: a view's first
 * state is made twice in development, and the second must hear the same.
 */
export function cameByPull(conversation: string): boolean {
  return arriving?.conversation === conversation && Date.now() - arriving.at < 1000;
}
