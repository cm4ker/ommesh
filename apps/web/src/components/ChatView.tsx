import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AdvType, isConversationType, isDirect, parseConversation, type ContactRecord, type MessageRecord, type SessionState } from "@meshnet/meshcore";
import { useBackLayer } from "../lib/back.js";
import { GEO, MENTION } from "../lib/composer.js";
import { LINK, linkOf, openLink } from "../lib/webLinks.js";
import { messagesIn, shownIn, titleOf, type Shown } from "../lib/conversations.js";
import { nameOfHash, relaysOf } from "../lib/echoes.js";
import { getOpenAtUnread, takeUnread } from "../lib/firstUnread.js";
import { agoPhrase, dayLabel, emojiOnly, timeOfDay } from "../lib/format.js";
import { useJumboEmoji } from "../lib/jumboEmoji.js";
import { moveForKeyboard } from "../lib/keyboard.js";
import { onJump, takeJump, type Jump } from "../lib/jump.js";
import { findMessages, searchTerm } from "../lib/messageSearch.js";
import { openChannel, openMessage, openProfile } from "../lib/nav.js";
import { heardAt, hopsLabel, kindLabel } from "../lib/nodes.js";
import { openRoute } from "../lib/toolActions.js";
import { usePress } from "../lib/press.js";
import { routeWords } from "../lib/routes.js";
import { triesPhrase } from "../lib/sendTries.js";
import { sendersOf } from "../lib/senders.js";
import { session, useSession } from "../lib/session.js";
import { toast } from "../lib/toast.js";
import { Button, IconButton } from "../ui/Button.js";
import { SearchField } from "../ui/Field.js";
import { showMenu, type MenuItem } from "../ui/Menu.js";
import { Avatar, SenderName } from "./Avatar.js";
import { Composer, type Reply } from "./Composer.js";
import { NotOnRadio } from "./ContactsPages.js";
import {
  AlertIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  ClockIcon,
  CopyIcon,
  DoubleCheckIcon,
  InfoIcon,
  LinkOffIcon,
  LocationIcon,
  LockIcon,
  NodesIcon,
  RefreshIcon,
  ReplyIcon,
  SearchIcon,
  SendIcon,
  StopIcon,
  TrashIcon,
  WavesIcon,
} from "./Icons.js";
import { marked } from "./Marked.js";
import { ScreenHead, type Chrome } from "./ScreenHead.js";
import { t } from "../i18n/index.js";

/** Asks the open chat for its own search, from Ctrl+F on the desktop. */
export const FIND_IN_CHAT_EVENT = "meshnet:find-in-chat";

/**
 * How many of the latest messages a chat draws when it opens; older ones come a
 * page at a time as the reader scrolls up. A channel of six hundred messages,
 * drawn whole, took 0.65 s to open on a phone, and every change to the page's
 * style (the keyboard coming up) restyled all of them.
 */
const FIRST_DRAWN = 60;
const MORE_DRAWN = 100;
/** Messages still drawn above one the chat opens or jumps to: the first unread, a match. */
const ABOVE = 10;

