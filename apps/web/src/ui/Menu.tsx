/**
 * What else can be done with a row or a message: one menu, asked for by a
 * long press, a right click or a "More" button. With a mouse it opens where
 * the click was; on a phone it is a sheet of rows.
 */

import { Fragment, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { CheckIcon } from "../components/Icons.js";
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
}

interface MenuState {
  items: MenuItem[];
  title?: string | undefined;
  at: MenuAt;
}

let current: MenuState | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function showMenu(items: MenuItem[], options: { title?: string | undefined; at?: MenuAt } = {}): void {
  current = { items: items.filter(Boolean), title: options.title, at: options.at ?? null };
  emit();
}

export function closeMenu(): void {
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
  // Mounted while closed too, so the sheet can slide away with the menu it held.
  return (
    <Sheet open={menu !== null} onClose={closeMenu} title={menu?.title}>
      {groups(menu?.items ?? []).map((g) => (
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

  // Kept inside the window: flipped left or up when it would run off.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    setPos({
      left: menu.at!.x + width > window.innerWidth - 8 ? Math.max(8, menu.at!.x - width) : menu.at!.x,
      top: menu.at!.y + height > window.innerHeight - 8 ? Math.max(8, menu.at!.y - height) : menu.at!.y,
    });
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
    <div ref={box} className="popover" role="menu" style={pos}>
      {menu.items.map((item, i) => (
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
            <span className="popover-label">{item.label}</span>
            <Trailing item={item} />
          </button>
        </Fragment>
      ))}
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
