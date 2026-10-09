import { useRef, useState } from "react";
import type { MessageRecord } from "@meshnet/meshcore";
import { EMOJI_GROUPS, groupReactions, noteReaction, ownReaction, stripReactions, type EmojiGroup, type ReactionGroup } from "../lib/reactions.js";
import { session } from "../lib/session.js";
import { toast } from "../lib/toast.js";
import { closeMenu, setMenuExpanded } from "../ui/Menu.js";
import { ChevronDownIcon, ChevronUpIcon, RefreshIcon } from "./Icons.js";
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

function groupName(id: EmojiGroup): string {
  switch (id) {
    case "radio":
      return t("chats.react.groupRadio");
    case "faces":
      return t("chats.react.groupFaces");
    case "hands":
      return t("chats.react.groupHands");
    case "hearts":
      return t("chats.react.groupHearts");
    case "other":
      return t("chats.react.groupOther");
  }
}

/**
 * The emoji over a held message's menu: the ones chosen lately, and a button
 * that opens the same card out into every emoji, the menu's items stepping
 * aside. Ours is lit, and choosing it again takes it back.
 */
export function ReactStrip({ message }: { message: MessageRecord }) {
  const mine = ownReaction(message.reactions);
  const [open, setOpen] = useState(false);
  const grid = useRef<HTMLDivElement>(null);
  const button = (emoji: string) => (
    <button
      key={emoji}
      type="button"
      className={emoji === mine ? "on" : ""}
      aria-pressed={emoji === mine}
      onClick={() => {
        closeMenu();
        if (emoji !== mine) noteReaction(emoji);
        react(message, emoji === mine ? null : emoji);
      }}
    >
      {emoji}
    </button>
  );
  const toggle = () => {
    setOpen(!open);
    setMenuExpanded(!open);
  };
  const jump = (id: EmojiGroup) => {
    const section = grid.current?.querySelector<HTMLElement>(`[data-group="${id}"]`);
    if (section) grid.current!.scrollTo({ top: section.offsetTop, behavior: "smooth" });
  };
  return (
    <div className="react-picker">
      <div className="react-strip" role="group" aria-label={t("chats.react.pick")}>
        {stripReactions().map(button)}
        <button type="button" className="react-more" aria-label={open ? t("chats.react.less") : t("chats.react.more")} aria-expanded={open} onClick={toggle}>
          <span>{open ? <ChevronUpIcon size={18} strokeWidth={2.2} /> : <ChevronDownIcon size={18} strokeWidth={2.2} />}</span>
        </button>
      </div>
      {open ? (
        <>
          <div className="react-tabs">
            {EMOJI_GROUPS.map((g) => (
              <button key={g.id} type="button" onClick={() => jump(g.id)}>
                {groupName(g.id)}
              </button>
            ))}
          </div>
          <div ref={grid} className="react-grid-scroll">
            {EMOJI_GROUPS.map((g) => (
              <section key={g.id} data-group={g.id} aria-label={groupName(g.id)}>
                <div className="react-group-name">{groupName(g.id)}</div>
                <div className="react-grid">{g.items.map(button)}</div>
              </section>
            ))}
          </div>
        </>
      ) : null}
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
            {g.unheard ? <RefreshIcon size={12} strokeWidth={2.6} /> : null}
          </>
        );
        const className = ["react-chip", g.mine ? "mine" : "", g.unheard ? "unheard" : ""].join(" ");
        const title = g.unheard ? `${whoReacted(g)}\n${t("chats.react.unheard")}` : whoReacted(g);
        return live ? (
          <button
            key={g.emoji}
            type="button"
            className={className}
            title={title}
            aria-pressed={g.mine}
            onClick={(e) => {
              e.stopPropagation();
              // Ours that nobody sent on goes again; ours that went out is taken back.
              react(message, g.mine && !g.unheard ? null : g.emoji);
            }}
            // Enter on the chip is the chip's, not the bubble's.
            onKeyDown={(e) => e.stopPropagation()}
          >
            {inner}
          </button>
        ) : (
          <span key={g.emoji} className={className} title={title}>
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
