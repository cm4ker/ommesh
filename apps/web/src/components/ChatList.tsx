import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { isFavourite, parseConversation, TxtType, type MessageRecord } from "@meshnet/meshcore";
import { channelAccess } from "../lib/channels.js";
import { CHAT_ORDERS, changed, chatGroups, chatsInOrder, getChatOrder, setChatOrder, useChatOrder } from "../lib/chatOrder.js";
import { pinnedAt, radioPins, setPinned, usePinStore } from "../lib/chatPins.js";
import { ago } from "../lib/format.js";
import { summarize, type ConversationSummary } from "../lib/conversations.js";
import { useDraft } from "../lib/drafts.js";
import { jumpTo } from "../lib/jump.js";
import { findMessages, fold, snippet } from "../lib/messageSearch.js";
import { openConversation, setStack } from "../lib/nav.js";
import { useNoticePrefs } from "../lib/noticePrefs.js";
import { usePress, type MenuAt } from "../lib/press.js";
import { session, useSession } from "../lib/session.js";
import { toast } from "../lib/toast.js";
import { IconButton } from "../ui/Button.js";
import { Confirm } from "../ui/Dialog.js";
import { SearchField } from "../ui/Field.js";
import { showMenu, type MenuItem } from "../ui/Menu.js";
import { Avatar } from "./Avatar.js";
import { BellOffIcon, CheckIcon, ChevronDownIcon, HashIcon, PersonIcon, PinIcon, PinOffIcon, PlusIcon, SortIcon, StarFilledIcon, TrashIcon } from "./Icons.js";
import { marked } from "./Marked.js";
import { NewBuildStrip } from "./NewBuild.js";
import { NewChat } from "./NewChat.js";
import { RadioTag } from "./RadioTag.js";
import { t } from "../i18n/index.js";

/** Asks the chat list to open its New chat sheet, from a shortcut or the palette. */
export const NEW_CHAT_EVENT = "meshnet:new-chat";

/** Results drawn at a time; a common word can be in thousands of messages. */
const PAGE = 100;

// The query outlives the list: Back from a result, or a trip to another tab, finds it as it was left.
let keptQuery = "";

