import { useEffect, useRef, useState, type MouseEvent, type PointerEvent } from "react";
import { createPortal } from "react-dom";
import type { MessageRecord } from "@meshnet/meshcore";
import { emojiName, useEmojiData } from "../lib/emojiData.js";
import { haptic } from "../lib/haptic.js";
import { groupReactions, noteReaction, ownReaction, reactors, stripReactions, type Carried, type ReactionGroup, type Reactor } from "../lib/reactions.js";
import { session } from "../lib/session.js";
import { toast } from "../lib/toast.js";
import { closeMenu, setMenuExpanded } from "../ui/Menu.js";
import { Avatar } from "./Avatar.js";
import { EmojiPicker } from "./EmojiPicker.js";
import { BackIcon, ChevronDownIcon, ChevronRightIcon, RefreshIcon, SmileIcon } from "./Icons.js";
import { errorText } from "../i18n/errors.js";
import { locale, t, useLanguage } from "../i18n/index.js";

/** Puts an emoji on a channel message, or takes ours back with null; each is one flood. */
function react(message: MessageRecord, emoji: string | null): void {
  session.react(message.id, emoji).catch((error: unknown) => toast(errorText(error), "error"));
}

/** Who put an emoji on: us first, then the others by name. */
export function whoReacted(group: ReactionGroup): string {
  return [...(group.mine ? [t("chats.details.you")] : []), ...group.names].join(", ");
}

/** How far ours went, in words. */
function carriedText(carried: Carried): string {
  if (carried === "waiting") return t("chats.react.waiting");
  if (carried === "unheard") return t("chats.react.notRelayed");
  return t("chats.react.relayed", { count: carried });
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

/**
 * The emoji over a held message's menu: the ones chosen lately, and a button
 * that opens the same card out into every emoji (EmojiPicker), the menu's
 * items stepping aside. Ours is lit, and choosing it again takes it back.
 * Under them, on a message that has some, a row says who put them on, and
 * opens the same way into one line for each: a phone has no pointer to rest
 * on a chip.
 */
export function ReactStrip({ message }: { message: MessageRecord }) {
  const mine = ownReaction(message.reactions);
  const [open, setOpen] = useState<"all" | "who" | null>(null);
  const people = reactors(message.reactions);
  const choose = (emoji: string) => {
    closeMenu();
    if (emoji !== mine) noteReaction(emoji);
    react(message, emoji === mine ? null : emoji);
  };
  const show = (next: "all" | "who" | null) => {
    setOpen(next);
    setMenuExpanded(next !== null, next === "all");
  };
  if (open === "all") return <EmojiPicker mine={mine} onPick={choose} onFold={() => show(null)} />;
  return (
    <div className="react-picker">
      <div className="react-strip" role="group" aria-label={t("chats.react.pick")}>
        {stripReactions().map((emoji) => (
          <button key={emoji} type="button" className={emoji === mine ? "on" : ""} aria-pressed={emoji === mine} onClick={() => choose(emoji)}>
            {emoji}
          </button>
        ))}
        <button type="button" className="react-more" aria-label={t("chats.react.more")} aria-expanded={false} onClick={() => show("all")}>
          <span>
            <ChevronDownIcon size={18} strokeWidth={2.2} />
          </span>
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
                <span className="react-person">
                  {p.name ?? t("chats.details.you")}
                  {p.carried !== null ? <small>{carriedText(p.carried)}</small> : null}
                </span>
                <span className="react-person-emoji">{p.emoji}</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}

/** How long a chip is held before its emoji shows large, ms: less than the message's own hold, so its menu never comes first. */
const PEEK_MS = 380;

/**
 * An emoji put on a message, large, over the chip held: its name, how many
 * put it on and who. It shows only while the finger, or the mouse button,
 * stays down; letting go puts it away, and is no tap.
 */
function Peek({ group, at }: { group: ReactionGroup; at: DOMRect }) {
  const data = useEmojiData(useLanguage());
  const name = emojiName(data, group.emoji);
  const width = 172;
  const left = Math.min(window.innerWidth - width - 8, Math.max(8, at.left + at.width / 2 - width / 2));
  // Over the chip where there is room, as a finger hides what is under it; else under it.
  const above = at.top > 220;
  const place = above ? { left, bottom: window.innerHeight - at.top + 10 } : { left, top: at.bottom + 10 };
  return createPortal(
    <div className={["react-peek", above ? "" : "below"].join(" ")} role="tooltip" style={place}>
      <span className="react-peek-emoji" aria-hidden="true">
        {group.emoji}
      </span>
      <span className="react-peek-name">{name ? `${name} · ${group.count}` : t("chats.react.count", { count: group.count })}</span>
      <span className="react-peek-who">{whoReacted(group)}</span>
      {group.carried !== null ? <span className="react-peek-who">{carriedText(group.carried)}</span> : null}
    </div>,
    document.body,
  );
}

/**
 * The emoji on a message, under its text, each with how many put it there. A
 * tap puts the same one on, or takes ours back; `live` is false while
 * messages are being picked, or where nothing can be sent.
 */
export function Reactions({ message, live }: { message: MessageRecord; live: boolean }) {
  const groups = groupReactions(message.reactions);
  const [peek, setPeek] = useState<{ group: ReactionGroup; at: DOMRect } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The emoji showed large: the click that ends the hold is no tap.
  const shown = useRef(false);
  const stop = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    setPeek(null);
  };
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );
  if (!groups.length) return null;
  const hold = (g: ReactionGroup) => ({
    onPointerDown: (e: PointerEvent<HTMLButtonElement>) => {
      // Held here, the chip shows its emoji large rather than the message's menu.
      e.stopPropagation();
      if (e.pointerType === "mouse" && e.button !== 0) return;
      const chip = e.currentTarget;
      shown.current = false;
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        timer.current = null;
        shown.current = true;
        haptic();
        setPeek({ group: g, at: chip.getBoundingClientRect() });
      }, PEEK_MS);
    },
    onPointerUp: stop,
    onPointerCancel: stop,
    onPointerLeave: stop,
    onContextMenu: (e: MouseEvent) => {
      // A finger's long press, for which Android asks for a menu too. A right click still opens the message's.
      if (timer.current === null && !shown.current) return;
      e.preventDefault();
      e.stopPropagation();
    },
    onClickCapture: (e: MouseEvent) => {
      if (!shown.current) return;
      shown.current = false;
      e.preventDefault();
      e.stopPropagation();
    },
  });
  return (
    <span className="msg-reacts">
      {groups.map((g) => {
        const inner = (
          <>
            <span className="react-emoji">{g.emoji}</span>
            <span>{g.count}</span>
            {g.carried === "unheard" ? <RefreshIcon size={12} strokeWidth={2.6} /> : null}
          </>
        );
        // Ours outlined while it waits for a repeater, filled once one sends it on, dashed if none did.
        const className = ["react-chip", g.mine ? "mine" : "", g.carried === "waiting" || g.carried === "unheard" ? g.carried : ""].join(" ");
        const title = g.carried === null ? whoReacted(g) : `${whoReacted(g)}\n${g.carried === "unheard" ? t("chats.react.unheard") : carriedText(g.carried)}`;
        return live ? (
          <button
            key={g.emoji}
            type="button"
            className={className}
            title={title}
            aria-pressed={g.mine}
            {...hold(g)}
            onClick={(e) => {
              e.stopPropagation();
              // Ours that nobody sent on goes again; ours that went out is taken back.
              react(message, g.mine && g.carried !== "unheard" ? null : g.emoji);
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
      {peek ? <Peek group={peek.group} at={peek.at} /> : null}
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