export function ChatView({ conversation, chrome, infoOpen, onInfo }: { conversation: string; chrome: Chrome; infoOpen?: boolean | undefined; onInfo?: () => void }) {
  const state = useSession();
  const messages = useMemo(() => messagesIn(state, conversation), [state, conversation]);
  const shown = useMemo(() => shownIn(messages), [messages]);
  const title = titleOf(state, conversation);
  const target = parseConversation(conversation);
  const contact = target.kind === "contact" ? state.contacts[target.key] : undefined;
  // A room relays many voices, so its messages are named like a channel's.
  const many = target.kind === "channel" || contact?.type === AdvType.Room;
  // A room takes posts only from those signed in to it.
  const locked = contact?.type === AdvType.Room && !state.logins[contact.key]?.ok;
  const scroller = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const [reply, setReply] = useState<Reply | null>(null);
  // The message being answered, kept in sight while the keyboard comes up for the answer.
  const answering = useRef<string | null>(null);
  const answer = useCallback((message: MessageRecord) => {
    if (!message.sender) return;
    answering.current = message.id;
    setReply({ name: message.sender, text: message.text });
  }, []);
  // Who wrote it: the profile, when the radio knows one node by that name; else a choice.
  const who = useCallback(
    (message: MessageRecord) => {
      const name = message.sender ?? "?";
      const found = sendersOf(message, session.getState().contacts);
      if (found.length === 1) {
        openProfile(found[0]!.key);
        return;
      }
      if (found.length > 1) {
        showMenu(
          found.map((c) => ({ label: c.name, hint: nodeLine(c), icon: <Avatar name={c.name} type={c.type} size={28} />, onSelect: () => openProfile(c.key) })),
          { title: t("chats.chat.sameName", { count: found.length, name }) },
        );
        return;
      }
      showMenu([{ label: t("chats.message.reply"), icon: <ReplyIcon size={17} />, onSelect: () => answer(message) }], { title: t("chats.chat.noAdvert", { name }) });
    },
    [answer],
  );

  // What was unread when the chat opened: a line goes above the first of them until the chat is left.
  // Not on screen yet (a notice tapped on a locked phone), the chat is still unread in the session.
  const [unread] = useState(() => {
    const heard = messages.filter((m) => m.direction === "in");
    const count = Math.min(heard.length, takeUnread(conversation) || (state.unread[conversation] ?? 0));
    return count > 0 ? { first: heard[heard.length - count]!.id, count, ids: heard.slice(-count).map((m) => m.id) } : null;
  });

  // The first message drawn; null draws them all. The unread are drawn from the start, with a few above.
  const [from, setFrom] = useState<string | null>(() => {
    const unreadAt = unread ? messages.findIndex((m) => m.id === unread.first) : -1;
    const start = Math.min(messages.length - FIRST_DRAWN, unreadAt < 0 ? Infinity : unreadAt - ABOVE);
    return start > 0 ? messages[start]!.id : null;
  });
  const fromAt = from ? Math.max(0, messages.findIndex((m) => m.id === from)) : 0;

  // Messages heard that the reader has not yet had on screen, in order: the unread on opening, and
  // those that come while they read further up. Each drops off once it has been in sight.
  const unseen = useRef<string[]>(unread?.ids ?? []);
  const known = useRef<Set<string> | null>(null);
  known.current ??= new Set(messages.map((m) => m.id));
  const [below, setBelow] = useState(0);
  const [away, setAway] = useState(false);
  const measure = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    const edge = el.getBoundingClientRect().bottom + 2;
    let seen = 0;
    for (const id of unseen.current) {
      const row = el.querySelector(`[data-id="${CSS.escape(id)}"]`);
      if (row && row.getBoundingClientRect().bottom > edge) break;
      seen++;
    }
    if (seen) unseen.current = unseen.current.slice(seen);
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    setBelow(unseen.current.length);
    setAway(distance > 160 || (unseen.current.length > 0 && distance > 40));
  }, []);

  // Pinned to the bottom, as a chat is, unless the reader has scrolled up to read. Opened with
  // messages unread, and the setting on, it starts at the first of them instead.
  const stuck = useRef(true);
  const opened = useRef(false);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const line = opened.current || !getOpenAtUnread() ? null : el.querySelector(".unread-line");
    opened.current = true;
    if (line) {
      el.scrollTop += line.getBoundingClientRect().top - el.getBoundingClientRect().top - 8;
      stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    } else if (stuck.current) {
      el.scrollTop = el.scrollHeight;
    }
    const added = messages.filter((m) => !known.current!.has(m.id));
    for (const m of added) {
      known.current!.add(m.id);
      if (m.direction === "in") unseen.current.push(m.id);
    }
    measure();
  }, [messages.length, conversation]);
  // The keyboard coming up shrinks the list from below; the last message stays in sight. Read
  // further up, the list keeps its lower edge instead, so what sat just above the field stays
  // there. Either way, never so far that the message being answered goes off the top.
  useEffect(() => {
    const el = scroller.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let height = el.clientHeight;
    const keep = new ResizeObserver(() => {
      const shrunk = height - el.clientHeight;
      height = el.clientHeight;
      if (stuck.current) el.scrollTop = el.scrollHeight;
      else el.scrollTop += shrunk;
      keepAnswered();
      measure();
    });
    // The border box: the room the list gains at its top as the chat rises is not the list shrinking.
    keep.observe(el, { box: "border-box" });
    return () => keep.disconnect();
  }, [measure]);
  // The message being answered, scrolled down if it would end up under the head. As the chat
  // rises for the keyboard, the list's inside is moved back up by as much and glides down with
  // the rise, so the message rises by less rather than the list jumping down first.
  const keepAnswered = (glide = false) => {
    const el = scroller.current;
    const row = el && answering.current ? el.querySelector(`[data-id="${CSS.escape(answering.current)}"]`) : null;
    const hidden = el && row ? el.getBoundingClientRect().top + rise.current - row.getBoundingClientRect().top : 0;
    if (!el || hidden <= 0) return;
    const was = el.scrollTop;
    el.scrollTop -= hidden;
    const body = inner.current;
    if (!glide || !body) return;
    body.style.transition = "none";
    body.style.translate = `0 ${el.scrollTop - was}px`;
    getComputedStyle(body).translate;
    body.style.transition = "";
    body.style.translate = "";
  };

  // Where the page follows the keyboard (iOS), the chat rises for it instead of shrinking
  // (lib/keyboard.ts, styles.css): the list gains the rise as room at its top, scrolled so that
  // nothing on screen moves, and a transform then carries all under the head up with the
  // keyboard. The top of the list, under the head, is out of sight by as much as it rose.
  const screen = useRef<HTMLDivElement>(null);
  const rise = useRef(0);
  useEffect(() => {
    const box = screen.current;
    if (!box) return;
    // Each box directly in the chat takes the height itself (styles.css), one that comes in while
    // the chat is risen (the search's bar, say) too.
    let keyboard = "0px";
    const give = (node: Node) => node instanceof HTMLElement && node.style.setProperty("--chat-keyboard", keyboard);
    const added = new MutationObserver((changes) => changes.forEach((change) => change.addedNodes.forEach(give)));
    added.observe(box, { childList: true });
    const stop = moveForKeyboard(box, (height) => {
      const el = scroller.current;
      if (!el) return;
      // Read before the room changes: room taken away clamps the scroll at once.
      const top = el.scrollTop;
      const before = parseFloat(getComputedStyle(el).paddingTop);
      keyboard = `${height}px`;
      for (const child of box.children) give(child);
      const grown = parseFloat(getComputedStyle(el).paddingTop) - before;
      if (!grown) return;
      rise.current += grown;
      el.scrollTop = top + grown;
      keepAnswered(true);
      measure();
    });
    return () => {
      stop();
      added.disconnect();
    };
  }, [measure]);
  const toLatest = () => {
    const el = scroller.current;
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    el?.scrollTo({ top: el.scrollHeight, behavior: still ? "auto" : "smooth" });
  };

  // One message in the middle of the list.
  const centre = useCallback(
    (id: string) => {
      const el = scroller.current;
      const row = el?.querySelector(`[data-id="${CSS.escape(id)}"]`);
      if (!el || !row) return;
      const box = el.getBoundingClientRect();
      const at = row.getBoundingClientRect();
      // Risen for the keyboard, the list's top is under the head: the middle is of what is in sight.
      el.scrollTop += at.top - box.top - rise.current - (box.height - rise.current - at.height) / 2;
      stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      measure();
    },
    [measure],
  );

  // Opened from a result of the search over all chats (#42): the message flashes, and the words it
  // was found by stay marked in it until the chat is left.
  const [found, setFound] = useState<Jump | null>(() => takeJump(conversation));
  const [flashing, setFlashing] = useState<string | null>(() => found?.id ?? null);
  useLayoutEffect(() => {
    if (found) centre(found.id);
  }, [found, centre]);
  useEffect(() => {
    if (!flashing) return;
    const done = setTimeout(() => setFlashing(null), 1800);
    return () => clearTimeout(done);
  }, [flashing]);

  // The chat's own search: every match marked, one at a time in sight, the newest first.
  const [finding, setFinding] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  const findField = useRef<HTMLInputElement>(null);
  const matches = useMemo(() => (finding ? findMessages(messages, findQuery) : []), [finding, messages, findQuery]);
  const matched = useMemo(() => new Set(matches.map((m) => m.id)), [matches]);
  // Held by its id, so a match arriving meanwhile does not move the one looked at.
  const index = Math.max(0, matches.findIndex((m) => m.id === picked));
  const current = matches[index]?.id ?? null;

  // A message jumped to further up than is drawn (a search result, a match) is drawn in, with a few
  // above, in the same pass that puts it in sight; the chat then keeps drawing from there.
  const jumpAt = Math.min(...[found?.id, current].map((id) => (id ? messages.findIndex((m) => m.id === id) : -1)).filter((at) => at >= 0));
  const drawnAt = Math.min(fromAt, Math.max(0, jumpAt - ABOVE));
  const drawn = drawnAt > 0 ? messages.slice(drawnAt) : messages;
  useLayoutEffect(() => {
    if (drawnAt < fromAt) setFrom(drawnAt > 0 ? messages[drawnAt]!.id : null);
  }, [drawnAt, fromAt, messages]);
  // Older ones drawn in above keep what is on screen where it was: the distance to the bottom stays.
  const keepBottom = useRef<number | null>(null);
  const drawMore = () => {
    const el = scroller.current;
    if (!el || drawnAt <= 0 || keepBottom.current !== null) return;
    keepBottom.current = el.scrollHeight - el.scrollTop;
    setFrom(drawnAt > MORE_DRAWN ? messages[drawnAt - MORE_DRAWN]!.id : null);
  };
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || keepBottom.current === null) return;
    el.scrollTop = el.scrollHeight - keepBottom.current;
    keepBottom.current = null;
  }, [from]);

  const move = (by: number) => {
    const next = matches[index + by];
    if (next) setPicked(next.id);
  };
  const closeFind = useCallback(() => {
    setFinding(false);
    setFindQuery("");
    setPicked(null);
  }, []);
  const openFind = useCallback(() => {
    setFound(null);
    setFinding(true);
    findField.current?.focus();
    findField.current?.select();
  }, []);
  useBackLayer(finding, closeFind);
  useLayoutEffect(() => {
    if (current) centre(current);
  }, [current, centre]);
  useEffect(() => {
    window.addEventListener(FIND_IN_CHAT_EVENT, openFind);
    return () => window.removeEventListener(FIND_IN_CHAT_EVENT, openFind);
  }, [openFind]);
  // A result picked while this chat is already open, as on the desktop.
  useEffect(
    () =>
      onJump((jump) => {
        if (jump.conversation !== conversation) return;
        takeJump(conversation);
        closeFind();
        setFound(jump);
        setFlashing(jump.id);
      }),
    [conversation, closeFind],
  );

  useReveal(scroller, inner, (id) => {
    const message = messages.find((m) => m.id === id);
    if (message) answer(message);
  });

  // Who this is: the profile of the person or room, the page of the channel.
  const details = onInfo ?? (target.kind === "contact" ? () => openProfile(target.key) : target.kind === "channel" ? () => openChannel(target.index) : undefined);
  const route = contact && isConversationType(contact.type) ? routeWords(contact) : null;
  const me = state.self?.name ?? null;

  return (
    <div ref={screen} className={["screen chat", finding ? "finding" : ""].join(" ")}>
      {finding ? (
        <header className="screen-head chat-find-head">
          <SearchField
            ref={findField}
            value={findQuery}
            autoFocus
            onValue={(next) => {
              setFindQuery(next);
              setPicked(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                move(e.shiftKey ? -1 : 1);
              } else if (e.key === "Escape") {
                e.preventDefault();
                closeFind();
              }
            }}
            placeholder={t("chats.find.placeholder")}
            aria-label={t("chats.find.placeholder")}
            enterKeyHint="search"
            data-chat-find
          />
          <Button variant="ghost" size="sm" onClick={closeFind}>
            {t("common.cancel")}
          </Button>
        </header>
      ) : (
        <ScreenHead
          chrome={chrome}
          actions={
            <>
              <IconButton label={onInfo ? t("chats.find.buttonKey") : t("chats.find.button")} onClick={openFind}>
                <SearchIcon size={18} />
              </IconButton>
              {onInfo ? (
                <IconButton label={t("chats.chat.details")} className={infoOpen ? "on" : ""} aria-pressed={infoOpen} onClick={onInfo}>
                  <InfoIcon size={18} />
                </IconButton>
              ) : null}
            </>
          }
        >
          <button type="button" className="chat-who" onClick={details} disabled={!details} aria-label={t("chats.chat.about", { name: title })}>
            <Avatar name={title} type={contact?.type} channel={target.kind === "channel"} size={32} />
          </button>
          <span className="screen-name-stack">
            <button type="button" className="chat-who screen-name" onClick={details} disabled={!details}>
              {title}
            </button>
            {route && contact ? (
              <button type="button" className={["chat-route", route.tone].join(" ")} onClick={() => openRoute(contact.key)}>
                {route.tone === "pinned" ? <WavesIcon size={12} /> : null}
                <span>{route.text}</span>
                <ChevronRightIcon size={11} />
              </button>
            ) : target.kind === "contact" && (!contact || contact.unsaved) ? (
              <span className="chat-route">{t("chats.chat.notOnRadio")}</span>
            ) : null}
          </span>
        </ScreenHead>
      )}

      <div
        className="chat-scroll"
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          measure();
          // Within a screen of the top, the page above is drawn in.
          if (el.scrollTop < el.clientHeight) drawMore();
        }}
      >
        <div className="chat-inner" ref={inner}>
          {messages.length === 0 ? <div className="empty muted">{target.kind === "channel" ? t("chats.chat.emptyChannel") : t("chats.chat.empty")}</div> : null}
          {drawn.map((m, i) => {
            const prev = drawn[i - 1];
            const next = drawn[i + 1];
            const at = shown.get(m.id)!;
            const newDay = !prev || at.newDay;
            const opens = m.id === unread?.first;
            const first = !prev || !sameRun(prev, m, shown) || opens;
            const last = !next || !sameRun(m, next, shown) || next.id === unread?.first;
            const voice = many && m.direction === "in";
            return (
              <div key={m.id} data-id={m.id}>
                {newDay ? <div className="day">{dayLabel(at.at)}</div> : null}
                {opens && unread ? <div className="unread-line">{t("chats.chat.newMessages", { count: unread.count })}</div> : null}
                <Message
                  message={m}
                  at={at.at}
                  lead={many && first && !newDay && !opens}
                  showSender={voice && first}
                  avatar={voice ? (last && m.sender ? "show" : "gap") : null}
                  me={me}
                  onReply={voice && m.sender ? answer : undefined}
                  onWho={voice ? who : undefined}
                  contacts={m.direction === "out" ? state.contacts : undefined}
                  mark={finding ? (matched.has(m.id) ? findQuery : undefined) : found?.id === m.id ? found.query : undefined}
                  current={m.id === current}
                  flash={m.id === flashing}
                />
              </div>
            );
          })}
        </div>
      </div>

      {/* Back to the latest, once scrolled away from it; the count is of the new ones still below. */}
      <div className="chat-jump-slot">
        <button
          type="button"
          className={["chat-jump", away ? "" : "off"].join(" ")}
          aria-label={below ? t("chats.chat.latestBelow", { count: below }) : t("chats.chat.latest")}
          onClick={toLatest}
        >
          {below ? <span className="badge">{below}</span> : null}
          <ChevronDownIcon size={20} />
        </button>
      </div>

      {/* Searching, the field goes and the way between the matches takes its place. */}
      {finding ? (
        <footer className="chat-find-bar">
          <span className="chat-find-count muted" aria-live="polite">
            {searchTerm(findQuery) === null ? "" : matches.length ? t("chats.find.count", { n: index + 1, count: matches.length }) : t("chats.find.none")}
          </span>
          {/* Kept from taking the focus, so the keyboard stays up for another word. */}
          <IconButton label={t("chats.find.older")} disabled={index >= matches.length - 1} onPointerDown={(e) => e.preventDefault()} onClick={() => move(1)}>
            <ChevronUpIcon size={20} />
          </IconButton>
          <IconButton label={t("chats.find.newer")} disabled={index <= 0} onPointerDown={(e) => e.preventDefault()} onClick={() => move(-1)}>
            <ChevronDownIcon size={20} />
          </IconButton>
        </footer>
      ) : null}

      {target.kind === "contact" && (contact?.unsaved || (!contact && state.removed[target.key])) ? (
        <footer className="compose">
          <NotOnRadio contactKey={target.key} compact />
        </footer>
      ) : locked && contact ? (
        <footer className="compose">
          <button type="button" className="compose-login" onClick={() => openProfile(contact.key)}>
            <LockIcon size={16} /> {t("chats.chat.logInToPost", { name: title })}
          </button>
        </footer>
      ) : (
        <Composer
          conversation={conversation}
          title={title}
          reply={reply}
          onReplyDone={() => {
            answering.current = null;
            setReply(null);
          }}
          onSent={() => {
            stuck.current = true;
          }}
        />
      )}
    </div>
  );
}