export function ChatList({ selected }: { selected: string | null }) {
  const state = useSession();
  const rows = useMemo(() => summarize(state), [state]);
  const [query, setQueryState] = useState(keptQuery);
  const [limit, setLimit] = useState(PAGE);
  const setQuery = (q: string) => {
    keptQuery = q;
    setQueryState(q);
    setLimit(PAGE);
  };
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState<ConversationSummary | null>(null);
  const order = useChatOrder();
  const radio = state.self?.key ?? "";
  const pins = radioPins(usePinStore()[radio], state.channels);

  useEffect(() => {
    const open = () => setAdding(true);
    window.addEventListener(NEW_CHAT_EVENT, open);
    return () => window.removeEventListener(NEW_CHAT_EVENT, open);
  }, []);

  // A query finds chats by name and, from two letters, messages in every chat (#42).
  const q = fold(query.trim());
  const byId = useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows]);
  const chatsFound = q ? chatsInOrder(rows.filter((r) => fold(r.title).includes(q)), order, pins) : [];
  const found = useMemo(() => findMessages(state.messages, query).filter((m) => byId.has(m.conversation)), [state.messages, query, byId]);
  const groups = chatGroups(rows, order, pins);
  const unread = rows.filter((r) => r.unread > 0).length;
  const pin = (row: ConversationSummary, on: boolean) => {
    setPinned(radio, state.channels, row, on);
    toast(on ? t("chats.list.pinned") : t("chats.list.unpinned"));
  };
  const chatRow = (row: ConversationSummary) => {
    const pinned = pinnedAt(pins, row) !== null;
    return <ChatRow key={row.id} row={row} radio={radio} selected={selected === row.id} pinned={pinned} onPin={() => pin(row, !pinned)} onDelete={() => setDeleting(row)} />;
  };

  return (
    <div className="list-pane">
      <header className="list-head">
        <h1>{t("chats.list.title")}</h1>
        <RadioTag />
        <IconButton label={t("chats.newChat.title")} onClick={() => setAdding(true)}>
          <PlusIcon size={20} />
        </IconButton>
      </header>
      <SearchField
        value={query}
        onValue={setQuery}
        onKeyDown={(e) => {
          if (e.key === "Escape" && query) {
            e.preventDefault();
            setQuery("");
          }
        }}
        placeholder={t("chats.list.find")}
        aria-label={t("chats.list.findLabel")}
        enterKeyHint="search"
        data-find
      />
      <NewBuildStrip />
      {rows.length === 0 ? (
        <div className="empty muted">{t("chats.list.empty")}</div>
      ) : q ? (
        <div className="list">
          {chatsFound.length === 0 && found.length === 0 ? <div className="empty muted">{t("chats.list.noMatch")}</div> : null}
          {chatsFound.length ? (
            <>
              <div className="list-group">{t("chats.search.chats")}</div>
              <ul className="list-rows" role="list">
                {chatsFound.map(chatRow)}
              </ul>
            </>
          ) : null}
          {found.length ? (
            <>
              <div className="list-group">{t("chats.search.messages", { count: found.length })}</div>
              <ul className="list-rows" role="list">
                {found.slice(0, limit).map((m) => (
                  <FoundRow key={m.id} message={m} row={byId.get(m.conversation)!} query={query} />
                ))}
              </ul>
              {found.length > limit ? (
                <button type="button" className="list-more" onClick={() => setLimit(limit + PAGE)}>
                  {t("chats.search.more", { count: Math.min(PAGE, found.length - limit) })}
                </button>
              ) : null}
            </>
          ) : null}
        </div>
      ) : (
        <div className="list">
          <div className="list-summary muted">
            <span className="grow">
              {t("chats.list.count", { count: rows.length })}
              {unread ? ` · ${t("chats.list.unread", { count: unread })}` : ""}
            </span>
            <SortButton />
          </div>
          {groups.map((g, i) => (
            <Fragment key={g.id}>
              <div className="list-group">{g.title}</div>
              {/* Untitled pinned chats end at a line, so the rows under it read as the rest. */}
              <ul className={["list-rows", g.id === "pinned" && !g.title && i < groups.length - 1 ? "pinned-end" : ""].join(" ")} role="list">
                {g.rows.map(chatRow)}
              </ul>
            </Fragment>
          ))}
        </div>
      )}
      <NewChat open={adding} onClose={() => setAdding(false)} />
      <Confirm
        open={deleting !== null}
        title={deleting?.kind === "channel" ? t("chats.list.clearTitle", { name: deleting.title }) : t("chats.list.deleteTitle", { name: deleting?.title ?? "" })}
        body={<p>{deleting?.kind === "channel" ? t("chats.list.clearBody") : t("chats.list.deleteBody")}</p>}
        confirmLabel={deleting?.kind === "channel" ? t("common.clear") : t("common.delete")}
        danger
        onCancel={() => setDeleting(null)}
        onConfirm={() => {
          if (deleting) {
            session.deleteConversation(deleting.id);
            // A person's chat goes from the list, and its pin with it; a cleared channel stays, pinned.
            if (deleting.kind !== "channel" && pinnedAt(pins, deleting) !== null) setPinned(radio, state.channels, deleting, false);
            if (selected === deleting.id) openConversation(null);
            toast(deleting.kind === "channel" ? t("chats.list.cleared") : t("chats.list.deleted"));
          }
          setDeleting(null);
        }}
      />
    </div>
  );
}

/** The list's order, named, and the menu that changes it. */
function SortButton() {
  const prefs = useChatOrder();
  const order = CHAT_ORDERS.find((o) => o.id === prefs.order)!;
  return (
    <button
      type="button"
      className={["sort-btn", changed(prefs) ? "changed" : ""].join(" ")}
      aria-label={t("chats.order.buttonLabel", { order: t(order.label).toLowerCase() })}
      onClick={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        openSortMenu({ x: r.left, y: r.bottom + 4 });
      }}
    >
      <SortIcon size={14} />
      {t(order.short)}
      <ChevronDownIcon size={12} />
    </button>
  );
}

