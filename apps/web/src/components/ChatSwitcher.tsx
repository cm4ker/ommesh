import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { t } from "../i18n/index.js";
import { chatAccess } from "../lib/channels.js";
import { chatsInOrder, getChatOrder } from "../lib/chatOrder.js";
import { getPins } from "../lib/chatPins.js";
import { summarize } from "../lib/conversations.js";
import { getNav, openConversation, shownConversation } from "../lib/nav.js";
import { switchable } from "../lib/recentChats.js";
import { session, useSession } from "../lib/session.js";
import { Avatar } from "./Avatar.js";

/** How many chats the row holds. */
const SHOWN = 7;

interface Open {
  ids: string[];
  at: number;
  current: string | null;
}

/**
 * The desktop's Ctrl+Tab, as in Telegram's desktop app (#80): held Ctrl and a
 * Tab put up the recent chats in a row, the one on screen first and the one
 * before it ringed, so a quick Ctrl+Tab goes back and forth between two
 * chats. Each Tab more rings the next, Shift+Tab the one before, and letting
 * go of Ctrl opens the ringed one; Escape, or leaving the window, puts the row
 * away. A browser keeps Ctrl+Tab for its own tabs, so there it never comes.
 */
export function ChatSwitcher() {
  const [open, setOpen] = useState<Open | null>(null);
  // Read and set at once, as a held Tab repeats faster than a draw.
  const shown = useRef<Open | null>(null);
  const set = (next: Open | null) => {
    shown.current = next;
    setOpen(next);
  };

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      const now = shown.current;
      if (now && e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        set(null);
        return;
      }
      if (e.key !== "Tab" || !e.ctrlKey || e.altKey || e.metaKey) return;
      if (!now && document.querySelector("dialog[open], .sheet-layer, .palette-layer, .popover")) return;
      e.preventDefault();
      e.stopPropagation();
      if (now) {
        const n = now.ids.length;
        set({ ...now, at: (now.at + (e.shiftKey ? n - 1 : 1)) % n });
        return;
      }
      const state = session.getState();
      const current = shownConversation({ ...getNav(), section: "chats" }, true);
      const listed = chatsInOrder(summarize(state), getChatOrder(), getPins(state.self?.key ?? "", state.channels)).map((r) => r.id);
      const ids = switchable(current, listed, SHOWN);
      const others = ids.filter((id) => id !== current).length;
      if (others === 0) return;
      const first = ids[0] === current ? 1 : 0;
      set({ ids, at: e.shiftKey ? ids.length - 1 : first, current });
    };
    const up = (e: KeyboardEvent) => {
      const now = shown.current;
      if (e.key !== "Control" || !now) return;
      set(null);
      const picked = now.ids[now.at];
      if (picked && picked !== now.current) openConversation(picked);
    };
    const away = () => set(null);
    window.addEventListener("keydown", down, true);
    window.addEventListener("keyup", up, true);
    window.addEventListener("blur", away);
    return () => {
      window.removeEventListener("keydown", down, true);
      window.removeEventListener("keyup", up, true);
      window.removeEventListener("blur", away);
    };
  }, []);

  if (!open) return null;
  return (
    <SwitcherRow
      ids={open.ids}
      at={open.at}
      onPick={(id) => {
        set(null);
        if (id !== open.current) openConversation(id);
      }}
    />
  );
}

function SwitcherRow({ ids, at, onPick }: { ids: string[]; at: number; onPick: (id: string) => void }) {
  const state = useSession();
  const rows = useMemo(() => new Map(summarize(state).map((r) => [r.id, r])), [state]);
  const ringed = useRef<HTMLButtonElement>(null);
  // A block, not an arrow's value: scrollIntoView returns a promise in newer engines, and React takes a returned value for the clean-up.
  useLayoutEffect(() => {
    ringed.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [at]);
  return (
    <div className="chat-switcher-layer">
      <div className="chat-switcher" role="listbox" aria-label={t("chats.switcher.label")}>
        {ids.map((id, i) => {
          const row = rows.get(id);
          if (!row) return null;
          return (
            <button
              key={id}
              ref={i === at ? ringed : undefined}
              type="button"
              role="option"
              aria-selected={i === at}
              className={["chat-switcher-item", i === at ? "on" : ""].join(" ")}
              // The focus stays where it was, in the message field, say.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onPick(id)}
            >
              <Avatar name={row.title} type={row.contact?.type} channel={row.kind === "channel" ? chatAccess(row.id, row.channel) : undefined} size={64} />
              <span className="chat-switcher-name">{row.title}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
