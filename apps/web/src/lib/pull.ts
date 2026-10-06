/**
 * Pull down from the top of a scrolling list to run something, or up from its
 * foot. Only a touch that starts with the list at that end and moves away from
 * it more than across is taken; the rest scrolls as ever.
 */

import { useEffect, useRef, useState, type RefObject } from "react";

/** How far the finger goes, in px, for the list to move one. */
const RESIST = 0.5;
/** How far the list must come down to run on release. */
export const PULL_TRIGGER = 64;
const PULL_MAX = 96;

export interface PullOptions {
  /** The end the pull starts from: the top, pulled down, or the foot, pulled up. */
  edge?: "top" | "bottom";
  /** How far the list must move to run on release. */
  trigger?: number;
  max?: number;
}

export function usePull(ref: RefObject<HTMLElement | null>, onPull: () => void, enabled: boolean, { edge = "top", trigger = PULL_TRIGGER, max = PULL_MAX }: PullOptions = {}): number {
  const [pull, setPull] = useState(0);
  // Held by a ref, so a new handler drawn mid-pull does not drop the pull under the finger.
  const act = useRef(onPull);
  act.current = onPull;
  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return;
    let start: { x: number; y: number } | null = null;
    let pulling = false;
    let distance = 0;
    const atEdge = () => (edge === "top" ? el.scrollTop <= 0 : el.scrollHeight - el.scrollTop - el.clientHeight < 2);
    const down = (e: TouchEvent) => {
      const t = e.touches[0];
      start = e.touches.length === 1 && t && atEdge() ? { x: t.clientX, y: t.clientY } : null;
      pulling = false;
    };
    const move = (e: TouchEvent) => {
      const t = e.touches[0];
      if (!start || !t) return;
      const dy = edge === "top" ? t.clientY - start.y : start.y - t.clientY;
      if (!pulling) {
        if (Math.abs(dy) < 8 && Math.abs(t.clientX - start.x) < 8) return;
        if (dy <= 0 || Math.abs(t.clientX - start.x) > dy) {
          start = null;
          return;
        }
        pulling = true;
      }
      // Held here, so the page does not bounce under the pull as well.
      e.preventDefault();
      distance = Math.min(max, Math.max(0, dy * RESIST));
      setPull(distance);
    };
    const up = () => {
      if (pulling && distance >= trigger) act.current();
      start = null;
      pulling = false;
      distance = 0;
      setPull(0);
    };
    el.addEventListener("touchstart", down, { passive: true });
    el.addEventListener("touchmove", move, { passive: false });
    el.addEventListener("touchend", up);
    el.addEventListener("touchcancel", up);
    return () => {
      el.removeEventListener("touchstart", down);
      el.removeEventListener("touchmove", move);
      el.removeEventListener("touchend", up);
      el.removeEventListener("touchcancel", up);
      setPull(0);
    };
  }, [ref, enabled, edge, trigger, max]);
  return pull;
}
