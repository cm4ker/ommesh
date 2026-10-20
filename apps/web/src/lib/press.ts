/**
 * A long press on a touch screen and a right click with a mouse both ask for
 * the same thing: the menu of what else can be done with a row or a message.
 * The press is timed here; Android also sends a context menu for it, which
 * is folded into the same one call. A control that is held on purpose, as the
 * message field's pin is, times a held mouse button too.
 */

import { useRef, type MouseEvent, type PointerEvent } from "react";
import { haptic } from "./haptic.js";

export type MenuAt = { x: number; y: number } | null;

const HOLD_MS = 480;
const SLOP_PX = 8;

/**
 * `onHolding` hears when a finger starts to hold and when it lets go, moves
 * off or holds long enough, for a mark that fills while it holds. With
 * `mouse`, the left mouse button held is timed as a finger is.
 */
export function usePress(onMenu: (at: MenuAt) => void, onHolding?: (holding: boolean) => void, options: { mouse?: boolean } = {}) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const fired = useRef(false);
  const clear = () => {
    if (timer.current === null) return;
    clearTimeout(timer.current);
    timer.current = null;
    onHolding?.(false);
  };
  return {
    onPointerDown: (e: PointerEvent) => {
      fired.current = false;
      const mouse = e.pointerType === "mouse";
      if (mouse && !(options.mouse && e.button === 0)) return;
      const at = { x: e.clientX, y: e.clientY };
      start.current = at;
      clear();
      timer.current = setTimeout(() => {
        timer.current = null;
        fired.current = true;
        onHolding?.(false);
        haptic();
        onMenu(mouse ? at : null);
      }, HOLD_MS);
      onHolding?.(true);
    },
    onPointerMove: (e: PointerEvent) => {
      if (start.current && Math.hypot(e.clientX - start.current.x, e.clientY - start.current.y) > SLOP_PX) clear();
    },
    onPointerUp: clear,
    onPointerCancel: clear,
    // A mouse let go off the control is not caught as a finger is.
    onPointerLeave: clear,
    onContextMenu: (e: MouseEvent) => {
      e.preventDefault();
      clear();
      if (fired.current) return;
      fired.current = true;
      const touch = (e.nativeEvent as unknown as { pointerType?: string }).pointerType === "touch";
      onMenu(touch ? null : { x: e.clientX, y: e.clientY });
    },
    // The click that ends a long press is not a tap.
    onClickCapture: (e: MouseEvent) => {
      if (!fired.current) return;
      fired.current = false;
      e.preventDefault();
      e.stopPropagation();
    },
  };
}
