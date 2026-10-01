import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { Face } from "../lib/announce.js";
import { hue } from "../lib/format.js";
import { Avatar } from "./Avatar.js";
import { CloseIcon } from "./Icons.js";
import { t } from "../i18n/index.js";

/**
 * One of the app's own notices (noticePrefs `shownBy: "app"`): a banner at
 * the top of a phone or a tab, or a card in a corner of a computer's screen.
 * The circle of who it is from, their name in its hue as in a chat, and what
 * they said. A tap opens it; the rest is the host's.
 */
export function NoticeCard({ title, body, face, onOpen, onClose, children }: {
  title: string;
  body: string;
  face: Face | null | undefined;
  onOpen: () => void;
  onClose?: (() => void) | undefined;
  /** What shows under it, such as the desktop card's reply field. */
  children?: ReactNode;
}) {
  // The name the title starts with, in its circle's hue; the rest ("in #test", "· 3 new") as it is.
  const named = face && title.startsWith(face.name) ? face.name : null;
  return (
    <div className="notice-card" role="button" tabIndex={0} onClick={onOpen} onKeyDown={(e) => e.key === "Enter" && e.target === e.currentTarget && onOpen()}>
      {face ? <Avatar name={face.name} type={face.type} channel={face.channel} size={36} /> : <img className="notice-app" src="./icon.svg" alt="" width={36} height={36} />}
      <div className="notice-text">
        <div className="notice-title">
          {named ? (
            <>
              <span className="notice-who" style={{ "--hue": hue(named) } as React.CSSProperties}>{named}</span>
              {title.slice(named.length)}
            </>
          ) : (
            title
          )}
        </div>
        <div className="notice-body">{body}</div>
      </div>
      {onClose ? (
        <button
          type="button"
          className="notice-close"
          aria-label={t("notices.dismiss")}
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
        >
          <CloseIcon size={14} />
        </button>
      ) : null}
      {children}
    </div>
  );
}

/**
 * The desktop card's answer row, shown while the pointer is on the card: a
 * field that sends on Enter, and "Mark read". Clicks in it stay in it.
 */
export function NoticeReply({ onReply, onRead, onBusy }: {
  onReply: (text: string) => void;
  onRead: () => void;
  /** Whether the field holds the card: focused, or with something typed. */
  onBusy: (busy: boolean) => void;
}) {
  const [text, setText] = useState("");
  const field = useRef<HTMLInputElement>(null);
  const key = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && text.trim()) {
      onReply(text);
      setText("");
    } else if (e.key === "Escape") {
      setText("");
      field.current?.blur();
    }
  };
  return (
    <div className="notice-reply" onClick={(e) => e.stopPropagation()}>
      <input
        ref={field}
        id="notice-reply"
        className="notice-field"
        value={text}
        placeholder={t("notices.reply")}
        autoComplete="off"
        onChange={(e) => {
          setText(e.target.value);
          onBusy(true);
        }}
        onFocus={() => onBusy(true)}
        onBlur={() => onBusy(text.trim() !== "")}
        onKeyDown={key}
      />
      <button type="button" className="notice-read" onClick={onRead}>
        {t("notices.markRead")}
      </button>
    </div>
  );
}
