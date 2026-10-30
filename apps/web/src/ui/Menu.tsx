/**
 * What else can be done with a row or a message: one menu, asked for by a
 * long press, a right click or a "More" button. With a mouse it opens where
 * the click was; on a phone it is a sheet of rows, or, for a message held,
 * a card right under the message, as in Telegram.
 */

import { Fragment, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { CheckIcon } from "../components/Icons.js";
import { useBackLayer } from "../lib/back.js";
import { moveForKeyboard } from "../lib/keyboard.js";
import type { MenuAt } from "../lib/press.js";
import { useWide } from "../lib/layout.js";
import { dismissToast, toastSpot, useToast, type ToastSpot } from "../lib/toast.js";
import { AirMark } from "./List.js";
import { Sheet } from "./Sheet.js";

export interface MenuItem {
  label: string;
  icon?: ReactNode;
  onSelect: () => void;
  danger?: boolean | undefined;
  /** It transmits. */
  air?: boolean | undefined;
  disabled?: boolean | undefined;
  hint?: string | undefined;
  /** One of a choice: the chosen one carries a check. With `toggle`, whether it is on. */
  checked?: boolean | undefined;
  /** A setting turned on and off: a switch, and the menu stays open when it flips. */
  toggle?: boolean | undefined;
  /** Starts a group of its own, set apart from the items above it. */
  group?: boolean | undefined;
  /** The keys that do the same, shown beside it where a mouse opened the menu. */
  shortcut?: string | undefined;
}

interface MenuState {
  items: MenuItem[];
  title?: string | undefined;
  at: MenuAt;
  /** What the menu is for, such as the message held: lit while the menu is open, and on a touch screen left bright over the dimmed screen with the menu under it. */
  lift: HTMLElement | null;
  /** A menu of choices that says what each is for: the popover shows the hints too, under the labels. */
  hints: boolean;
  /** At least as wide as the field it opens from, px. */
  minWidth: number | undefined;
  /** Above the items, such as a held message's emoji: its buttons close the menu themselves. */
  head: ReactNode;
  /** The head has opened out, such as into every emoji: the items step aside and the menu widens. */
  expanded: boolean;
  /** The head opened out grows by its own scrolling, as every emoji does under a held message (HoldMenu). */
  rises: boolean;
}

let current: MenuState | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function showMenu(
  items: MenuItem[],
  options: { title?: string | undefined; at?: MenuAt; lift?: HTMLElement | null | undefined; hints?: boolean; minWidth?: number; head?: ReactNode } = {},
): void {
  current?.lift?.classList.remove("held");
  current = {
    items: items.filter(Boolean),
    title: options.title,
    at: options.at ?? null,
    lift: options.lift ?? null,
    hints: options.hints ?? false,
    minWidth: options.minWidth,
    head: options.head,
    expanded: false,
    rises: false,
  };
  current.lift?.classList.add("held");
  emit();
}

/** Opens the head out over the whole menu, or folds it back; with `rises`, the head grows as it scrolls. */
export function setMenuExpanded(on: boolean, rises = false): void {
  if (!current || (current.expanded === on && current.rises === (on && rises))) return;
  current = { ...current, expanded: on, rises: on && rises };
  emit();
}

export function closeMenu(): void {
  current?.lift?.classList.remove("held");
  current = null;
  emit();
}

function useMenuState(): MenuState | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
  );
}

/** Whether the menu open now is the card under a held message (HoldMenu), as MenuHost picks it, for a head laid out its own way there. */
export function useHeldMenu(): boolean {
  const menu = useMenuState();
  const wide = useWide();
  return !!menu?.lift && !(wide && menu.at);
}

function pick(item: MenuItem): void {
  if (!item.toggle) closeMenu();
  item.onSelect();
}

/** What sits at an item's right edge: its switch, the check of a choice made, or the air mark. */
function Trailing({ item }: { item: MenuItem }) {
  if (item.toggle) return <span className={["switch", item.checked ? "on" : ""].join(" ")} aria-hidden="true" />;
  if (item.checked) return <CheckIcon size={18} className="menu-check" />;
  return item.air ? <AirMark /> : null;
}

