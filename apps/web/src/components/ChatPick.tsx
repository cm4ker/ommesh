/**
 * Picking messages in a chat, as Telegram does it.
 *
 * With a mouse, a drag that stays in one bubble selects its words, as before;
 * once it crosses into another message the words go and whole messages are
 * picked instead, and a drag that starts in the empty space beside a bubble
 * picks from the start. Ctrl and a click picks one. While any are picked, a
 * click picks or lets go, Shift and a click adds the stretch since the last
 * one, and a drag picks a stretch.
 *
 * On a touch screen a message's menu has Select. Then a tap picks or lets go,
 * and a finger drawn along the column of rings picks a stretch.
 */

import { useEffect, useRef, type RefObject } from "react";
import { dragged, extended, toggled } from "../lib/messagePick.js";
import { Button, IconButton } from "../ui/Button.js";
import { CloseIcon, CopyIcon, ReplyIcon, TrashIcon } from "./Icons.js";
import { t } from "../i18n/index.js";

interface Picking {
  /** The ids of the messages drawn, in order. */
  order: () => string[];
  picked: () => string[];
  set: (ids: string[]) => void;
  /** Whether the rings stand at the left edge (a phone) rather than the right. */
  ringsLeft: () => boolean;
}

/** How near the list's top or bottom a drag starts scrolling it, px. */
const EDGE_ZONE = 40;
/** The column of rings a finger is drawn along, px from the list's edge. */
const RING_COLUMN = 44;
/** How far the mouse goes from the empty space beside a bubble before the drag picks, px. */
const SLOP = 6;

interface Drag {
  /** Words in a bubble, the empty space beside one before it has moved, or whole messages. */
  mode: "text" | "space" | "pick";
  anchor: string;
  /** What was picked when the drag began. */
  before: string[];
  moved: boolean;
  x: number;
  y: number;
}

export function usePickGestures(scroller: RefObject<HTMLDivElement | null>, picking: Picking): void {
  const latest = useRef(picking);
  latest.current = picking;
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    // The kind of pointer behind the press under way: a phone sends mouse events after a tap too.
    let pointer = "mouse";
    let drag: Drag | null = null;
    // The message picked or let go last, where Shift and a click starts from.
    let last: string | null = null;
    // The click that ends a press already handled here goes no further.
    let swallow = false;
    let point = { x: 0, y: 0 };
    let frame = 0;

    const idOf = (node: EventTarget | null): string | null => {
      const row = node instanceof Element ? node.closest<HTMLElement>("[data-id]") : null;
      return row && el.contains(row) ? (row.dataset.id ?? null) : null;
    };
    // The message under a point, the point held inside the list: a drag above or below it reaches the edge.
    const idAt = (x: number, y: number) => {
      const box = el.getBoundingClientRect();
      return idOf(document.elementFromPoint(Math.min(box.right - 2, Math.max(box.left + 2, x)), Math.min(box.bottom - 2, Math.max(box.top + 2, y))));
    };
    const pickTo = (id: string) => {
      if (!drag) return;
      drag.moved = true;
      last = id;
      latest.current.set(dragged(latest.current.order(), drag.before, drag.anchor, id));
    };
    const follow = () => {
      if (drag?.mode !== "pick") return;
      const id = idAt(point.x, point.y);
      if (id && (drag.moved || id !== drag.anchor)) pickTo(id);
    };
    const toPick = () => {
      if (!drag) return;
      drag.mode = "pick";
      el.classList.add("picking");
      window.getSelection()?.removeAllRanges();
    };
    // Held near the top or the bottom, the list scrolls on, faster the further out.
    const scrollOn = () => {
      frame = 0;
      if (drag?.mode !== "pick") return;
      const box = el.getBoundingClientRect();
      const over = point.y < box.top + EDGE_ZONE ? point.y - box.top - EDGE_ZONE : point.y > box.bottom - EDGE_ZONE ? point.y - box.bottom + EDGE_ZONE : 0;
      if (!over) return;
      el.scrollTop += Math.max(-24, Math.min(24, over / 2));
      follow();
      frame = requestAnimationFrame(scrollOn);
    };
    const end = () => {
      cancelAnimationFrame(frame);
      frame = 0;
      el.classList.remove("picking");
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      drag = null;
    };

    const onPointerDown = (e: PointerEvent) => {
      pointer = e.pointerType;
    };
    const onMouseDown = (e: MouseEvent) => {
      swallow = false;
      if (pointer !== "mouse" || e.button !== 0) return;
      const id = idOf(e.target);
      if (!id) return;
      const target = e.target as Element;
      const { order, picked, set } = latest.current;
      const now = picked();
      point = { x: e.clientX, y: e.clientY };
      if (now.length) {
        e.preventDefault();
        swallow = true;
        if (e.shiftKey && last) {
          set(extended(order(), now, last, id));
          last = id;
          return;
        }
        drag = { mode: "pick", anchor: id, before: now, moved: false, x: e.clientX, y: e.clientY };
      } else if ((e.ctrlKey || e.metaKey) && !target.closest("a")) {
        e.preventDefault();
        swallow = true;
        set([id]);
        last = id;
        return;
      } else if (target.closest(".bubble, .jumbo, button, a")) {
        drag = { mode: "text", anchor: id, before: [], moved: false, x: e.clientX, y: e.clientY };
      } else {
        e.preventDefault();
        drag = { mode: "space", anchor: id, before: [], moved: false, x: e.clientX, y: e.clientY };
      }
      window.addEventListener("mousemove", onMouseMove);
      window.addEventListener("mouseup", onMouseUp);
    };
    const onMouseMove = (e: MouseEvent) => {
      if (!drag) return;
      if (!(e.buttons & 1)) {
        end();
        return;
      }
      point = { x: e.clientX, y: e.clientY };
      if (drag.mode === "text") {
        // Out of its bubble into another message: whole messages from here, the words let go.
        const id = idAt(point.x, point.y);
        if (!id || id === drag.anchor) return;
        toPick();
        pickTo(drag.anchor);
      } else if (drag.mode === "space") {
        if (Math.hypot(point.x - drag.x, point.y - drag.y) < SLOP) return;
        toPick();
        pickTo(drag.anchor);
      }
      window.getSelection()?.removeAllRanges();
      follow();
      if (!frame) frame = requestAnimationFrame(scrollOn);
    };
    const onMouseUp = () => {
      if (drag?.mode === "pick") {
        swallow = true;
        if (!drag.moved) {
          const { order, picked, set } = latest.current;
          set(toggled(order(), picked(), drag.anchor));
          last = drag.anchor;
        }
      }
      end();
    };

    // While messages are picked, a tap picks or lets go; a click a press here handled goes no further.
    const onClick = (e: MouseEvent) => {
      const id = idOf(e.target);
      if (swallow) {
        swallow = false;
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      const { order, picked, set } = latest.current;
      if (!id || !picked().length) return;
      e.preventDefault();
      e.stopPropagation();
      set(toggled(order(), picked(), id));
      last = id;
    };

    // The wheel turned in the middle of a drag: the message now under the pointer.
    const onScroll = () => follow();

    const onTouchStart = (e: TouchEvent) => {
      const touch = e.touches[0];
      const { picked, ringsLeft } = latest.current;
      const now = picked();
      if (!touch || e.touches.length !== 1 || !now.length) return;
      const box = el.getBoundingClientRect();
      const inColumn = ringsLeft() ? touch.clientX - box.left < RING_COLUMN : box.right - touch.clientX < RING_COLUMN;
      const id = idOf(e.target);
      if (!inColumn || !id) return;
      point = { x: touch.clientX, y: touch.clientY };
      drag = { mode: "pick", anchor: id, before: now, moved: false, x: touch.clientX, y: touch.clientY };
    };
    const onTouchMove = (e: TouchEvent) => {
      const touch = e.touches[0];
      if (!drag || !touch) return;
      // Along the rings the finger picks rather than scrolls.
      e.preventDefault();
      point = { x: touch.clientX, y: touch.clientY };
      follow();
      if (!frame) frame = requestAnimationFrame(scrollOn);
    };
    const onTouchEnd = () => {
      if (drag?.moved) swallow = true;
      end();
    };

    el.addEventListener("pointerdown", onPointerDown);
    el.addEventListener("mousedown", onMouseDown);
    el.addEventListener("click", onClick, true);
    el.addEventListener("scroll", onScroll, { passive: true });
    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    el.addEventListener("touchend", onTouchEnd);
    el.addEventListener("touchcancel", onTouchEnd);
    return () => {
      end();
      el.removeEventListener("pointerdown", onPointerDown);
      el.removeEventListener("mousedown", onMouseDown);
      el.removeEventListener("click", onClick, true);
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
      el.removeEventListener("touchcancel", onTouchEnd);
    };
  }, [scroller]);
}

