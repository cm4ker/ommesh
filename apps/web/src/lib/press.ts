/**
 * A long press on a touch screen and a right click with a mouse both ask for
 * the same thing: the menu of what else can be done with a row or a message.
 * The press is timed here; Android also sends a context menu for it, which
 * is folded into the same one call.
 */

import { useRef, type MouseEvent, type PointerEvent } from "react";
import { haptic } from "./haptic.js";

export type MenuAt = { x: number; y: number } | null;

const HOLD_MS = 480;
const SLOP_PX = 8;

export function usePress(onMenu: (at: MenuAt) => void) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const fired = useRef(false);
  const clear = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  };
  return {
    onPointerDown: (e: PointerEvent) => {
      fired.current = false;
      if (e.pointerType === "mouse") return;
      start.current = { x: e.clientX, y: e.clientY };
      clear();
      timer.current = setTimeout(() => {
        timer.current = null;
        fired.current = true;
        haptic();
        onMenu(null);
      }, HOLD_MS);
    },
    onPointerMove: (e: PointerEvent) => {
      if (start.current && Math.hypot(e.clientX - start.current.x, e.clientY - start.current.y) > SLOP_PX) clear();
    },
    onPointerUp: clear,
    onPointerCancel: clear,
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
