import { useEffect, useMemo, useState } from "react";
import { channelConversation, fromHex, KEYLESS_CONVERSATION, KEYLESS_INDEX } from "@meshnet/meshcore";
import { channelAccess } from "../lib/channels.js";
import { messagesIn } from "../lib/conversations.js";
import { openConversation, openWriters } from "../lib/nav.js";
import { session, useSession } from "../lib/session.js";
import { act, toast } from "../lib/toast.js";
import { writersIn, type Writer } from "../lib/writers.js";
import { Confirm } from "../ui/Dialog.js";
import { ActionRow, Block, Group, LinkRow } from "../ui/List.js";
import { Avatar } from "./Avatar.js";
import { ChatNotices } from "./ChatNotices.js";
import { HeroName } from "./HeroName.js";
import { CopyIcon } from "./Icons.js";
import { Gone, ScreenHead, type Chrome } from "./ScreenHead.js";
import { t } from "../i18n/index.js";

/** A channel's own page, opened from its conversation: who writes in it, its name, its key, and leaving it. */
export function ChannelView({ index, chrome }: { index: number; chrome: Chrome }) {
  const state = useSession();
  const channel = state.channels.find((c) => c.index === index);
  const online = state.status === "ready";
  const [name, setName] = useState(channel?.name ?? "");
  const [removing, setRemoving] = useState(false);
  const writers = useMemo(() => writersIn(messagesIn(state, channelConversation(index))), [state, index]);

  useEffect(() => setName(channel?.name ?? ""), [channel?.name]);

  if (index === KEYLESS_INDEX) return <KeylessView chrome={chrome} writers={writers} />;
  if (!channel) return <Gone chrome={chrome} title={t("chats.channel.title")} text={t("chats.channel.gone")} />;

  const rename = () => {
    const next = name.trim();
    if (!next || next === channel.name) return setName(channel.name);
    void act(() => session.setChannel(channel.index, next, fromHex(channel.secret)), t("chats.channel.renamed"));
  };

  return (
    <div className="screen">
      <ScreenHead chrome={chrome}>
        <span className="screen-name">{t("chats.channel.title")}</span>
      </ScreenHead>
      <div className="screen-scroll">
        <div className="hero">
          <Avatar name={channel.name || t("chats.conversation.channel", { index: channel.index })} channel={channelAccess(channel)} size={68} />
          <HeroName name={channel.name || t("chats.conversation.channel", { index: channel.index })} label={t("chats.row.copyChannelName")} />
          <span className="muted">{t("chats.channel.slot", { index: channel.index })}</span>
        </div>
        <ChatNotices conversation={channelConversation(channel.index)} direct={false} />
        {writers.length > 0 ? (
          <Group>
            <LinkRow
              label={t("chats.channel.writers")}
              value={
                <span className="writers-row-value">
                  <span className="faces" aria-hidden="true">
                    {writers.slice(0, 3).map((w) => (
                      <Avatar key={`${w.mine}:${w.name}`} name={w.name} size={22} />
                    ))}
                  </span>
                  {writers.length}
                </span>
              }
              onClick={() => openWriters(channel.index)}
            />
          </Group>
        ) : null}
        <Group title={t("chats.channel.name")}>
          <Block>
            <input
              className="input"
              value={name}
              maxLength={31}
              disabled={!online}
              aria-label={t("chats.channel.nameLabel")}
              onChange={(e) => setName(e.target.value)}
              onBlur={rename}
              onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLInputElement).blur()}
            />
          </Block>
        </Group>
        <Group title={t("chats.channel.key")} note={t("chats.channel.keyNote")}>
          <LinkRow
            label={<span className="mono key-text">{channel.secret}</span>}
            trailing={<CopyIcon size={14} className="line-chev" />}
            onClick={() => void navigator.clipboard?.writeText(channel.secret).then(() => toast(t("chats.channel.keyCopied")))}
          />
        </Group>
        {channel.index === 0 ? (
          <p className="group-note">{t("chats.channel.firstStays")}</p>
        ) : (
          <Group>
            <ActionRow label={t("chats.channel.remove")} danger disabled={!online} onClick={() => setRemoving(true)} />
          </Group>
        )}
      </div>
      <Confirm
        open={removing}
        title={t("chats.channel.removeTitle", { name: channel.name || t("chats.channel.fallbackName", { index: channel.index }) })}
        body={<p>{t("chats.channel.removeBody")}</p>}
        confirmLabel={t("chats.channel.removeConfirm")}
        danger
        onCancel={() => setRemoving(false)}
        onConfirm={async () => {
          setRemoving(false);
          if (await act(() => session.clearChannel(channel.index), t("chats.channel.removed"))) openConversation(null);
        }}
      />
    </div>
  );
}

/** The chat of messages sent without a key: where they come from, its notices, who wrote, and deleting it. */
function KeylessView({ chrome, writers }: { chrome: Chrome; writers: Writer[] }) {
  const [deleting, setDeleting] = useState(false);
  const title = t("chats.conversation.keyless");
  return (
    <div className="screen">
      <ScreenHead chrome={chrome}>
        <span className="screen-name">{t("chats.keyless.head")}</span>
      </ScreenHead>
      <div className="screen-scroll">
        <div className="hero">
          <Avatar name={title} channel="keyless" size={68} />
          <h1>{title}</h1>
          <span className="muted">{t("chats.keyless.subtitle")}</span>
        </div>
        <p className="group-note">{t("chats.keyless.about")}</p>
        <ChatNotices conversation={KEYLESS_CONVERSATION} direct={false} />
        {writers.length > 0 ? (
          <Group>
            <LinkRow
              label={t("chats.channel.writers")}
              value={
                <span className="writers-row-value">
                  <span className="faces" aria-hidden="true">
                    {writers.slice(0, 3).map((w) => (
                      <Avatar key={`${w.mine}:${w.name}`} name={w.name} size={22} />
                    ))}
                  </span>
                  {writers.length}
                </span>
              }
              onClick={() => openWriters(KEYLESS_INDEX)}
            />
          </Group>
        ) : null}
        <Group>
          <ActionRow label={t("chats.row.deleteChat")} danger onClick={() => setDeleting(true)} />
        </Group>
      </div>
      <Confirm
        open={deleting}
        title={t("chats.list.dropTitle", { name: title })}
        body={<p>{t("chats.list.dropBody")}</p>}
        confirmLabel={t("common.delete")}
        danger
        onCancel={() => setDeleting(false)}
        onConfirm={() => {
          setDeleting(false);
          session.deleteConversation(KEYLESS_CONVERSATION);
          openConversation(null);
          toast(t("chats.list.deleted"));
        }}
      />
    </div>
  );
}
