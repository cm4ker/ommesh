/**
 * Where a message is written: one frame holding the text and its button, the
 * outline of a bubble with nothing painted in it, and no hint text, since the
 * chat above says where the message goes. What the message costs stays in
 * sight: the frame's lower edge fills as the bytes run out, ticked where
 * the cipher adds another 16-byte block, and a tag above it gives the bytes
 * and the time on air. What does not fit is marked in the text itself, with
 * ways out: in parts, with more letters swapped for Latin ones, or in Latin.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { AdvType, parseConversation } from "@meshnet/meshcore";
import { onAsk, takeAsk } from "../lib/chatAsk.js";
import { costOf, blockEdges, ceilingOf, hasCyrillic, headerBytes, mentionOf, mentionQuery, pathBytes, quoteOf, segments, withFormat, splitParts, translit } from "../lib/composer.js";
import { messagesIn } from "../lib/conversations.js";
import { getDraft, setDraft } from "../lib/drafts.js";
import { rememberRough, setPlace, updatePlace, usePlace } from "../lib/placeDraft.js";
import { attachPlace, placeLine, placeReady, PlaceBar, PlacePanel, usePlaceFollow } from "./ComposerPlace.js";
import { raiseKeyboard } from "../lib/keyboard.js";
import { utf8Length } from "../lib/format.js";
import { ALL_SETS, looksDifferent, packLookalikes, useLookalikePrefs } from "../lib/lookalikes.js";
import { touchFirst } from "../lib/platform.js";
import { usePress } from "../lib/press.js";
import { session, useSession } from "../lib/session.js";
import { FORMAT_CHOICES, formatAround, formatKey, formatRuns, keysOf, plainText, toggleFormat, type FormatChoice, type FormatKind } from "../lib/textFormat.js";
import { noteFormatSelection, offerFormatMenu } from "../lib/formatMenu.js";
import { toast } from "../lib/toast.js";
import { showMenu, type MenuItem } from "../ui/Menu.js";
import { Avatar } from "./Avatar.js";
import { CheckIcon, ClockIcon, CloseIcon, LocationIcon, ReplyIcon, SendIcon, TextIcon, WavesIcon } from "./Icons.js";
import { t } from "../i18n/index.js";
import { tx } from "../i18n/rich.js";

/** A message being answered: on the air, its author's name and the start of it before the text. */
export interface Reply {
  id: string;
  name: string;
  text: string;
}

const share = (n: number, ceiling: number) => `${(Math.min(n, ceiling) / ceiling) * 100}%`;

/** How the layer under the field marks formatted text; bold and italic it cannot show (composer.css). */
const FORMAT_CLASS: Partial<Record<FormatKind, string>> = { strike: "fs", code: "fc", block: "fc", spoiler: "fh" };

const MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