/** The items cut where a group starts, each piece with where it began. */
function groups(items: MenuItem[]): { at: number; items: MenuItem[] }[] {
  const out: { at: number; items: MenuItem[] }[] = [];
  items.forEach((item, i) => {
    if (item.group || out.length === 0) out.push({ at: i, items: [] });
    out.at(-1)!.items.push(item);
  });
  return out;
}

export function MenuHost() {
  const menu = useMenuState();
  const wide = useWide();
  if (menu && wide && menu.at) return <Popover menu={menu} />;
  if (menu?.lift) return <HoldMenu menu={menu} lift={menu.lift} />;
  // Mounted while closed too, so the sheet can slide away with the menu it held.
  return (
    <Sheet open={menu !== null} onClose={closeMenu} title={menu?.title}>
      {menu?.head ? <div className="menu-head">{menu.head}</div> : null}
      {groups(menu?.expanded ? [] : (menu?.items ?? [])).map((g) => (
        <div key={g.at} className="group-body">
          {g.items.map((item, i) => (
            // By place: two nodes of one name make two items of one label.
            <button
              key={g.at + i}
              type="button"
              className={["line", item.toggle ? "line-switch" : item.checked === undefined ? "line-action" : "", item.danger ? "danger" : ""].join(" ")}
              role={item.toggle ? "switch" : undefined}
              aria-checked={item.toggle ? !!item.checked : undefined}
              aria-current={!item.toggle && item.checked ? "true" : undefined}
              disabled={item.disabled}
              onClick={() => pick(item)}
            >
              {item.icon ? <span className="line-icon">{item.icon}</span> : null}
              <span className="line-text">
                <span>{item.label}</span>
                {item.hint ? <small>{item.hint}</small> : null}
              </span>
              <Trailing item={item} />
            </button>
          ))}
        </div>
      ))}
    </Sheet>
  );
}

function Popover({ menu }: { menu: MenuState }) {
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: menu.at!.x, top: menu.at!.y });

  // Kept inside the window: flipped left or up when it would run off, and again as it grows, as every emoji does.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const place = () => {
      const { width, height } = el.getBoundingClientRect();
      setPos({
        left: menu.at!.x + width > window.innerWidth - 8 ? Math.max(8, menu.at!.x - width) : menu.at!.x,
        top: menu.at!.y + height > window.innerHeight - 8 ? Math.max(8, menu.at!.y - height) : menu.at!.y,
      });
    };
    place();
    const sizes = new ResizeObserver(place);
    sizes.observe(el);
    return () => sizes.disconnect();
  }, [menu]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      closeMenu();
    };
    const onDown = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) closeMenu();
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("blur", closeMenu);
    box.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus({ preventScroll: true });
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("blur", closeMenu);
    };
  }, []);

  return createPortal(
    <div ref={box} className={["popover", menu.hints ? "with-hints" : "", menu.expanded ? "expanded" : ""].join(" ")} role="menu" style={{ ...pos, minWidth: menu.minWidth }}>
      {menu.head ? (
        <>
          <div className="menu-head">{menu.head}</div>
          {menu.expanded ? null : <div className="popover-sep" role="separator" />}
        </>
      ) : null}
      {(menu.expanded ? [] : menu.items).map((item, i) => (
        <Fragment key={i}>
          {item.group && i > 0 ? <div className="popover-sep" role="separator" /> : null}
          <button
            type="button"
            role={item.toggle ? "menuitemcheckbox" : item.checked === undefined ? "menuitem" : "menuitemradio"}
            aria-checked={item.checked === undefined && !item.toggle ? undefined : !!item.checked}
            className={item.danger ? "danger" : ""}
            disabled={item.disabled}
            onClick={() => pick(item)}
          >
            {item.icon ? <span className="popover-icon">{item.icon}</span> : null}
            <span className="popover-label">
              {item.label}
              {menu.hints && item.hint ? <small>{item.hint}</small> : null}
            </span>
            {item.shortcut ? <kbd className="popover-keys">{item.shortcut}</kbd> : null}
            <Trailing item={item} />
          </button>
        </Fragment>
      ))}
    </div>,
    document.body,
  );
}

/** Room kept between the message held and its menu, and from the screen's top and foot, px. */
const HOLD_GAP = 8;
const HOLD_EDGE = 12;

