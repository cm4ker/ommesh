import type { MessageRecord } from "@meshnet/meshcore";
import { groupReactions, ownReaction, QUICK_REACTIONS, type ReactionGroup } from "../lib/reactions.js";
import { session } from "../lib/session.js";
import { toast } from "../lib/toast.js";
import { closeMenu } from "../ui/Menu.js";
import { errorText } from "../i18n/errors.js";
import { t } from "../i18n/index.js";

/** Puts an emoji on a channel message, or takes ours back with null; each is one flood. */
function react(message: MessageRecord, emoji: string | null): void {
  session.react(message.id, emoji).catch((error: unknown) => toast(errorText(error), "error"));
}

/** Who put an emoji on: us first, then the others by name. */
export function whoReacted(group: ReactionGroup): string {
  return [...(group.mine ? [t("chats.details.you")] : []), ...group.names].join(", ");
}

/** The row of emoji over a held message's menu; ours is lit, and choosing it again takes it back. */
export function ReactStrip({ message }: { message: MessageRecord }) {
  const mine = ownReaction(message.reactions);
  return (
    <div className="react-strip" role="group" aria-label={t("chats.react.pick")}>
      {QUICK_REACTIONS.map((emoji) => (
        <button
          key={emoji}
          type="button"
          className={emoji === mine ? "on" : ""}
          aria-pressed={emoji === mine}
          onClick={() => {
            closeMenu();
            react(message, emoji === mine ? null : emoji);
          }}
        >
          {emoji}
        </button>
      ))}
    </div>
  );
}

/**
 * The emoji on a message, under its text, each with how many put it there. A
 * tap puts the same one on, or takes ours back; `live` is false while
 * messages are being picked, or where nothing can be sent.
 */
export function Reactions({ message, live }: { message: MessageRecord; live: boolean }) {
  const groups = groupReactions(message.reactions);
  if (!groups.length) return null;
  return (
    <span className="msg-reacts">
      {groups.map((g) => {
        const inner = (
          <>
            <span className="react-emoji">{g.emoji}</span>
            <span>{g.count}</span>
          </>
        );
        const className = ["react-chip", g.mine ? "mine" : ""].join(" ");
        return live ? (
          <button
            key={g.emoji}
            type="button"
            className={className}
            title={whoReacted(g)}
            aria-pressed={g.mine}
            onClick={(e) => {
              e.stopPropagation();
              react(message, g.mine ? null : g.emoji);
            }}
            // Enter on the chip is the chip's, not the bubble's.
            onKeyDown={(e) => e.stopPropagation()}
          >
            {inner}
          </button>
        ) : (
          <span key={g.emoji} className={className} title={whoReacted(g)}>
            {inner}
          </span>
        );
      })}
    </span>
  );
}

/** Who put what on a message, one line per emoji, for its details. */
export function ReactionNames({ message }: { message: MessageRecord }) {
  const groups = groupReactions(message.reactions);
  if (!groups.length) return null;
  return (
    <div className="details-reacts">
      {groups.map((g) => (
        <span key={g.emoji}>
          <span className="react-emoji">{g.emoji}</span> {whoReacted(g)}
        </span>
      ))}
    </div>
  );
}
