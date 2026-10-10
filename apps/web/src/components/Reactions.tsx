import { useRef, useState } from "react";
import type { MessageRecord } from "@meshnet/meshcore";
import { EMOJI_GROUPS, groupReactions, noteReaction, ownReaction, reactors, stripReactions, type EmojiGroup, type ReactionGroup, type Reactor } from "../lib/reactions.js";
import { session } from "../lib/session.js";
import { toast } from "../lib/toast.js";
import { closeMenu, setMenuExpanded } from "../ui/Menu.js";
import { Avatar } from "./Avatar.js";
import { BackIcon, ChevronDownIcon, ChevronRightIcon, ChevronUpIcon, RefreshIcon, SmileIcon } from "./Icons.js";
import { errorText } from "../i18n/errors.js";
import { locale, t } from "../i18n/index.js";

/** Puts an emoji on a channel message, or takes ours back with null; each is one flood. */
function react(message: MessageRecord, emoji: string | null): void {
  session.react(message.id, emoji).catch((error: unknown) => toast(errorText(error), "error"));
}

/** Who put an emoji on: us first, then the others by name. */
export function whoReacted(group: ReactionGroup): string {
  return [...(group.mine ? [t("chats.details.you")] : []), ...group.names].join(", ");
}

/** Everyone who put an emoji on a message, in words: "You, Alice and Kolya". */
function everyone(people: readonly Reactor[]): string {
  const names = [...new Set(people.map((p) => p.name ?? t("chats.details.you")))];
  try {
    return new Intl.ListFormat(locale(), { type: "conjunction" }).format(names);
  } catch {
    return names.join(", ");
  }
}

/** The faces of the first few who put an emoji on; ours under our own name. */
function Faces({ people }: { people: readonly Reactor[] }) {
  const self = session.getState().self?.name ?? "";
  const names = [...new Set(people.map((p) => p.name ?? self))].slice(0, 3);
  return (
    <span className="react-faces" aria-hidden="true">
      {names.map((name) => (
        <Avatar key={name} name={name} size={22} />
      ))}
    </span>
  );
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
 * aside. Ours is lit, and choosing it again takes it back. Under them, on a
 * message that has some, a row says who put them on, and opens the same way
 * into one line for each: a phone has no pointer to rest on a chip.
 */
export function ReactStrip({ message }: { message: MessageRecord }) {
  const mine = ownReaction(message.reactions);
  const [open, setOpen] = useState<"all" | "who" | null>(null);
  const grid = useRef<HTMLDivElement>(null);
  const people = reactors(message.reactions);
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
  const show = (next: "all" | "who" | null) => {
    setOpen(next);
    setMenuExpanded(next !== null);
  };
  const jump = (id: EmojiGroup) => {
    const section = grid.current?.querySelector<HTMLElement>(`[data-group="${id}"]`);
    if (section) grid.current!.scrollTo({ top: section.offsetTop, behavior: "smooth" });
  };
  return (
    <div className="react-picker">
      <div className="react-strip" role="group" aria-label={t("chats.react.pick")}>
        {stripReactions().map(button)}
        <button
          type="button"
          className="react-more"
          aria-label={open === "all" ? t("chats.react.less") : t("chats.react.more")}
          aria-expanded={open === "all"}
          onClick={() => show(open === "all" ? null : "all")}
        >
          <span>{open === "all" ? <ChevronUpIcon size={18} strokeWidth={2.2} /> : <ChevronDownIcon size={18} strokeWidth={2.2} />}</span>
        </button>
      </div>
      {open === null && people.length ? (
        <>
          <div className="react-line" role="separator" />
          <button type="button" className="react-who" aria-expanded={false} onClick={() => show("who")}>
            <SmileIcon size={18} />
            <span className="react-who-text">
              <span>{t("chats.react.count", { count: people.length })}</span>
              <small>{everyone(people)}</small>
            </span>
            <Faces people={people} />
            <ChevronRightIcon size={16} className="react-who-go" />
          </button>
        </>
      ) : null}
      {open === "who" ? (
        <>
          <div className="react-line" role="separator" />
          <button type="button" className="react-who react-back" aria-expanded={true} onClick={() => show(null)}>
            <BackIcon size={18} />
            <span className="react-who-text">{t("chats.react.count", { count: people.length })}</span>
          </button>
          <ul className="react-people">
            {people.map((p, i) => (
              <li key={i}>
                <Avatar name={p.name ?? session.getState().self?.name ?? ""} size={32} />
                <span className="react-person">{p.name ?? t("chats.details.you")}</span>
                <span className="react-person-emoji">{p.emoji}</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {open === "all" ? (
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