/** Sets a style only when it changes: each write has the browser look the page over again. */
function put(el: HTMLElement, name: string, value: string): void {
  if (el.style.getPropertyValue(name) !== value) el.style.setProperty(name, value);
}

/**
 * A held message's menu on a touch screen, as Telegram lays it out: the
 * message stays bright over the dimmed screen, risen a little, with its menu
 * right under it. Held near the foot of the screen, the message moves up to
 * make room, so the menu never covers it.
 *
 * A head that grows as it scrolls, as every emoji does, marks its scroller
 * with `data-rise`, the height it opens at. The card is then only a frame from
 * under the message risen as high as it goes, and the scroller has a room as
 * tall as that rise above the head: pulled up, the head lifts the message with
 * it until the message reaches the top of its list, and then the frame
 * reaches down to the screen's foot. The browser's own scrolling, fling and
 * all, moves the head, and the message and the frame follow it frame by frame.
 */
function HoldMenu({ menu, lift }: { menu: MenuState; lift: HTMLElement }) {
  const card = useRef<HTMLDivElement>(null);
  const hole = useRef<HTMLDivElement>(null);
  // Which side the menu lines up with, the message's own, once it is placed. Where exactly is written straight
  // to the page on every frame below: through React it would land a frame behind the message.
  const [side, setSide] = useState<"left" | "right" | null>(null);
  // The keyboard's height on an iPhone, while the menu's own field has it up (keyboard.ts).
  const keyboard = useRef(0);
  // The press that opened the menu ends over it, on the scrim or, with the message risen, on an item under the
  // finger. Only a press that began over the menu counts: a tap past it, or on an item (a key's click has no detail).
  const pressed = useRef(false);
  const fresh = (e: { detail: number }) => pressed.current || e.detail === 0;
  useBackLayer(true, closeMenu);

  useLayoutEffect(() => {
    pressed.current = false;
    // The keyboard goes down, as for a sheet; the chat moves under the message as it does, and the menu follows.
    if (document.activeElement instanceof HTMLElement && document.activeElement.closest("input, textarea")) document.activeElement.blur();
    const radius = (parseFloat(getComputedStyle(lift).borderTopLeftRadius) || 16) + 1;
    // The home bar's strip at the foot, which the menu keeps clear of.
    const probe = document.createElement("div");
    probe.style.cssText = "position:fixed;visibility:hidden;height:var(--home-bar,0px)";
    document.body.append(probe);
    const foot = probe.offsetHeight;
    probe.remove();
    // The list the message scrolls in, under the chat's head, which the message rises no higher than.
    let view = lift.parentElement;
    while (view && !/auto|scroll/.test(getComputedStyle(view).overflowY)) view = view.parentElement;
    let placed: "left" | "right" | null = null;
    let lastScrolled = 0;
    let pulled = false;
    let frame = 0;
    const stopKeyboard = card.current ? moveForKeyboard(card.current, (height) => (keyboard.current = height)) : () => undefined;
    const follow = () => {
      const el = card.current;
      if (lift.isConnected && el) {
        const box = lift.getBoundingClientRect();
        // Where the message stands in the chat, without the rise this menu gives it.
        const shift = new DOMMatrixReadOnly(getComputedStyle(lift).transform === "none" ? undefined : getComputedStyle(lift).transform);
        const height = box.height / (shift.d || 1);
        const top = box.top + box.height / 2 - shift.f - height / 2;
        const bottom = window.innerHeight - keyboard.current - foot - HOLD_EDGE;
        // Up as far as the menu needs, but not so far that the top of a tall message leaves the list.
        const most = Math.max(0, top - Math.max(HOLD_EDGE, (view?.getBoundingClientRect().top ?? 0) + HOLD_GAP));
        const riser = el.querySelector<HTMLElement>("[data-rise]");
        const scrolled = riser ? Math.max(0, riser.scrollTop) : 0;
        let rise: number;
        let at: number;
        if (riser) {
          // The frame's top, under the message risen as high as it goes; under a message too tall for the
          // screen, the head still gets some room.
          const highest = Math.min(top - most + height + HOLD_GAP, bottom - 160);
          const low = Math.min(Number(riser.dataset["rise"]), bottom - highest);
          // Where the head opens: right under the message, or as low as it fits with the message risen for it.
          const open = Math.max(highest, Math.min(top + height + HOLD_GAP, bottom - low));
          const gap = Math.round(open - highest);
          put(el, "--hold-gap", `${gap}px`);
          put(riser, "height", `${Math.round(Math.min(bottom, open + low + Math.max(0, scrolled - gap)) - highest)}px`);
          rise = Math.min(most, top + height + HOLD_GAP - open + Math.min(scrolled, gap));
          at = highest;
        } else {
          const room = bottom - (top + height + HOLD_GAP + el.offsetHeight);
          rise = room >= 0 ? 0 : Math.min(-room, most);
          at = Math.min(top - rise + height + HOLD_GAP, bottom - el.offsetHeight);
        }
        // Pulled by the scrolling, the message keeps to the head at once: eased, it would trail behind it.
        const pull = riser !== null && scrolled !== lastScrolled;
        lastScrolled = scrolled;
        if (pull !== pulled) {
          pulled = pull;
          lift.style.setProperty("transition", pull ? "none" : "");
        }
        put(lift, "--lift-y", `${-rise}px`);
        const right = box.left + box.width / 2 > window.innerWidth / 2;
        const width = el.offsetWidth;
        put(el, "left", `${Math.round(Math.min(window.innerWidth - width - HOLD_GAP, Math.max(HOLD_GAP, right ? box.right - width : box.left)))}px`);
        put(el, "top", `${Math.round(at)}px`);
        // The message as it is on screen with the rise just given, left bright in the dimming.
        const lit = lift.getBoundingClientRect();
        if (hole.current) {
          put(hole.current, "left", `${Math.floor(lit.left) - 1}px`);
          put(hole.current, "top", `${Math.floor(lit.top) - 1}px`);
          put(hole.current, "width", `${Math.ceil(lit.width) + 2}px`);
          put(hole.current, "height", `${Math.ceil(lit.height) + 2}px`);
          put(hole.current, "border-radius", `${radius}px`);
        }
        if (placed !== (right ? "right" : "left")) {
          placed = right ? "right" : "left";
          setSide(placed);
        }
      }
      frame = requestAnimationFrame(follow);
    };
    follow();
    return () => {
      cancelAnimationFrame(frame);
      stopKeyboard();
      lift.style.removeProperty("--lift-y");
      lift.style.removeProperty("transition");
    };
  }, [lift]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      closeMenu();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  return createPortal(
    <div className="hold-layer" onPointerDownCapture={() => (pressed.current = true)}>
      <div
        className="hold-scrim"
        onClick={(e) => {
          if (fresh(e)) closeMenu();
        }}
      >
        <div ref={hole} className="hold-hole" hidden={side === null} />
      </div>
      <div
        ref={card}
        className={["hold-menu", side ? "" : "unplaced", side === "right" ? "right" : "", menu.expanded ? "expanded" : "", menu.expanded && menu.rises ? "rising" : ""].join(" ")}
        role="menu"
      >
        {menu.head ? (
          <>
            <div
              className="menu-head"
              onClickCapture={(e) => {
                // The release of the hold that opened the menu is no choice.
                if (fresh(e)) return;
                e.stopPropagation();
                e.preventDefault();
              }}
            >
              {menu.head}
            </div>
            {menu.expanded ? null : <div className="hold-menu-sep" role="separator" />}
          </>
        ) : null}
        {(menu.expanded ? [] : menu.items).map((item, i) => (
          <Fragment key={i}>
            {item.group && i > 0 ? <div className="hold-menu-sep" role="separator" /> : null}
            <button
              type="button"
              role={item.toggle ? "menuitemcheckbox" : item.checked === undefined ? "menuitem" : "menuitemradio"}
              aria-checked={item.checked === undefined && !item.toggle ? undefined : !!item.checked}
              className={item.danger ? "danger" : ""}
              disabled={item.disabled}
              onClick={(e) => {
                if (fresh(e)) pick(item);
              }}
            >
              {item.icon ? <span className="hold-menu-icon">{item.icon}</span> : null}
              <span className="hold-menu-text">
                <span>{item.label}</span>
                {item.hint ? <small>{item.hint}</small> : null}
              </span>
              <Trailing item={item} />
            </button>
          </Fragment>
        ))}
      </div>
    </div>,
    document.body,
  );
}

/** Sheets on screen, not the one going away. */
const SHEETS = ".sheet-layer:not(.leaving) > .sheet";

/** Where the toast goes over what is on the screen now; see `toastSpot`. */
function spotFor(toast: HTMLElement | null): ToastSpot | null {
  const tops = (selector: string, low = false) => {
    const rects = [...document.querySelectorAll<HTMLElement>(selector)].map((el) => el.getBoundingClientRect());
    const shown = rects.filter((r) => r.height > 0 && (!low || r.bottom > window.innerHeight - 160));
    return shown.length > 0 ? Math.min(...shown.map((r) => r.top)) : null;
  };
  return toastSpot({ height: window.innerHeight, toast: toast?.offsetHeight ?? 0, sheetTop: tops(SHEETS), fieldTop: tops(".compose, .composer", true) });
}

/** Seconds left for the action, and a ring that runs out with them. */
function Countdown({ ms }: { ms: number }) {
  const [left, setLeft] = useState(Math.ceil(ms / 1000));
  useEffect(() => {
    const end = Date.now() + ms;
    const tick = setInterval(() => setLeft(Math.max(0, Math.ceil((end - Date.now()) / 1000))), 250);
    return () => clearInterval(tick);
  }, [ms]);
  return (
    <svg className="toast-ring" viewBox="0 0 20 20" aria-hidden="true">
      <circle cx="10" cy="10" r="8" className="toast-ring-track" />
      <circle cx="10" cy="10" r="8" className="toast-ring-run" style={{ animationDuration: `${ms}ms` }} transform="rotate(-90 10 10)" />
      <text x="10" y="13.5" textAnchor="middle">
        {left}
      </text>
    </svg>
  );
}

export function ToastHost() {
  const toast = useToast();
  const [spot, setSpot] = useState<ToastSpot | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const start = useRef<number | null>(null);
  // A sheet that opens, closes, slides in or changes its height under the toast moves it.
  useLayoutEffect(() => {
    if (!toast) return;
    const place = () => setSpot(spotFor(box.current));
    const sizes = new ResizeObserver(place);
    const watch = () => {
      sizes.disconnect();
      for (const sheet of document.querySelectorAll<HTMLElement>(SHEETS)) sizes.observe(sheet);
      place();
    };
    const layers = new MutationObserver(watch);
    layers.observe(document.body, { childList: true });
    watch();
    window.addEventListener("resize", place);
    document.addEventListener("animationend", place);
    return () => {
      sizes.disconnect();
      layers.disconnect();
      window.removeEventListener("resize", place);
      document.removeEventListener("animationend", place);
    };
  }, [toast]);
  if (!toast) return null;
  // A short note with nothing more to it hugs its text; the rest take the width.
  const short = !toast.action && !toast.detail && toast.tone !== "error";
  const icon = toast.tone === "error" ? "!" : toast.action ? "✓" : null;
  return createPortal(
    <div
      ref={box}
      key={toast.id}
      className={["toast", toast.tone, short ? "short" : "", spot === "top" ? "top" : ""].join(" ")}
      role="status"
      style={spot && spot !== "top" ? { bottom: spot.bottom } : undefined}
      // A tap puts it away, and so does a pull down.
      onClick={dismissToast}
      onPointerDown={(e) => (start.current = e.clientY)}
      onPointerMove={(e) => {
        if (start.current !== null && e.clientY - start.current > 24) {
          start.current = null;
          dismissToast();
        }
      }}
      onPointerUp={() => (start.current = null)}
      onPointerCancel={() => (start.current = null)}
    >
      {icon ? (
        <span className="toast-icon" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <span className="toast-text">
        <span className="toast-main">{toast.text}</span>
        {toast.detail ? <span className="toast-detail">{toast.detail}</span> : null}
      </span>
      {toast.action ? (
        <button
          type="button"
          className="toast-action"
          onClick={(e) => {
            // The action may say what it did in a toast of its own, which the tap must not put away.
            e.stopPropagation();
            const run = toast.action!.run;
            dismissToast();
            run();
          }}
        >
          {toast.action.label}
          <Countdown ms={toast.ms} />
        </button>
      ) : null}
    </div>,
    document.body,
  );
}
