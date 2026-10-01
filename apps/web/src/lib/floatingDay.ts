/**
 * The date over a chat while it is scrolled, as in Telegram: the day of what
 * is at the top of the list floats there, and the next day's line, coming up
 * under it, pushes it off. It shows only while the reader scrolls the list
 * themselves and fades a little after they stop; the app's own scrolling
 * (opening at the latest, a message coming in, the keyboard, a jump) does not
 * bring it up.
 */

import { useCallback, useEffect, useRef, type RefObject } from "react";

/** Where the floating date goes. */
export interface DayPlace {
  /** Which of the list's date lines it repeats: the last one gone above its place. */
  at: number;
  /** How far up the next day's line pushes it, px, zero or less. */
  shift: number;
  /** That line is still partly in sight under it, so it is hidden rather than drawn twice. */
  covers: boolean;
}

/** Room kept between the floating date and the next day's line pushing it, px. */
const GAP = 4;
/** A line this close below the floating date's place counts as there, px: a day jumped to lands on a rounded scroll position. */
const SLACK = 1;

/**
 * From the tops of the list's date lines, in order, and the top and height of
 * the floating date's place, all on one axis. Null where no line has gone above
 * that place yet: at the head of the list, the first day's own line is in sight.
 */
export function placeDay(tops: readonly number[], line: number, height: number): DayPlace | null {
  let at = -1;
  for (let i = tops.length - 1; i >= 0; i--) {
    if (tops[i]! <= line + SLACK) {
      at = i;
      break;
    }
  }
  if (at < 0) return null;
  const next = tops[at + 1];
  return {
    at,
    shift: next === undefined ? 0 : Math.min(0, next - (line + height + GAP)),
    covers: tops[at]! > line - height,
  };
}

/** How long the date stays after the scrolling stops, ms. */
const LINGER = 1200;
/** Scroll events closer than this are one movement, as a fling runs on after the finger lifts, ms. */
const RUN = 120;
/** A wheel turn or a key moves the list for a little while after it, ms. */
const AFTER_INPUT = 250;

/**
 * The floating date of a chat's list: `pill` is the date itself, in a box of
 * its own right under the head that cuts it off where the next day pushes it
 * up. `day` is the id of the message whose date line it repeats, `restAt` the
 * top of its place on screen, where a day jumped to is brought.
 */
export function useFloatingDay(scroller: RefObject<HTMLElement | null>) {
  const pill = useRef<HTMLButtonElement>(null);
  const day = useRef<string | null>(null);

  const restAt = useCallback(() => {
    const date = pill.current;
    const box = date?.parentElement;
    return box ? box.getBoundingClientRect().top + date.offsetTop : 0;
  }, []);

  useEffect(() => {
    const el = scroller.current;
    const date = pill.current;
    const box = date?.parentElement;
    if (!el || !date || !box) return;
    let touching = false;
    let input = 0;
    let run = 0;
    let awake = false;
    let timer = 0;
    let covered: HTMLElement | null = null;

    const uncover = () => {
      covered?.classList.remove("under");
      covered = null;
    };
    const hide = () => {
      box.classList.remove("on");
      uncover();
    };
    const place = () => {
      const lines = [...el.querySelectorAll<HTMLElement>(".day")];
      const line = restAt();
      const at = placeDay(
        lines.map((l) => l.getBoundingClientRect().top),
        line,
        date.offsetHeight,
      );
      uncover();
      if (!at) {
        day.current = null;
        hide();
        return;
      }
      const own = lines[at.at]!;
      if (date.textContent !== own.textContent) date.textContent = own.textContent;
      day.current = own.parentElement?.dataset.id ?? null;
      date.style.transform = at.shift ? `translateY(${at.shift}px)` : "";
      box.classList.add("on");
      if (at.covers) {
        own.classList.add("under");
        covered = own;
      }
    };

    const onScroll = () => {
      const now = performance.now();
      if (touching || now - input < AFTER_INPUT || now - run < RUN) {
        run = now;
        awake = true;
        clearTimeout(timer);
        timer = window.setTimeout(() => {
          awake = false;
          hide();
        }, LINGER);
      }
      if (awake) place();
    };
    const down = () => {
      touching = true;
    };
    const up = () => {
      touching = false;
    };
    const turned = () => {
      input = performance.now();
    };
    // Tapped, it goes at once: the list of days covers it, and the jump to one is the app's own scrolling.
    const tapped = () => {
      clearTimeout(timer);
      awake = false;
      hide();
    };
    // A mouse on the list's scroll bar; a finger is followed by its touches, as a pan cancels its pointer.
    const pressed = (e: PointerEvent) => {
      if (e.pointerType === "mouse") touching = true;
    };

    el.addEventListener("scroll", onScroll, { passive: true });
    el.addEventListener("touchstart", down, { passive: true });
    el.addEventListener("touchend", up);
    el.addEventListener("touchcancel", up);
    el.addEventListener("pointerdown", pressed);
    window.addEventListener("pointerup", up);
    el.addEventListener("wheel", turned, { passive: true });
    el.addEventListener("keydown", turned);
    date.addEventListener("click", tapped);
    return () => {
      clearTimeout(timer);
      uncover();
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("touchstart", down);
      el.removeEventListener("touchend", up);
      el.removeEventListener("touchcancel", up);
      el.removeEventListener("pointerdown", pressed);
      window.removeEventListener("pointerup", up);
      el.removeEventListener("wheel", turned);
      el.removeEventListener("keydown", turned);
      date.removeEventListener("click", tapped);
    };
  }, [scroller, restAt]);

  return { pill, day, restAt };
}
