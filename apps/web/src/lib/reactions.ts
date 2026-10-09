import type { MessageReaction } from "@meshnet/meshcore";

/** The emoji a held message offers, Telegram's first few. */
export const QUICK_REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🙏"] as const;

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

/** The emoji we put on the message, if any. */
export function ownReaction(reactions: readonly MessageReaction[] | undefined): string | null {
  return reactions?.find((r) => r.by === null)?.emoji ?? null;
}