/** Opened again after the switch flips, so the menu shows it flipped. */
function openSortMenu(at: MenuAt): void {
  const { order, channelsFirst } = getChatOrder();
  showMenu(
    [
      ...CHAT_ORDERS.map((o) => ({
        label: t(o.label),
        checked: o.id === order,
        onSelect: () => setChatOrder({ order: o.id }),
      })),
      {
        label: t("chats.order.channelsFirst"),
        hint: channelsFirst ? t("chats.order.channelsFirstOn") : t("chats.order.channelsFirstOff"),
        toggle: true,
        checked: channelsFirst,
        group: true,
        onSelect: () => {
          setChatOrder({ channelsFirst: !channelsFirst });
          openSortMenu(at);
        },
      },
    ],
    { title: t("chats.order.menuTitle"), at },
  );
}

/** A message the search found: its chat, who wrote it, the words around the match. Tapped, the chat opens at it. */
function FoundRow({ message, row, query }: { message: MessageRecord; row: ConversationSummary; query: string }) {
  const who =
    message.direction === "out"
      ? t("chats.search.you")
      : (row.kind === "channel" || message.txtType === TxtType.SignedPlain) && message.sender
        ? `${message.sender}:`
        : null;
  return (
    <li>
      <button
        type="button"
        className="row"
        onClick={() => {
          jumpTo({ conversation: message.conversation, id: message.id, query });
          openConversation(message.conversation);
        }}
      >
        <Avatar name={row.title} type={row.contact?.type} channel={row.kind === "channel" ? channelAccess(row.channel) : undefined} size={44} />
        <span className="row-main">
          <span className="row-top">
            <span className="row-title">{row.title}</span>
            <span className="row-when muted">{ago(message.receivedAt)}</span>
          </span>
          <span className="row-bottom">
            <span className="row-sub muted">
              {who ? `${who} ` : ""}
              {marked(snippet(message.text, query), query)}
            </span>
          </span>
        </span>
      </button>
    </li>
  );
}

function ChatRow({ row, radio, selected, pinned, onPin, onDelete }: { row: ConversationSummary; radio: string; selected: boolean; pinned: boolean; onPin: () => void; onDelete: () => void }) {
  const target = parseConversation(row.id);
  const draft = useDraft(radio, row.id);
  const press = usePress((at) => {
    const items: (MenuItem | null)[] = [
        target.kind === "channel"
          ? { label: t("chats.channel.title"), icon: <HashIcon size={17} />, onSelect: () => setStack("chats", [{ kind: "chat", conversation: row.id }, { kind: "channel", index: target.index }]) }
          : target.kind === "contact"
            ? { label: t("chats.row.profile"), icon: <PersonIcon size={17} />, onSelect: () => setStack("chats", [{ kind: "chat", conversation: row.id }, { kind: "profile", key: target.key }]) }
            : null,
        row.unread > 0 ? { label: t("chats.row.markRead"), icon: <CheckIcon size={17} />, onSelect: () => session.markRead(row.id) } : null,
        pinned ? { label: t("chats.row.unpin"), icon: <PinOffIcon size={17} />, onSelect: onPin } : { label: t("chats.row.pin"), icon: <PinIcon size={17} />, onSelect: onPin },
        { label: row.kind === "channel" ? t("chats.row.clearMessages") : t("chats.row.deleteChat"), icon: <TrashIcon size={17} />, danger: true, onSelect: onDelete },
    ];
    showMenu(items.filter((x): x is MenuItem => x !== null), { title: row.title, at });
  });
  const swipe = useSwipe();
  const own = useNoticePrefs().chat[row.id];
  return (
    <li className="swipe" ref={swipe.ref}>
      <button type="button" className="swipe-action" tabIndex={-1} onClick={() => { swipe.close(); onDelete(); }}>
        {row.kind === "channel" ? t("common.clear") : t("common.delete")}
      </button>
      <button type="button" className={["row", selected ? "selected" : ""].join(" ")} onClick={() => (swipe.isOpen() ? swipe.close() : openConversation(row.id))} {...press}>
        <Avatar name={row.title} type={row.contact?.type} channel={row.kind === "channel" ? channelAccess(row.channel) : undefined} size={44} />
        <span className="row-main">
          <span className="row-top">
            <span className="row-title">
              {row.title}
              {row.contact && isFavourite(row.contact) ? <StarFilledIcon size={11} className="star" /> : null}
              {own === "off" || own === "mentions" ? <BellOffIcon size={12} className="row-quiet" aria-label={own === "off" ? t("chats.row.noticesOff") : t("chats.row.noticesMentions")} /> : null}
            </span>
            {row.lastAt ? <span className="row-when muted">{ago(row.lastAt)}</span> : null}
          </span>
          <span className="row-bottom">
            <span className="row-sub muted">
              {draft ? (
                <>
                  <span className="row-draft">{t("chats.row.draft")}</span> {draft}
                </>
              ) : (
                (row.preview ?? (row.kind === "channel" ? t("chats.row.quiet") : ""))
              )}
            </span>
            {row.unread > 0 ? <span className="badge">{row.unread}</span> : pinned ? <PinIcon size={14} className="row-pin" aria-label={t("chats.row.pinned")} /> : null}
          </span>
        </span>
      </button>
    </li>
  );
}