/**
 * A message's text, with mentions, positions and web addresses picked out; a mention of this radio
 * stands out more, and an address opens in the browser. Searched, the words found are marked in
 * the text between them and in the addresses.
 */
function richText(text: string, me: string | null, mark: string | undefined): ReactNode {
  const pattern = new RegExp(`${MENTION.source}|${GEO.source}|(${LINK.source})`, "g");
  const out: ReactNode[] = [];
  let at = 0;
  for (const m of text.matchAll(pattern)) {
    const start = m.index ?? 0;
    if (start > at) out.push(marked(text.slice(at, start), mark));
    let length = m[0].length;
    if (m[1] !== undefined) {
      out.push(
        <span key={start} className={m[1] === me ? "mention me" : "mention"}>
          @{m[1]}
        </span>,
      );
    } else if (m[4] !== undefined) {
      const link = linkOf(m[4]);
      if (link) {
        length = link.text.length;
        out.push(
          <a
            key={start}
            className="msg-link"
            href={link.href}
            target="_blank"
            rel="noopener noreferrer"
            draggable={false}
            // The bubble opens the message's details on a tap and on Enter; this opens the address alone.
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              openLink(link.href);
            }}
            onKeyDown={(e) => e.stopPropagation()}
          >
            {marked(link.text, mark)}
          </a>,
        );
      } else {
        out.push(marked(m[0], mark));
      }
    } else {
      out.push(
        <span key={start} className="geo" title={m[0]}>
          <LocationIcon size={12} />
          {m[2]}, {m[3]}
        </span>,
      );
    }
    at = start + length;
  }
  if (at === 0) return marked(text, mark);
  if (at < text.length) out.push(marked(text.slice(at), mark));
  return out.map((part, i) => <Fragment key={i}>{part}</Fragment>);
}

