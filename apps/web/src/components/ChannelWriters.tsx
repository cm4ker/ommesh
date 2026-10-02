import { useMemo, useState } from "react";
import { channelConversation, contactConversation, isConversationType, type ContactRecord } from "@meshnet/meshcore";
import { askChat } from "../lib/chatAsk.js";
import { messagesIn } from "../lib/conversations.js";
import { nameOfHash, spreadOf } from "../lib/echoes.js";
import { agoPhrase } from "../lib/format.js";
import { openConversation, openProfile } from "../lib/nav.js";
import { heardAt, hopsLabel, kindLabel } from "../lib/nodes.js";
import { sendersOf } from "../lib/senders.js";
import { session, useSession } from "../lib/session.js";
import { findWriters, writersIn, type Writer } from "../lib/writers.js";
import { SearchField } from "../ui/Field.js";
import { Group } from "../ui/List.js";
import { showMenu, type MenuItem } from "../ui/Menu.js";
import { Avatar } from "./Avatar.js";
import { AtIcon, ChatIcon, PersonIcon, SearchIcon } from "./Icons.js";
import { Gone, ScreenHead, type Chrome } from "./ScreenHead.js";
import { t } from "../i18n/index.js";

/** Who has written in a channel (#64), from the history held here, the latest to write first. */
export function ChannelWriters({ index, chrome }: { index: number; chrome: Chrome }) {
  const state = useSession();
  const channel = state.channels.find((c) => c.index === index);
  const conversation = channelConversation(index);
  const me = state.self?.name ?? null;
  const messages = useMemo(() => messagesIn(state, conversation), [state, conversation]);
  const writers = useMemo(() => writersIn(messages, me), [messages, me]);
  const [query, setQuery] = useState("");
  const shown = findWriters(writers, query);
  const now = Date.now();

  if (!channel) return <Gone chrome={chrome} title={t("chats.writers.title")} text={t("chats.channel.gone")} />;

  return (
    <div className="screen">
      <ScreenHead chrome={chrome}>
        <span className="screen-name">{t("chats.writers.title")}</span>
      </ScreenHead>
      <div className="screen-scroll">
        <SearchField
          value={query}
          onValue={setQuery}
          note={<span className={["search-note", query.trim() ? "cut" : ""].join(" ")}>{query.trim() ? t("chats.writers.shown", { shown: shown.length, count: writers.length }) : t("chats.writers.count", { count: writers.length })}</span>}
          placeholder={t("chats.writers.find")}
          aria-label={t("chats.writers.find")}
          enterKeyHint="search"
        />
        {writers.length === 0 ? <p className="group-note">{t("chats.writers.none")}</p> : shown.length === 0 ? <p className="group-note">{t("chats.writers.noMatch")}</p> : null}
        {shown.length ? (
          <Group>
            {shown.map((w) => (
              <button key={w.name} type="button" className="line line-link" onClick={() => writerMenu(w, conversation)}>
                <Avatar name={w.name} size={32} />
                <span className="line-text">
                  <span>{w.name}</span>
                  <small>
                    {agoPhrase(w.lastAt, now)} · {t("chats.writers.messages", { count: w.count })}
                  </small>
                </span>
                {w.last.hops !== null ? <span className="line-value">{w.last.hops === 0 ? t("chats.chat.direct") : t("chats.chat.hops", { count: w.last.hops })}</span> : null}
              </button>
            ))}
          </Group>
        ) : null}
        {writers.length > 0 ? <p className="group-note">{t("chats.writers.note")}</p> : null}
      </div>
    </div>
  );
}

/** How their latest came: straight, or how many hops and through which relay first. */
function wayOf(w: Writer, contacts: Record<string, ContactRecord>): string | null {
  const hops = w.last.hops;
  if (hops === null) return null;
  if (hops === 0) return t("chats.chat.direct");
  const first = spreadOf(w.last.echoes).first[0]?.hash;
  const count = t("chats.chat.hops", { count: hops });
  return first ? t("chats.writers.via", { hops: count, name: nameOfHash(first, contacts) ?? first.toUpperCase() }) : count;
}

/** What can be done about one who wrote: their profile, a word to them, a mention, their messages. */
function writerMenu(w: Writer, conversation: string): void {
  const contacts = session.getState().contacts;
  const found = sendersOf(w.last, contacts);
  const one = found.length === 1 ? found[0]! : null;
  const items: MenuItem[] = [
    found.length === 0
      ? { label: t("chats.writers.profile"), hint: t("chats.writers.noAdvert"), icon: <PersonIcon size={17} />, disabled: true, onSelect: () => {} }
      : one
        ? { label: t("chats.writers.profile"), hint: nodeLine(one), icon: <PersonIcon size={17} />, onSelect: () => openProfile(one.key) }
        : { label: t("chats.writers.profile"), hint: t("chats.chat.sameName", { count: found.length, name: w.name }), icon: <PersonIcon size={17} />, onSelect: () => pickProfile(found, w.name) },
  ];
  if (one && isConversationType(one.type)) items.push({ label: t("chats.writers.write"), icon: <ChatIcon size={17} />, onSelect: () => openConversation(contactConversation(one.key)) });
  items.push(
    {
      label: t("chats.writers.mention"),
      icon: <AtIcon size={17} />,
      onSelect: () => {
        askChat({ conversation, kind: "mention", name: w.name });
        openConversation(conversation);
      },
    },
    {
      label: t("chats.writers.theirs"),
      hint: t("chats.writers.messages", { count: w.count }),
      icon: <SearchIcon size={17} />,
      onSelect: () => {
        askChat({ conversation, kind: "from", name: w.name });
        openConversation(conversation);
      },
    },
  );
  const way = wayOf(w, contacts);
  showMenu(items, { title: way ? `${w.name} · ${way}` : w.name });
}

/** A node among several of one name, told apart by what it is and when it was last heard. */
export function nodeLine(contact: ContactRecord): string {
  const at = heardAt(contact);
  return [kindLabel(contact.type), at ? t("chats.chat.heardAgo", { time: agoPhrase(at) }) : t("chats.chat.neverHeard"), hopsLabel(contact)].join(" · ");
}

/** Several nodes go by the name: which one's profile. */
export function pickProfile(found: ContactRecord[], name: string): void {
  showMenu(
    found.map((c) => ({ label: c.name, hint: nodeLine(c), icon: <Avatar name={c.name} type={c.type} size={28} />, onSelect: () => openProfile(c.key) })),
    { title: t("chats.chat.sameName", { count: found.length, name }) },
  );
}