const ACTION_W = 88;

/**
 * A row pulled left on a touch screen shows the action behind it. Touch
 * events, not pointer events: the list keeps scrolling vertically, and a
 * horizontal pull is claimed only once it is clearly one.
 */
function useSwipe() {
  const ref = useRef<HTMLLIElement>(null);
  const open = useRef(false);
  const row = () => ref.current?.querySelector<HTMLElement>(".row") ?? null;
  const set = (x: number, animate: boolean) => {
    const el = row();
    if (!el) return;
    el.style.transition = animate ? "" : "none";
    el.style.transform = x ? `translateX(${x}px)` : "";
  };
  useEffect(() => {
    const li = ref.current;
    if (!li) return;
    let start: { x: number; y: number } | null = null;
    let active = false;
    const base = () => (open.current ? -ACTION_W : 0);
    const down = (e: TouchEvent) => {
      const t = e.touches[0];
      start = t ? { x: t.clientX, y: t.clientY } : null;
      active = false;
    };
    const move = (e: TouchEvent) => {
      const t = e.touches[0];
      if (!start || !t) return;
      const dx = t.clientX - start.x;
      const dy = t.clientY - start.y;
      if (!active) {
        if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
        if (Math.abs(dy) > Math.abs(dx)) {
          start = null;
          return;
        }
        active = true;
      }
      e.preventDefault();
      set(Math.max(-ACTION_W - 24, Math.min(0, base() + dx)), false);
    };
    const up = (e: TouchEvent) => {
      if (!active || !start) return;
      const t = e.changedTouches[0];
      const x = base() + (t ? t.clientX - start.x : 0);
      open.current = x < -ACTION_W / 2;
      set(open.current ? -ACTION_W : 0, true);
      start = null;
      active = false;
    };
    li.addEventListener("touchstart", down, { passive: true });
    li.addEventListener("touchmove", move, { passive: false });
    li.addEventListener("touchend", up);
    li.addEventListener("touchcancel", up);
    return () => {
      li.removeEventListener("touchstart", down);
      li.removeEventListener("touchmove", move);
      li.removeEventListener("touchend", up);
      li.removeEventListener("touchcancel", up);
    };
  }, []);
  return {
    ref,
    isOpen: () => open.current,
    close: () => {
      open.current = false;
      set(0, true);
    },
  };
}