/** Signal and hops of a message heard; of ours, whether it went by flood. How many copies came back rides on the tick. */
function techOf(message: MessageRecord): string {
  if (message.direction === "in") {
    const bits = [];
    if (message.snr !== null) bits.push(t("chats.chat.snr", { value: `${message.snr > 0 ? "+" : ""}${message.snr.toFixed(1)}` }));
    if (message.hops !== null) bits.push(message.hops === 0 ? t("chats.chat.direct") : t("chats.chat.hops", { count: message.hops }));
    return bits.join(" · ");
  }
  return message.flood ? t("chats.chat.flood") : "";
}

/** Whether `b` goes on from `a` without a break: the same side and sender, the same day, within five minutes. */
function sameRun(a: MessageRecord, b: MessageRecord, shown: Map<string, Shown>): boolean {
  const from = shown.get(a.id)!;
  const to = shown.get(b.id)!;
  return a.direction === b.direction && a.sender === b.sender && !to.newDay && to.at - from.at < 300;
}

/** A node among several of one name, told apart by what it is and when it was last heard. */
function nodeLine(contact: ContactRecord): string {
  const at = heardAt(contact);
  return [kindLabel(contact.type), at ? t("chats.chat.heardAgo", { time: agoPhrase(at) }) : t("chats.chat.neverHeard"), hopsLabel(contact)].join(" · ");
}