export function Composer({ conversation, title, reply, onReplyDone, onSent }: { conversation: string; title: string; reply: Reply | null; onReplyDone: () => void; onSent: () => void }) {
  const state = useSession();
  const lookalikes = useLookalikePrefs();
  const radio = state.self?.key ?? "";
  const [text, setText] = useState(() => getDraft(radio, conversation));
  const [focused, setFocused] = useState(false);
  const [pick, setPick] = useState<{ start: number; end: number; query: string; index: number } | null>(null);
  const [shake, setShake] = useState(false);
  // A message too long for the radio may go with every set of lookalikes, those alike as written
  // by hand too, without turning them on for every message.
  const [cursive, setCursive] = useState(false);
  const [touch] = useState(touchFirst);
  // A finger or the mouse holding the pin of an empty field.
  const [holding, setHolding] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  const mirror = useRef<HTMLDivElement>(null);
  // The line a reply put at the head of the field. While it is there as it was put, it is the
  // reply's, not the writer's: it goes when the reply does, and a draft is kept without it.
  const quoted = useRef("");

  const target = parseConversation(conversation);
  const contact = target.kind === "contact" ? state.contacts[target.key] : undefined;
  const online = state.status === "ready";
  const self = state.self;
  const sets = cursive ? ALL_SETS : lookalikes;
  const pack = useCallback((t: string) => packLookalikes(t, sets), [sets]);
  const mention = reply ? mentionOf(reply.name) : "";
  // A place put in the field goes first in the message, before the text, as one more part of what heads it.
  const place = usePlace(radio, conversation);
  usePlaceFollow(radio, conversation, place);
  const line = place ? placeLine(place) : "";
  const prefix = (target.kind === "channel" ? `${self?.name ?? ""}: ` : "") + mention + (line ? `${line} ` : "");
  const header = target.kind === "channel" ? headerBytes("channel") : headerBytes("direct", contact ? pathBytes(contact.outPathLen) : 0);
  const shape = self ? { spreadingFactor: self.spreadingFactor, bandwidthHz: self.bandwidthHz, codingRate: self.codingRate } : null;
  const ceiling = ceilingOf(target.kind === "channel" ? "channel" : contact?.type === AdvType.Room ? "room" : "direct");
  const cost = costOf(text, { pack, prefix, ceiling, header, radio: shape });
  const body = text.trim();
  const head = quoted.current && text.startsWith(quoted.current) ? quoted.current : "";
  // A quote with nothing written under it is not a message yet; a place alone is.
  const empty = text.slice(head.length).trim() === "";
  const nothing = empty && !place;
  const over = cost.over > 0;
  const tone = over ? "over" : cost.used >= cost.budget * 0.8 ? "warn" : "";
  // The tag counts the place with the text, as the reader sees one message.
  const lineBytes = line ? utf8Length(line) + 1 : 0;
  const shownUsed = cost.used + (line && !empty ? lineBytes : line ? lineBytes - 1 : 0);
  const shownBudget = cost.budget + lineBytes;

  const messages = useMemo(() => messagesIn(state, conversation), [state, conversation]);
  // Who can be named: whoever has written in this channel or room, the latest first.
  const many = target.kind === "channel" || contact?.type === AdvType.Room;
  const people = useMemo(() => {
    if (!many) return [];
    const seen = new Set<string>([self?.name ?? ""]);
    const out: string[] = [];
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]!;
      if (m.direction !== "in" || !m.sender || seen.has(m.sender)) continue;
      seen.add(m.sender);
      out.push(m.sender);
    }
    return out;
  }, [many, messages, self?.name]);
  const matches = pick ? people.filter((n) => n.toLowerCase().includes(pick.query.toLowerCase())).slice(0, 6) : [];

  useEffect(() => setDraft(radio, conversation, text.slice(head.length)), [radio, conversation, text, head]);
  // The more letters are swapped for one message; another chat, or an empty field, starts afresh.
  useEffect(() => setCursive(false), [conversation]);
  useEffect(() => {
    if (!text.trim()) setCursive(false);
  }, [text]);

  useLayoutEffect(() => {
    const el = field.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
    if (mirror.current) mirror.current.scrollTop = el.scrollTop;
  }, [text]);

  /** Puts `insert` over [from, to) as typing would, so that Undo takes it back. */
  const replace = (from: number, to: number, insert: string) => {
    const el = field.current;
    if (!el) {
      setText(text.slice(0, from) + insert + text.slice(to));
      return;
    }
    el.focus({ preventScroll: true });
    el.setSelectionRange(from, to);
    if (!document.execCommand(insert ? "insertText" : "delete", false, insert)) {
      el.setRangeText(insert, from, to, "end");
      setText(el.value);
    }
  };

  /**
   * The selection put in markers, or taken out of them, as one edit Undo can take back, with the
   * same words selected after. `range` is the selection the menu was opened on.
   */
  const format = (choice: FormatChoice, range?: readonly [number, number]) => {
    const el = field.current;
    if (!el) return;
    const [start, end] = range ?? [el.selectionStart, el.selectionEnd];
    const was = el.value;
    const next = toggleFormat(was, start, end, choice);
    if (!next) return;
    // Only the stretch that changes is typed over.
    let a = 0;
    while (a < was.length && a < next.text.length && was[a] === next.text[a]) a++;
    let b = 0;
    while (b < was.length - a && b < next.text.length - a && was[was.length - 1 - b] === next.text[next.text.length - 1 - b]) b++;
    replace(a, was.length - b, next.text.slice(a, next.text.length - b));
    el.setSelectionRange(next.start, next.end);
  };

  // The phone's own menu over selected text offers the formatting too (lib/formatMenu.ts), for as long as the field has the focus.
  const formatNow = useRef(format);
  formatNow.current = format;
  useEffect(() => () => offerFormatMenu(null), []);

  /** Cut or copy from the menu: the selection it was opened on, picked again, then as the keys would. */
  const clip = (kind: "cut" | "copy", [start, end]: readonly [number, number]) => {
    const el = field.current;
    if (!el) return;
    el.focus({ preventScroll: true });
    el.setSelectionRange(start, end);
    if (document.execCommand(kind)) return;
    void navigator.clipboard?.writeText(el.value.slice(start, end));
    if (kind === "cut") replace(start, end, "");
  };

  /** A browser may refuse to read the clipboard for a page; the keys always can. */
  const paste = async ([start, end]: readonly [number, number]) => {
    try {
      const got = await navigator.clipboard.readText();
      replace(start, end, got);
    } catch {
      toast(t("chats.format.pasteKeys", { keys: MAC ? "⌘V" : "Ctrl+V" }));
    }
  };

  /** What a right click on selected text offers: the field's own edits, then the formatting, with its keys. */
  const formatMenu = (e: MouseEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget;
    // A finger's hold keeps the system's menu, as does a click with nothing selected.
    if (touch || el.selectionStart === el.selectionEnd) return;
    e.preventDefault();
    const range = [el.selectionStart, el.selectionEnd] as const;
    const items: MenuItem[] = [
      { label: t("chats.format.cut"), shortcut: MAC ? "⌘X" : "Ctrl+X", onSelect: () => clip("cut", range) },
      { label: t("chats.format.copy"), shortcut: MAC ? "⌘C" : "Ctrl+C", onSelect: () => clip("copy", range) },
      { label: t("chats.format.paste"), shortcut: MAC ? "⌘V" : "Ctrl+V", onSelect: () => void paste(range) },
      ...FORMAT_CHOICES.map((choice, i) => ({
        label: t(`chats.format.${choice}`),
        shortcut: keysOf(choice, MAC),
        group: i === 0,
        checked: formatAround(el.value, range[0], range[1], choice) || undefined,
        onSelect: () => format(choice, range),
      })),
    ];
    showMenu(items, { at: { x: e.clientX, y: e.clientY } });
  };

  // With a real keyboard, a chat opened is a chat to write in: the caret waits in the field, so
  // what is typed next goes there without a click on it first. A field that already has the focus
  // keeps it: the chat's own search, opened with it, or the list's, stepped through with Alt+arrows.
  // On a phone the keyboard would come up over the chat, so there the field waits for a tap.
  useLayoutEffect(() => {
    const el = field.current;
    if (touch || !el || document.activeElement?.closest("input, textarea, [contenteditable]")) return;
    el.focus({ preventScroll: true });
    el.setSelectionRange(el.value.length, el.value.length);
  }, [conversation]);

  // A reply chosen is a reply to be written: the start of the message it answers heads the field,
  // the caret goes under it, and on a phone the keyboard comes up.
  useLayoutEffect(() => {
    const el = field.current;
    if (!reply || !el) return;
    // Their later messages here, for the quote to run on until it tells this one from them.
    const at = messages.findIndex((m) => m.id === reply.id);
    const later = at < 0 ? [] : messages.slice(at + 1).filter((m) => m.direction === "in" && m.sender === reply.name).map((m) => plainText(m.text));
    // Quoted without its markers: the bytes go to its words, and another app reads them plain.
    const said = quoteOf(plainText(reply.text), later);
    const line = said ? `>${said}\n` : "";
    const was = quoted.current && el.value.startsWith(quoted.current) ? quoted.current.length : 0;
    quoted.current = line;
    if (el.value.slice(0, was) !== line) replace(0, was, line);
    el.focus({ preventScroll: true });
    el.setSelectionRange(el.value.length, el.value.length);
    raiseKeyboard();
  }, [reply]);

  // A name asked for from the list of who writes (#64): it heads the field, past a reply's quote,
  // and the keyboard comes up for the rest. Asked while the chat is open, as on the desktop, too.
  const putName = useRef<(name: string) => void>(() => {});
  putName.current = (name) => {
    const el = field.current;
    if (!el) return;
    const tag = mentionOf(name);
    const at = quoted.current && el.value.startsWith(quoted.current) ? quoted.current.length : 0;
    if (!el.value.startsWith(tag, at)) replace(at, at, tag);
    el.focus({ preventScroll: true });
    el.setSelectionRange(el.value.length, el.value.length);
    raiseKeyboard();
  };
  useLayoutEffect(() => {
    const asked = takeAsk(conversation, "mention");
    if (asked) putName.current(asked.name);
    return onAsk((ask) => {
      if (ask.conversation !== conversation || ask.kind !== "mention") return;
      takeAsk(conversation, "mention");
      putName.current(ask.name);
    });
  }, [conversation]);

  // What another app shared (#88), with this chat picked for it: after whatever was already written,
  // for the reader to look over and send, with the keyboard up.
  const putShared = useRef<(text: string) => void>(() => {});
  putShared.current = (shared) => {
    const el = field.current;
    if (!el) return;
    const end = el.value.length;
    replace(end, end, (el.value.trim() && !/\s$/.test(el.value) ? " " : "") + shared);
    el.setSelectionRange(el.value.length, el.value.length);
    raiseKeyboard();
  };
  useLayoutEffect(() => {
    const asked = takeAsk(conversation, "share");
    if (asked) putShared.current(asked.text);
    return onAsk((ask) => {
      if (ask.conversation !== conversation || ask.kind !== "share") return;
      takeAsk(conversation, "share");
      putShared.current(ask.text);
    });
  }, [conversation]);

  /**
   * The reply let go: its quote goes with it, unless it has been written over. Let go from the
   * keyboard (Esc), it goes as an edit Undo can take back. Its close button leaves the field's
   * focus alone: on Android the field keeps the focus after Back has put the keyboard away, and
   * an edit there brought the keyboard straight back up.
   */
  const dropReply = (typing = false) => {
    const el = field.current;
    if (head && el && typing) {
      // The caret stays where it was in what was written.
      const [from, to] = [el.selectionStart, el.selectionEnd].map((at) => Math.max(0, at - head.length));
      replace(0, head.length, "");
      el.setSelectionRange(from!, to!);
    } else if (head) setText(text.slice(head.length));
    quoted.current = "";
    onReplyDone();
  };

  const watchCaret = () => {
    const el = field.current;
    if (!el || people.length === 0 || el.selectionStart !== el.selectionEnd) {
      setPick(null);
      return;
    }
    const q = mentionQuery(el.value, el.selectionStart);
    setPick((prev) => (q ? { ...q, end: el.selectionStart, index: prev && prev.query === q.query ? prev.index : 0 } : null));
  };

  const name = (who: string) => {
    if (!pick) return;
    replace(pick.start, pick.end, mentionOf(who));
    setPick(null);
  };

  const nudge = () => setShake(true);

  const cleared = () => {
    setText("");
    setPick(null);
    setCursive(false);
    quoted.current = "";
    onReplyDone();
    onSent();
  };

  /** The place's text ahead of what was written, and the place out of the field once it goes. */
  const takePlace = (): string => {
    if (!place) return "";
    // How the writer's own place went is how the next one here starts; a point put by hand says nothing of it.
    if (place.source !== "point") rememberRough(radio, conversation, place.rough);
    setPlace(radio, conversation, null);
    return empty ? line : `${line} `;
  };

  const send = async (how: { raw?: boolean; flood?: boolean } = {}) => {
    if (nothing || (place && !placeReady(place))) return;
    if (how.raw ? utf8Length(body) > cost.budget : over) {
      nudge();
      return;
    }
    const lead = mention + takePlace();
    const out = lead + (empty ? "" : how.raw ? body : pack(body));
    const original = lead + (empty ? "" : body);
    const replyTo = reply?.id;
    cleared();
    try {
      await session.sendText(conversation, out, { original, ...(how.flood ? { flood: true } : {}), ...(replyTo ? { replyTo } : {}) });
    } catch {
      // The message's own row says it failed, and offers to try again.
    }
  };

  const sendSplit = async () => {
    const parts = splitParts(pack(body), cost.budget);
    const first = mention + takePlace();
    const replyTo = reply?.id;
    cleared();
    for (const [i, part] of parts.entries()) {
      try {
        await session.sendText(conversation, (i === 0 ? first : "") + part, i === 0 && replyTo ? { replyTo } : {});
      } catch {
        return;
      }
    }
  };

  // Held, or right-clicked: the other ways to send this, or a place for an empty field.
  const press = usePress((at) => {
    if (nothing) return attachPlace(radio, conversation, many);
    const items: MenuItem[] = [];
    if (target.kind === "contact") items.push({ label: t("chats.composer.sendFlood"), icon: <WavesIcon size={17} />, air: true, hint: t("chats.composer.sendFloodHint"), onSelect: () => void send({ flood: true }) });
    const extra = cost.typed - cost.used;
    if (extra > 0) {
      const fits = utf8Length(body) <= cost.budget;
      items.push({ label: t("chats.composer.sendAsTyped"), icon: <TextIcon size={17} />, air: true, disabled: !fits, hint: fits ? t("chats.composer.asTypedHint", { bytes: extra }) : t("chats.composer.asTypedTooLong"), onSelect: () => void send({ raw: true }) });
    }
    if (items.length > 0) showMenu(items, { at });
  }, setHolding, { mouse: nothing });

  // The pin has to be held, by a finger or the mouse: tapped or clicked, it only says so. Right
  // after a message goes, the arrow under the pointer turns into the pin, and a second tap or
  // click used to put a place by mistake. Enter or Space on it still puts one at once.
  const pinPressed = (e: MouseEvent) => {
    if (e.detail > 0) toast(t("chats.place.holdHint"));
    else attachPlace(radio, conversation, many);
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (pick && matches.length > 0) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const step = e.key === "ArrowDown" ? 1 : matches.length - 1;
        setPick({ ...pick, index: (pick.index + step) % matches.length });
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        name(matches[Math.min(pick.index, matches.length - 1)]!);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setPick(null);
        return;
      }
    }
    if (e.key === "Escape" && reply) {
      e.preventDefault();
      dropReply(true);
      return;
    }
    const choice = formatKey(e);
    if (choice) {
      e.preventDefault();
      format(choice);
      return;
    }
    // A sent message cannot be edited on a mesh; the last one comes back to be corrected and sent again.
    if (e.key === "ArrowUp" && text === "") {
      const last = [...messages].reverse().find((m) => m.direction === "out");
      if (last) {
        e.preventDefault();
        replace(0, 0, last.original ?? last.text);
      }
      return;
    }
    // On a screen keyboard the return key starts a new line and only the button sends. With a real
    // keyboard Enter sends, and Shift, Ctrl, Alt or ⌘ with it starts a new line instead.
    if (e.key === "Enter" && !touch && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (e.ctrlKey || e.altKey || e.metaKey) replace(e.currentTarget.selectionStart, e.currentTarget.selectionEnd, "\n");
      else void send();
    }
  };

  if (target.kind === "prefix") {
    return <footer className="compose compose-note muted">{t("chats.composer.notContact")}</footer>;
  }

  const saved = cost.typed - cost.used;
  // An empty field's button puts a place in it; with a place or text in it, it sends.
  const button = nothing
    ? { cls: "pin", label: t("chats.place.attach"), icon: <LocationIcon size={19} />, disabled: false, act: pinPressed }
    : place && !placeReady(place)
      ? { cls: "idle", label: t("chats.place.locating"), icon: <SendIcon size={18} />, disabled: true, act: () => undefined }
      : over
      ? { cls: "over", label: t("chats.composer.tooLongToSend"), icon: <SendIcon size={18} />, disabled: true, act: () => undefined }
      : online
        ? { cls: "ready", label: t("common.send"), icon: <SendIcon size={18} />, disabled: false, act: () => void send() }
        : { cls: "queue", label: t("chats.composer.sendWhenBack"), icon: <ClockIcon size={18} />, disabled: false, act: () => void send() };
  const translitCost = over && hasCyrillic(text) ? utf8Length(pack(translit(text))) : null;
  // Offered only where it saves something: the sets already on may leave nothing to swap.
  const allCost = over && !cursive && hasCyrillic(text) ? utf8Length(packLookalikes(text, ALL_SETS)) : null;
  const cursiveCost = allCost !== null && allCost < cost.used ? allCost : null;
  const parts = over ? splitParts(pack(body), cost.budget).length : 0;

  return (
    <footer className={["compose", focused ? "focus" : "", text || reply || place ? "has" : "", online ? "" : "waiting", shake ? "shake" : ""].join(" ")} onAnimationEnd={() => setShake(false)}>
      {matches.length > 0 && pick ? (
        <div className="compose-pop" role="listbox" aria-label={t("chats.composer.mention")}>
          {matches.map((who, i) => (
            <button
              key={who}
              type="button"
              role="option"
              aria-selected={i === pick.index}
              className={i === pick.index ? "on" : ""}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => name(who)}
            >
              <Avatar name={who} size={24} />
              <span className="compose-pop-name">{who}</span>
              <span className="compose-cost">{t("chats.composer.bytes", { bytes: utf8Length(mentionOf(who)) })}</span>
            </button>
          ))}
        </div>
      ) : null}
      <div className="compose-box">
        {!nothing && !(pick && matches.length > 0) ? (
          <span className={["compose-tag", tone].join(" ")} id={`cost-${conversation}`}>
            {over ? (
              t("chats.composer.bytesOver", { bytes: cost.over })
            ) : tone === "warn" ? (
              t("chats.composer.usedOf", { used: shownUsed, budget: shownBudget })
            ) : (
              <>
                {t("chats.composer.bytes", { bytes: shownUsed })}
                {saved > 0 ? <span className="saved"> −{saved}</span> : null}
                {cost.airMs !== null ? ` · ${t("chats.composer.seconds", { value: (cost.airMs / 1000).toFixed(2) })}` : ""}
              </>
            )}
          </span>
        ) : null}
        {reply ? (
          <div className="compose-bar">
            <ReplyIcon size={15} className="compose-bar-icon" />
            {/* Who is answered; what they said is quoted in the field. */}
            <span className="compose-bar-text">
              <b>{reply.name}</b>
            </span>
            <span className="compose-cost">{t("chats.composer.plusBytes", { bytes: utf8Length(mention) })}</span>
            <button type="button" className="compose-bar-close" aria-label={t("chats.composer.cancelReply")} onMouseDown={(e) => e.preventDefault()} onClick={() => dropReply()}>
              <CloseIcon size={14} />
            </button>
          </div>
        ) : null}
        {place?.open ? (
          <PlacePanel radio={radio} conversation={conversation} place={place} />
        ) : place ? (
          <PlaceBar
            radio={radio}
            conversation={conversation}
            place={place}
            onOpen={() => {
              // Opened, the map takes the room the keyboard had.
              field.current?.blur();
              updatePlace(radio, conversation, { open: true });
            }}
          />
        ) : null}
        {over || cursive ? (
          <div className="compose-bar compose-over">
            {over ? (
              <span className="compose-over-text">{tx("chats.composer.tooLong", { over: <b>{t("chats.composer.bytes", { bytes: cost.over })}</b>, max: cost.budget })}</span>
            ) : (
              <span className="compose-sets-text">{t("chats.composer.cursiveOn")}</span>
            )}
            {over ? (
              <button type="button" className="chip" onMouseDown={(e) => e.preventDefault()} onClick={() => void sendSplit()}>
                {t("chats.composer.sendIn", { count: parts })}
              </button>
            ) : null}
            {cursive ? (
              <button type="button" className="chip on" aria-pressed="true" onMouseDown={(e) => e.preventDefault()} onClick={() => setCursive(false)}>
                <CheckIcon size={13} /> {t("chats.composer.cursive")}
              </button>
            ) : cursiveCost !== null ? (
              <button type="button" className="chip" aria-pressed="false" onMouseDown={(e) => e.preventDefault()} onClick={() => setCursive(true)}>
                {t("chats.composer.cursive")} <span className="compose-cost">{cursiveCost <= cost.budget ? t("chats.composer.fits") : t("chats.composer.minusBytes", { bytes: cost.used - cursiveCost })}</span>
              </button>
            ) : null}
            {translitCost !== null ? (
              <button type="button" className="chip" onMouseDown={(e) => e.preventDefault()} onClick={() => replace(0, text.length, translit(text))}>
                {t("chats.composer.translit")} <span className="compose-cost">{translitCost <= cost.budget ? t("chats.composer.fits") : t("chats.composer.minusBytes", { bytes: cost.used - translitCost })}</span>
              </button>
            ) : null}
          </div>
        ) : null}
        <div className="compose-row">
          <div className="compose-field">
            <div className="compose-mirror" ref={mirror} aria-hidden="true">
              {withFormat(segments(text, pack, cost.budget, cursive ? looksDifferent : undefined), formatRuns(text)).map((s, i) => (
                <span key={i} className={[s.mention ? "men" : "", s.over ? "ovr" : "", s.swapped ? "swp" : "", s.marker ? "fmk" : "", ...s.kinds.map((k) => FORMAT_CLASS[k] ?? "")].join(" ").trim() || undefined}>
                  {s.text}
                </span>
              ))}
              {"​"}
            </div>
            <textarea
              ref={field}
              rows={1}
              value={text}
              aria-label={t("chats.composer.field", { name: title })}
              aria-describedby={empty ? undefined : `cost-${conversation}`}
              enterKeyHint={touch ? "enter" : "send"}
              autoCapitalize="sentences"
              onChange={(e) => setText(e.target.value)}
              onSelect={(e) => {
                watchCaret();
                noteFormatSelection(e.currentTarget.selectionStart !== e.currentTarget.selectionEnd);
              }}
              onKeyDown={onKey}
              onContextMenu={formatMenu}
              onScroll={(e) => {
                if (mirror.current) mirror.current.scrollTop = e.currentTarget.scrollTop;
              }}
              onFocus={(e) => {
                setFocused(true);
                offerFormatMenu((choice) => formatNow.current(choice));
                noteFormatSelection(e.currentTarget.selectionStart !== e.currentTarget.selectionEnd);
                // Typing folds the place into a bar above the text: on a phone the keyboard takes the map's room.
                if (place?.open) updatePlace(radio, conversation, { open: false });
              }}
              onBlur={() => {
                setFocused(false);
                setPick(null);
                offerFormatMenu(null);
              }}
            />
          </div>
          <button
            type="button"
            className={["compose-send", button.cls, holding && nothing ? "holding" : ""].join(" ")}
            aria-label={button.label}
            disabled={button.disabled}
            onMouseDown={(e) => e.preventDefault()}
            onClick={button.act}
            {...press}
          >
            {nothing ? (
              <svg className="hold-ring" viewBox="0 0 46 46" aria-hidden="true">
                <circle cx="23" cy="23" r="21" />
              </svg>
            ) : null}
            {button.icon}
          </button>
        </div>
        <div className="compose-meter" aria-hidden="true">
          <i className={["fill", tone].join(" ")} style={{ width: share(cost.prefix + cost.used, ceiling) }} />
          {blockEdges(ceiling).map((edge) => (
            <span key={edge} className="tick" style={{ left: share(edge, ceiling) }} />
          ))}
        </div>
      </div>
    </footer>
  );
}
