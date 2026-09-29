import { useMemo } from "react";
import { AdvType, parseConversation } from "@meshnet/meshcore";
import { messagesIn, shownIn, titleOf } from "../lib/conversations.js";
import { useSession } from "../lib/session.js";
import { MessageDetails } from "./MessageDetails.js";
import { Gone, ScreenHead, type Chrome } from "./ScreenHead.js";
import { t } from "../i18n/index.js";

/**
 * How one message travelled: a sheet over the conversation on a phone, the
 * panel beside it on a desktop. The message itself stays in the chat.
 */
export function MessageView({ conversation, id, chrome, bare = false }: { conversation: string; id: string; chrome: Chrome; bare?: boolean | undefined }) {
  const state = useSession();
  const message = state.messages.find((m) => m.id === id);
  // Whether the time the chat shows on it is not the sender's, which only its place among the rest tells.
  const clockOff = useMemo(
    () => message?.direction === "in" && (shownIn(messagesIn(state, conversation)).get(id)?.clockOff ?? false),
    [state.messages, conversation, id],
  );
  if (!message) return bare ? <div className="empty muted">{t("chats.message.gone")}</div> : <Gone chrome={chrome} title={t("chats.message.title")} text={t("chats.message.gone")} />;
  const target = parseConversation(conversation);
  const many = target.kind === "channel" || (target.kind === "contact" && state.contacts[target.key]?.type === AdvType.Room);
  const peer = message.direction === "in" && many ? (message.sender ?? "?") : titleOf(state, conversation);
  const body = <MessageDetails message={message} peer={peer} clockOff={clockOff} />;
  if (bare) return <div className="message-body">{body}</div>;
  return (
    <div className="screen">
      <ScreenHead chrome={chrome}>
        <span className="screen-name">{t("chats.message.travelled")}</span>
      </ScreenHead>
      <div className="screen-scroll message-body">{body}</div>
    </div>
  );
}