interface MessageProps {
  message: MessageRecord;
  /** The time on it, unix seconds, as `shownIn` gives it. */
  at: number;
  /** The first of a run in a channel or a room: a little room above it sets the voices apart. */
  lead: boolean;
  showSender: boolean;
  /** In a channel or a room, a message heard: the sender's avatar by the last of a run, an empty column by the rest. */
  avatar: "show" | "gap" | null;
  me: string | null;
  onReply: ((message: MessageRecord) => void) | undefined;
  onWho: ((message: MessageRecord) => void) | undefined;
  /** For a message of ours only: the relays that echoed it are named from them. */
  contacts: SessionState["contacts"] | undefined;
  /** What a search found it by, marked in its text. */
  mark: string | undefined;
  /** The match the chat's search has in sight. */
  current: boolean;
  /** Just opened from a search result. */
  flash: boolean;
}

/**
 * One bubble. Memoised: a message arriving, or an echo of one, changes one record, and the
 * other bubbles of a long conversation have nothing new to draw.
 */
const Message = memo(function Message({ message, at, lead, showSender, avatar, me, onReply: replyTo, onWho, contacts, mark, current, flash }: MessageProps) {
  const out = message.direction === "out";
  const [busy, setBusy] = useState(false);
  const large = useJumboEmoji();
  const onReply = replyTo ? () => replyTo(message) : undefined;
  const relays = out && contacts ? relaysOf(message.echoes, contacts) : [];
  const tech = techOf(message);
  const plan = out ? message.retryPlan : null;
  const looping = plan !== null && plan.made < plan.total;
  const direct = isDirect(message);
  // A direct message going again on its own: counted beside the time, the bubble left as it is.
  const trying = direct && plan !== null && (looping || message.status === "sending" || message.status === "sent" || message.status === "queued");
  // Its tries are spent or were stopped, and none was acknowledged.
  const gaveUp = direct && plan !== null && !trying && message.status === "unconfirmed";
  // Nobody has been heard sending it on, a loop on a channel is still trying, or no try
  // was acknowledged: the whole bubble says so.
  const bad = out && (message.status === "unheard" || (looping && !direct) || gaveUp);
  const retryable = out && (message.status === "unheard" || message.status === "unconfirmed" || message.status === "failed");
  const flood = retryable && session.retryFloods(message);
  // One to three emoji and nothing else: large, with no bubble (#41), unless turned off in Appearance.
  // A red one keeps its bubble for the strip.
  const jumbo = bad || !large ? 0 : emojiOnly(message.text);

  const retry = async () => {
    setBusy(true);
    try {
      await session.sendAgain(message.id);
    } catch {
      // The row shows the status.
    } finally {
      setBusy(false);
    }
  };

  const keepTrying = async () => {
    try {
      await session.keepTrying(message.id);
    } catch {
      // The row shows the status.
    }
  };

  const press = usePress((at) => {
    const items: (MenuItem | null)[] = [
      onReply ? { label: t("chats.message.reply"), icon: <ReplyIcon size={17} />, onSelect: onReply } : null,
      { label: t("chats.message.copyText"), icon: <CopyIcon size={17} />, onSelect: () => void navigator.clipboard?.writeText(message.text).then(() => toast(t("common.copied"))) },
      retryable && !looping ? { label: flood ? t("chats.message.sendAgainFlood") : t("chats.message.sendAgain"), icon: <AlertIcon size={17} />, air: true, onSelect: () => void retry() } : null,
      // A direct message has its tries from the settings; this is for one sent once.
      (message.status === "unheard" || message.status === "unconfirmed") && !looping && !(direct && plan)
        ? { label: t("chats.message.keepTrying"), hint: direct ? triesPhrase(session.retryLadder.length) : loopHint(), icon: <RefreshIcon size={17} />, air: true, onSelect: () => void keepTrying() }
        : null,
      looping ? { label: t("chats.message.stopTrying"), icon: <StopIcon size={17} />, onSelect: () => session.stopTrying(message.id) } : null,
      message.status === "queued" ? { label: t("chats.message.dontSend"), icon: <TrashIcon size={17} />, danger: true, onSelect: () => session.discardQueued(message.id) } : null,
      retryable || looping ? { label: t("common.delete"), icon: <TrashIcon size={17} />, danger: true, onSelect: () => session.discardFailed(message.id) } : null,
      { label: t("chats.message.travelled"), icon: <NodesIcon size={17} />, onSelect: () => openMessage(message.conversation, message.id) },
    ];
    showMenu(
      items.filter((x): x is MenuItem => x !== null),
      { at },
    );
  });

  const relayTitle = relays.length && contacts ? t("chats.chat.relayedBy", { count: relays.length, names: relays.map((r) => nameOfHash(r.hash, contacts) ?? r.hash).join(", ") }) : undefined;

  return (
    <div className={["msg", out ? "out" : "in", lead ? "lead" : ""].join(" ")} data-reply={onReply ? message.id : undefined}>
      <span className="msg-reply-cue" aria-hidden="true">
        <ReplyIcon size={16} />
      </span>
      {avatar ? (
        <span className="msg-avatar">
          {avatar === "show" && message.sender ? (
            <button type="button" className="chat-who" aria-label={t("chats.chat.whoIs", { name: message.sender })} onClick={() => onWho?.(message)}>
              <Avatar name={message.sender} size={28} />
            </button>
          ) : null}
        </span>
      ) : null}
      <div className="msg-col">
        {/* A div, not a button: its text stays selectable for copying with a mouse. */}
        <div
          role="button"
          tabIndex={0}
          className={[jumbo ? `jumbo jumbo-${jumbo}` : "bubble", bad ? "bad" : "", current ? "msg-current" : "", flash ? "msg-flash" : ""].join(" ")}
          onClick={() => {
            // A click that ends a text selection is not a tap.
            if (String(window.getSelection?.() ?? "").length > 0) return;
            openMessage(message.conversation, message.id);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              openMessage(message.conversation, message.id);
            }
          }}
          title={relayTitle}
          {...press}
        >
          {showSender && message.sender ? <SenderName name={message.sender} /> : null}
          <span className="msg-text">{richText(message.text, me, mark)}</span>
          <span className="msg-meta">
            {tech ? <span className="msg-tech">{tech} ·</span> : null}
            <span>{timeOfDay(at)}</span>
            {/* A red bubble carries its state in the strip below; a tick beside it would say the opposite. */}
            {out && !bad ? <Status message={message} trying={trying} /> : null}
          </span>
          {bad ? <Unrelayed message={message} busy={busy} onRetry={() => void retry()} onKeepTrying={() => void keepTrying()} /> : null}
        </div>
        {retryable && !bad && !trying ? (
          <button type="button" className={["msg-retry", message.status === "failed" ? "danger" : "warn"].join(" ")} disabled={busy} onClick={() => void retry()} title={message.error ?? undefined}>
            <AlertIcon size={12} /> {message.status === "failed" ? t("chats.message.failedRetry") : flood ? t("chats.message.retryFlood") : t("chats.message.retry")}
          </button>
        ) : null}
      </div>
      {tech ? (
        <span className="msg-reveal" aria-hidden="true">
          {tech.split(" · ").map((t) => (
            <span key={t}>{t}</span>
          ))}
        </span>
      ) : null}
    </div>
  );
});