/**
 * In place of the chat's head while messages are picked. On the desktop, as in
 * Telegram's, the actions with their counts and Cancel; on a phone, a cross and
 * the count, the actions going to the bar at the foot.
 */
export function PickHead({ count, wide, onCopy, onDelete, onCancel }: { count: number; wide: boolean; onCopy: () => void; onDelete: () => void; onCancel: () => void }) {
  if (!wide) {
    return (
      <header className="screen-head chat-pick-head">
        <IconButton label={t("chats.pick.clear")} onClick={onCancel}>
          <CloseIcon size={20} />
        </IconButton>
        <span className="screen-name chat-pick-count" aria-live="polite">
          {t("chats.pick.count", { count })}
        </span>
      </header>
    );
  }
  return (
    <header className="screen-head chat-pick-head">
      <Button variant="primary" size="sm" onClick={onCopy}>
        <CopyIcon size={15} /> {t("chats.pick.copy")} <span className="chat-pick-n">{count}</span>
      </Button>
      <Button variant="danger" size="sm" onClick={onDelete}>
        <TrashIcon size={15} /> {t("chats.pick.delete")} <span className="chat-pick-n">{count}</span>
      </Button>
      <Button variant="ghost" size="sm" className="chat-pick-cancel" onClick={onCancel}>
        {t("common.cancel")}
      </Button>
    </header>
  );
}

/** A phone's actions on the messages picked, in place of the field: within reach of the thumb. */
export function PickBar({ onCopy, onReply, onDelete }: { onCopy: () => void; onReply: (() => void) | undefined; onDelete: () => void }) {
  return (
    <footer className="chat-pick-bar">
      <button type="button" onClick={onCopy}>
        <CopyIcon size={22} />
        {t("chats.pick.copy")}
      </button>
      {onReply ? (
        <button type="button" onClick={onReply}>
          <ReplyIcon size={22} />
          {t("chats.message.reply")}
        </button>
      ) : null}
      <button type="button" className="danger" onClick={onDelete}>
        <TrashIcon size={22} />
        {t("chats.pick.delete")}
      </button>
    </footer>
  );
}
