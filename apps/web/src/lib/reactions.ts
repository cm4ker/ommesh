import type { MessageReaction } from "@meshnet/meshcore";
import { readSetting, writeSetting } from "./storage.js";

/** The emoji a held message offers before any has been chosen, Telegram's first few. */
export const QUICK_REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🙏"] as const;

/** How many emoji the strip over a held message's menu shows. */
const STRIP_SIZE = 6;

/** How many emoji chosen lately are kept: the strip shows the first few, the full list all of them. */
export const RECENT_SIZE = 16;

/** The full list's first rows, with no heading: the emoji reached for most, radio people's own among them. */
export const TOP_REACTIONS = ["👍", "❤️", "🔥", "😂", "📡", "🙏", "😮", "🎉", "✅", "🫡", "🤝", "👀", "😢", "👏", "🤔", "💯"] as const;

/** Radio people's own, picked by hand: a group of its own ahead of Unicode's. */
export const RADIO_REACTIONS = ["📡", "📶", "🔋", "🪫", "⚡", "🛰️", "🗼", "📻", "🧭", "🗺️", "📍", "🏕️", "⛰️", "🌲", "🌧️", "❄️", "☀️", "🆘", "✅", "❌", "⚠️", "🔇", "🔊", "🔌"] as const;

/** The picks in the search field: a mood, for when no word comes to mind. */
export const MOODS = [
  { id: "love", items: ["❤️", "🥰", "😍", "😘", "💕", "💖", "💘", "💞", "🫶", "❤️‍🔥", "💗", "💓", "🧡", "💛", "💚", "💙", "💜", "🤍"] },
  { id: "yes", items: ["👍", "👌", "✅", "💯", "🙌", "👏", "🤝", "🫡", "✔️", "🆗", "🤙", "💪", "☑️", "🎯"] },
  { id: "no", items: ["👎", "❌", "🙅", "🛑", "⛔", "🚫", "😒", "🙄", "🤨", "😑", "🤦", "❎"] },
  { id: "party", items: ["🎉", "🥳", "🎊", "🎈", "🍾", "🥂", "🎁", "🎂", "🏆", "🎆", "🎇", "✨", "🪩", "🍻"] },
  { id: "joy", items: ["😀", "😃", "😄", "😁", "😆", "😅", "🤣", "😂", "🙂", "😊", "😇", "🤩", "😎", "🥳", "😺", "😸", "😹"] },
  { id: "sad", items: ["😢", "😭", "😞", "😔", "😟", "🙁", "🥺", "🥹", "😥", "😓", "😩", "😫", "💔", "😿"] },
] as const;

export type Mood = (typeof MOODS)[number]["id"];

const RECENT_KEY = "meshnet.recentReactions";
/** The emoji chosen lately, the latest first. */
let recent = ((saved) => (Array.isArray(saved) ? saved.filter((e): e is string => typeof e === "string") : []))(readSetting<unknown>(RECENT_KEY, []));

/** The strip's emoji: the ones chosen lately, then the first few until there are six. */
export function stripReactions(chosen: readonly string[] = recent): string[] {
  const out = chosen.slice(0, STRIP_SIZE);
  for (const emoji of QUICK_REACTIONS) if (!out.includes(emoji)) out.push(emoji);
  return out.slice(0, STRIP_SIZE);
}

/** Puts an emoji at the head of the ones chosen lately. */
export function noteReaction(emoji: string): void {
  setRecentReactions([emoji, ...recent.filter((e) => e !== emoji)]);
}

export function recentReactions(): readonly string[] {
  return recent;
}

export function setRecentReactions(emoji: readonly string[]): void {
  recent = emoji.slice(0, RECENT_SIZE);
  writeSetting(RECENT_KEY, recent);
}

/**
 * How far ours on a channel went: still waiting to hear a repeater send it
 * on, heard sent on so many times, or sent on by none within the window.
 */
export type Carried = "waiting" | "unheard" | number;

/** Where ours stands; null for others', and where nothing is watched. */
export function carried(reaction: MessageReaction): Carried | null {
  if (reaction.by !== null) return null;
  if (reaction.unheard) return "unheard";
  if (reaction.relays === undefined) return null;
  return reaction.relays === 0 ? "waiting" : reaction.relays;
}

/** One emoji on a message: how many put it there, whether we did, and who did, ours first. */
export interface ReactionGroup {
  emoji: string;
  count: number;
  mine: boolean;
  /** Ours: how far it went. Unheard, a tap sends it again. */
  carried: Carried | null;
  /** The names of the others; ours is `mine`. */
  names: string[];
}

/** A message's reactions gathered by emoji, in the order each emoji first came. */
export function groupReactions(reactions: readonly MessageReaction[] | undefined): ReactionGroup[] {
  const groups = new Map<string, ReactionGroup>();
  for (const r of reactions ?? []) {
    let group = groups.get(r.emoji);
    if (!group) groups.set(r.emoji, (group = { emoji: r.emoji, count: 0, mine: false, carried: null, names: [] }));
    group.count++;
    if (r.by === null) {
      group.mine = true;
      group.carried = carried(r);
    } else if (!group.names.includes(r.by)) group.names.push(r.by);
  }
  return [...groups.values()];
}

/** One emoji someone put on a message; `name` null is ours, with how far it went. */
export interface Reactor {
  emoji: string;
  name: string | null;
  carried: Carried | null;
}

/** Who put what on a message, one line each: ours first, then the others as they came. */
export function reactors(reactions: readonly MessageReaction[] | undefined): Reactor[] {
  const all = (reactions ?? []).map((r) => ({ emoji: r.emoji, name: r.by, carried: carried(r) }));
  return [...all.filter((r) => r.name === null), ...all.filter((r) => r.name !== null)];
}

/** The emoji we put on the message, if any. */
export function ownReaction(reactions: readonly MessageReaction[] | undefined): string | null {
  return reactions?.find((r) => r.by === null)?.emoji ?? null;
}