/** What "Keep trying" commits to, said before it is chosen. */
function loopHint(): string {
  const ladder = session.retryLadder;
  const minutes = Math.round(ladder.reduce((sum, gap) => sum + gap, 0) / 60_000);
  return t("chats.tries.over", { count: ladder.length, minutes });
}

/** The clock, ticking once a second while `active`; a loop's countdown needs nothing finer. */
function useClock(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

function countdown(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/**
 * The strip inside a red bubble: what is wrong, and the one thing to do about
 * it. A tap target of its own, apart from the text, which opens how the
 * message travelled. While a loop runs it counts down and a tap stops it.
 */
function Unrelayed({ message, busy, onRetry, onKeepTrying }: { message: MessageRecord; busy: boolean; onRetry: () => void; onKeepTrying: () => void }) {
  const plan = message.retryPlan;
  const looping = plan !== null && plan.made < plan.total;
  const now = useClock(looping && plan.nextAt !== null);
  // A press here neither opens the message nor starts the long-press menu,
  // so letting go after a long press can never send by accident.
  const own = { onPointerDown: (e: { stopPropagation(): void }) => e.stopPropagation(), onKeyDown: (e: { stopPropagation(): void }) => e.stopPropagation() };

  // A channel message nobody relayed: the red says what is wrong, so the strip
  // is only the two ways on, one more send or the loop, where people look (#57).
  if (!looping && !isDirect(message)) {
    return (
      <div className="msg-strip pair" {...own}>
        <button
          type="button"
          className="msg-strip-half"
          disabled={busy}
          title={t("chats.strip.noRepeater")}
          onClick={(e) => {
            e.stopPropagation();
            onRetry();
          }}
        >
          <SendIcon size={12} />
          <span>{t("chats.strip.again")}</span>
        </button>
        <button
          type="button"
          className="msg-strip-half"
          disabled={busy}
          title={loopHint()}
          onClick={(e) => {
            e.stopPropagation();
            onKeepTrying();
          }}
        >
          <RefreshIcon size={12} />
          <span>{t("chats.message.keepTrying")}</span>
        </button>
      </div>
    );
  }

  let icon: ReactNode;
  let label: string;
  if (looping && plan.nextAt === null) {
    icon = <LinkOffIcon size={12} />;
    label = t("chats.strip.waiting", { made: plan.made, total: plan.total });
  } else if (looping) {
    icon = <RefreshIcon size={12} />;
    label =
      message.status === "sending"
        ? t("chats.strip.sending", { made: plan.made, total: plan.total })
        : t("chats.strip.next", { made: plan.made, total: plan.total, time: countdown(plan.nextAt! - now) });
  } else {
    icon = <AlertIcon size={12} />;
    label = t("chats.strip.noAnswer", { count: plan?.made ?? 1 });
  }

  return (
    <button
      type="button"
      className="msg-strip"
      disabled={busy && !looping}
      title={looping ? t("chats.message.stopTrying") : t("chats.strip.noAck")}
      {...own}
      onClick={(e) => {
        e.stopPropagation();
        if (looping) session.stopTrying(message.id);
        else onRetry();
      }}
    >
      {icon}
      <span>{label}</span>
      {looping ? <StopIcon size={12} fill="currentColor" className="msg-strip-stop" /> : null}
    </button>
  );
}

function Status({ message, trying }: { message: MessageRecord; trying: boolean }) {
  const plan = message.retryPlan;
  if (trying && plan) {
    const waiting = plan.nextAt === null && plan.made < plan.total;
    return (
      <span
        className="tries"
        title={waiting ? t("chats.status.waitingTries", { made: plan.made, total: plan.total }) : t("chats.status.tryingAgain", { made: plan.made, total: plan.total })}
      >
        {plan.made}/{plan.total}
        {waiting ? <LinkOffIcon size={11} /> : <RefreshIcon size={11} className="spin" />}
      </span>
    );
  }
  switch (message.status) {
    case "queued":
      return (
        <span className="queued" title={t("chats.status.queuedTitle")}>
          <ClockIcon size={12} /> {t("chats.status.queued")}
        </span>
      );
    case "sending":
      return (
        <span title={t("chats.status.sending")}>
          <ClockIcon size={12} />
        </span>
      );
    case "sent":
    case "unconfirmed":
      // A channel message has no acknowledgement: each copy heard sent on by a repeater stands for one.
      if (message.echoes.length > 0) {
        const n = message.echoes.length;
        return (
          <span className="ok heard" title={t("chats.status.heardSentOn", { count: n })}>
            <DoubleCheckIcon size={14} />
            {n}
          </span>
        );
      }
      return (
        <span title={message.ackTag ? t("chats.status.sentWaiting") : t("chats.status.sent")}>
          <CheckIcon size={13} />
        </span>
      );
    case "delivered":
      return (
        <span className="ok" title={message.roundTripMs ? t("chats.status.ackIn", { seconds: (message.roundTripMs / 1000).toFixed(1) }) : t("chats.status.ack")}>
          <DoubleCheckIcon size={14} />
        </span>
      );
    default:
      return null;
  }
}

/** How far a message is pulled right before letting go answers it. */
const REPLY_PULL = 56;
/** The strip at the left edge where a pull goes back instead (the phone's edge swipe, Workspace.tsx). */
const EDGE = 24;

/**
 * Pulling the conversation left, on a touch screen, shows every message's
 * signal and hops at once; letting go hides them again. Pulling one message
 * right, in a channel or a room, answers it.
 */
function useReveal(scroller: React.RefObject<HTMLDivElement | null>, inner: React.RefObject<HTMLDivElement | null>, onReply: (id: string) => void) {
  const replyRef = useRef(onReply);
  replyRef.current = onReply;
  useEffect(() => {
    const el = scroller.current;
    const body = inner.current;
    if (!el || !body) return;
    let start: { x: number; y: number } | null = null;
    let mode: "reveal" | "reply" | null = null;
    let row: HTMLElement | null = null;
    let pulled = 0;
    const down = (e: TouchEvent) => {
      const t = e.touches[0];
      // From the edge, the pull is Back's; the bubble under it stays put.
      start = t && e.touches.length === 1 && t.clientX >= EDGE ? { x: t.clientX, y: t.clientY } : null;
      row = e.target instanceof Element ? e.target.closest<HTMLElement>("[data-reply]") : null;
      mode = null;
      pulled = 0;
    };
    const move = (e: TouchEvent) => {
      const t = e.touches[0];
      if (!start || !t) return;
      const dx = t.clientX - start.x;
      const dy = t.clientY - start.y;
      if (!mode) {
        if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
        if (Math.abs(dy) > Math.abs(dx) || (dx > 0 && !row)) {
          start = null;
          return;
        }
        mode = dx > 0 ? "reply" : "reveal";
        (mode === "reply" ? row! : body).style.transition = "none";
      }
      e.preventDefault();
      if (mode === "reveal") {
        body.style.transform = `translateX(${Math.max(-76, Math.min(0, dx))}px)`;
        return;
      }
      const reach = Math.max(0, Math.min(REPLY_PULL + 16, dx));
      if (reach >= REPLY_PULL && pulled < REPLY_PULL) navigator.vibrate?.(8);
      pulled = reach;
      row!.style.transform = `translateX(${reach}px)`;
      row!.style.setProperty("--pull", String(Math.min(1, reach / REPLY_PULL)));
    };
    const up = () => {
      if (mode === "reveal") {
        body.style.transition = "";
        body.style.transform = "";
      } else if (mode === "reply" && row) {
        row.style.transition = "";
        row.style.transform = "";
        row.style.removeProperty("--pull");
        if (pulled >= REPLY_PULL && row.dataset.reply) replyRef.current(row.dataset.reply);
      }
      start = null;
      mode = null;
      row = null;
    };
    el.addEventListener("touchstart", down, { passive: true });
    el.addEventListener("touchmove", move, { passive: false });
    el.addEventListener("touchend", up);
    el.addEventListener("touchcancel", up);
    return () => {
      el.removeEventListener("touchstart", down);
      el.removeEventListener("touchmove", move);
      el.removeEventListener("touchend", up);
      el.removeEventListener("touchcancel", up);
    };
  }, [scroller, inner]);
}
