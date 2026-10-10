import type { MessageReaction } from "@meshnet/meshcore";
import { readSetting, writeSetting } from "./storage.js";

/** The emoji a held message offers before any has been chosen, Telegram's first few. */
export const QUICK_REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🙏"] as const;

/** How many emoji the strip over a held message's menu shows. */
const STRIP_SIZE = 6;

/**
 * Every emoji a reaction can be chosen from, in groups. Picked by hand rather
 * than the whole of Unicode: a reaction wants a few dozen faces and signs, and
 * radio people want their own first.
 */
export const EMOJI_GROUPS = [
  { id: "radio", items: ["📡", "📶", "🔋", "🪫", "⚡", "🛰️", "🗼", "📻", "🧭", "🗺️", "📍", "🏕️", "⛰️", "🌲", "🌧️", "❄️", "☀️", "🆘", "✅", "❌", "⚠️", "🔇", "🔊", "🔌"] },
  { id: "faces", items: ["😀", "😁", "😂", "🤣", "😅", "😊", "😍", "🥰", "😘", "😎", "🤩", "🤔", "🤨", "😐", "😏", "🙄", "😬", "😮", "😯", "😲", "😳", "🥺", "😢", "😭", "😤", "😡", "🤯", "😱", "🥶", "🥵", "😴", "🤗", "🫡", "😇", "🤓", "🥳"] },
  { id: "hands", items: ["👍", "👎", "👌", "✌️", "🤞", "🤙", "👋", "👏", "🙌", "🙏", "💪", "🤝", "✊", "👊", "🫶", "👀"] },
  { id: "hearts", items: ["❤️", "🧡", "💛", "💚", "💙", "💜", "🖤", "🤍", "💔", "❤️‍🔥", "💯", "✨"] },
  { id: "other", items: ["🔥", "🎉", "🎊", "🏆", "⭐", "🌟", "💡", "🎯", "🚀", "⏰", "☕", "🍺", "🍕", "🎂", "🐈", "🐕", "🦆", "🌈", "🌙", "☔", "🚗", "🚲", "🏠", "🍄", "💩", "🤡", "👻", "🤖"] },
] as const;

export type EmojiGroup = (typeof EMOJI_GROUPS)[number]["id"];

const RECENT_KEY = "meshnet.recentReactions";
/** The emoji chosen lately, the latest first; kept on this device only. */
let recent = ((saved) => (Array.isArray(saved) ? saved.filter((e): e is string => typeof e === "string") : []))(readSetting<unknown>(RECENT_KEY, []));

/** The strip's emoji: the ones chosen lately, then the first few until there are six. */
export function stripReactions(chosen: readonly string[] = recent): string[] {
  const out = [...chosen];
  for (const emoji of QUICK_REACTIONS) if (!out.includes(emoji)) out.push(emoji);
  return out.slice(0, STRIP_SIZE);
}

/** Puts an emoji at the head of the strip. */
export function noteReaction(emoji: string): void {
  recent = [emoji, ...recent.filter((e) => e !== emoji)].slice(0, STRIP_SIZE);
  writeSetting(RECENT_KEY, recent);
}

/** One emoji on a message: how many put it there, whether we did, and who did, ours first. */
export interface ReactionGroup {
  emoji: string;
  count: number;
  mine: boolean;
  /** Ours, and no repeater was heard sending it on: a tap sends it again. */
  unheard: boolean;
  /** The names of the others; ours is `mine`. */
  names: string[];
}

/** A message's reactions gathered by emoji, in the order each emoji first came. */
export function groupReactions(reactions: readonly MessageReaction[] | undefined): ReactionGroup[] {
  const groups = new Map<string, ReactionGroup>();
  for (const r of reactions ?? []) {
    let group = groups.get(r.emoji);
    if (!group) groups.set(r.emoji, (group = { emoji: r.emoji, count: 0, mine: false, unheard: false, names: [] }));
    group.count++;
    if (r.by === null) {
      group.mine = true;
      group.unheard = !!r.unheard;
    } else if (!group.names.includes(r.by)) group.names.push(r.by);
  }
  return [...groups.values()];
}

/** One emoji someone put on a message; `name` null is ours. */
export interface Reactor {
  emoji: string;
  name: string | null;
}

/** Who put what on a message, one line each: ours first, then the others as they came. */
export function reactors(reactions: readonly MessageReaction[] | undefined): Reactor[] {
  const all = (reactions ?? []).map((r) => ({ emoji: r.emoji, name: r.by }));
  return [...all.filter((r) => r.name === null), ...all.filter((r) => r.name !== null)];
}

/** The emoji we put on the message, if any. */
export function ownReaction(reactions: readonly MessageReaction[] | undefined): string | null {
  return reactions?.find((r) => r.by === null)?.emoji ?? null;
}
