import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/** How much of the screen the sheet takes when it opens; pulled up, it takes all but the notch. */
export const PULL_HALF = 0.56;
/** Flung faster than this many pixels a millisecond, the sheet goes on to the next height that way. */
const FLICK = 0.4;
/** Pulled down this far below half, or a quarter of the way down if that is less, it closes when let go. */
const CLOSE_PULL = 110;
/** Pulled up past its top, it gives this much of the pull and no more. */
const OVERPULL = 0.2;
/** A touch this close to the left edge swipes the sheet away sideways, back to where it was opened from, as on iOS. */
const EDGE = 24;
const SWIPE_MS = 180;

export type Detent = "half" | "full";

function reducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * How far up a half-open sheet over the map reaches from the bottom of the
 * map's box, which ends at `bottom` where the sheet does, on the tabs, for
 * the map to keep what it shows clear of it.
 */
export function pullSheetCover(bottom: number): number {
  return Math.round(bottom * PULL_HALF);
}

/**
 * A sheet that opens over half of a phone's screen and is pulled up to take
 * nearly all of it, as Maps and Telegram do: by its handle, or by its content
 * while that is at its top. Pulled or flung down from half, or tapped past, it
 * closes. `seeThrough` leaves what lies above it live, a map to pan and pick
 * on, rather than dimmed; `backdrop` brings such a map of its own, which comes
 * and goes with the sheet. It slides away when closed, with what it last held.
 * `initial` is the height it opens at.
 */
export function PullSheet({ open, onClose, children, label, seeThrough = false, backdrop, initial = "half", id, covered = false }: { open: boolean; onClose: () => void; children: ReactNode; label?: string | undefined; seeThrough?: boolean | undefined; backdrop?: ReactNode; initial?: Detent | undefined; id?: string | undefined; covered?: boolean | undefined }) {
  const layer = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const scrim = useRef<HTMLDivElement>(null);
  const edge = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;

  const [present, setPresent] = useState(open);
  const kept = useRef<{ children: ReactNode; seeThrough: boolean; backdrop: ReactNode }>({ children, seeThrough, backdrop });
  if (open) kept.current = { children, seeThrough, backdrop };
  if (open && !present) setPresent(true);
  const leaving = !open && present;
  const shown = open ? { children, seeThrough, backdrop } : kept.current;

  // The layer's height, and the sheet's when pulled all the way up.
  const [space, setSpace] = useState({ height: 0, full: 0 });
  const [detent, setDetent] = useState<Detent>("half");
  // Opened afresh, it starts at half. Closed because a page went over it (`covered`), it comes back as high as it
  // was when that page is left. A new node in an open sheet stays where the sheet is, scrolled to the top.
  const resume = useRef<{ id: string | undefined; detent: Detent } | null>(null);
  const shownId = useRef(id);
  if (open) shownId.current = id;
  useEffect(() => {
    if (!open) resume.current = covered ? { id: shownId.current, detent: live.current.at } : null;
    // Only the moment it closes counts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  useLayoutEffect(() => {
    if (!open) return;
    setDetent(resume.current && resume.current.id === id ? resume.current.detent : initial);
    resume.current = null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  useEffect(() => {
    if (body.current) body.current.scrollTop = 0;
  }, [id]);

  useLayoutEffect(() => {
    if (!present) return;
    const outer = layer.current;
    const sheet = box.current;
    if (!outer || !sheet) return;
    const measure = () => {
      const next = { height: outer.clientHeight, full: sheet.offsetHeight };
      setSpace((s) => (s.height === next.height && s.full === next.full ? s : next));
    };
    const resize = new ResizeObserver(measure);
    resize.observe(outer);
    measure();
    return () => resize.disconnect();
  }, [present]);

  // All the way up it covers nearly the whole screen, however little it holds.
  const heights: Record<Detent, number> = { half: Math.min(space.full, Math.round(space.height * PULL_HALF)), full: space.full };
  const at = detent;

  const live = useRef({ heights, at, full: space.full, setDetent });
  live.current = { heights, at, full: space.full, setDetent };

  const place = (h: number) => {
    const el = box.current;
    if (!el) return;
    el.style.transform = `translate3d(0, ${live.current.full - h}px, 0)`;
    // Pulled down below half, the dimming goes as the sheet does.
    if (scrim.current) scrim.current.style.opacity = String(Math.max(0, Math.min(1, h / Math.max(1, live.current.heights.half))));
  };

  // Comes up from below the screen's edge once measured, and goes back down there when closed.
  const entered = useRef(false);
  const dragging = useRef(false);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el || !space.full) return;
    if (leaving) {
      el.style.transition = "";
      el.style.transform = `translate3d(0, ${space.full + 24}px, 0)`;
      if (scrim.current) scrim.current.style.opacity = "0";
      if (reducedMotion()) setPresent(false);
      return;
    }
    if (!entered.current) {
      entered.current = true;
      if (!reducedMotion()) {
        el.style.transition = "none";
        el.style.transform = `translate3d(0, ${space.full + 24}px, 0)`;
        if (scrim.current) scrim.current.style.opacity = "0";
        el.getBoundingClientRect();
        el.style.transition = "";
      }
    }
    if (!dragging.current) place(heights[at]);
  });
  useEffect(() => {
    if (!present) entered.current = false;
  }, [present]);
  // Gone once it has slid away; a little after, should the slide's end not be told.
  useEffect(() => {
    if (!leaving) return;
    const timer = setTimeout(() => setPresent(false), 420);
    return () => clearTimeout(timer);
  }, [leaving]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || document.querySelector("dialog[open], .sheet-layer")) return;
      e.preventDefault();
      close.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const motion = useMemo(() => {
    let drag: { from: number; h: number; now: number; moved: boolean; trail: { y: number; t: number }[] } | null = null;
    const begin = (y: number) => {
      const el = box.current;
      if (!el) return;
      const { heights, at, full } = live.current;
      // Caught while it is still settling, it is taken from where it is.
      const shift = new DOMMatrixReadOnly(getComputedStyle(el).transform).m42;
      const h = Number.isFinite(shift) ? full - shift : heights[at];
      drag = { from: y, h, now: h, moved: false, trail: [{ y, t: performance.now() }] };
      dragging.current = true;
      el.style.transition = "none";
      if (scrim.current) scrim.current.style.transition = "none";
      place(h);
    };
    const follow = (y: number) => {
      if (!drag) return;
      const { heights } = live.current;
      const t = performance.now();
      drag.trail.push({ y, t });
      while (drag.trail.length > 2 && t - drag.trail[0]!.t > 100) drag.trail.shift();
      if (Math.abs(y - drag.from) > 4) drag.moved = true;
      let h = drag.h - (y - drag.from);
      if (h > heights.full) h = heights.full + (h - heights.full) * OVERPULL;
      drag.now = Math.max(0, h);
      place(drag.now);
    };
    /** Lets go at the height it was flung towards, or else the nearest; a tap on the handle steps between the two. */
    const release = (tap: boolean) => {
      const d = drag;
      const el = box.current;
      drag = null;
      dragging.current = false;
      if (!d || !el) return;
      const { heights, at, setDetent } = live.current;
      el.style.transition = "";
      if (scrim.current) scrim.current.style.transition = "";
      let target: Detent | "closed" = at;
      if (!d.moved) {
        if (tap && heights.full > heights.half) target = at === "half" ? "full" : "half";
      } else {
        const first = d.trail[0]!;
        const last = d.trail.at(-1)!;
        // A finger that stopped before it lifted flings nothing.
        const v = performance.now() - last.t < 80 && last.t > first.t ? (last.y - first.y) / (last.t - first.t) : 0;
        if (v < -FLICK) target = d.now < heights.half - 2 ? "half" : "full";
        else if (v > FLICK) target = d.now > heights.half + 2 ? "half" : "closed";
        else if (d.now < heights.half - Math.min(CLOSE_PULL, heights.half * 0.25)) target = "closed";
        else target = Math.abs(d.now - heights.half) <= Math.abs(d.now - heights.full) ? "half" : "full";
      }
      if (target === "closed") {
        close.current();
        return;
      }
      place(heights[target]);
      setDetent(target);
    };
    return { begin, follow, release };
    // place reads only refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // What it holds pulls it by touch, until it is all the way up; there it scrolls, and pulls down only from its top.
  useEffect(() => {
    const el = body.current;
    if (!el || !present) return;
    let start: { x: number; y: number } | null = null;
    let pulling = false;
    let from = 0;
    let travel = 0;
    const swallow = (e: Event) => {
      e.stopPropagation();
      e.preventDefault();
    };
    const down = (e: TouchEvent) => {
      const t = e.touches[0];
      start = e.touches.length === 1 && t ? { x: t.clientX, y: t.clientY } : null;
      if (e.touches.length > 1 && pulling) {
        pulling = false;
        motion.release(false);
      }
    };
    const move = (e: TouchEvent) => {
      const t = e.touches[0];
      if (!t) return;
      if (start) {
        const dx = t.clientX - start.x;
        const dy = t.clientY - start.y;
        if (!dx && !dy) return;
        from = start.y;
        travel = 0;
        start = null;
        // Decided on the first move, while the page can still be told not to scroll.
        if (Math.abs(dx) > Math.abs(dy)) return;
        if (live.current.at === "full" && (dy < 0 || el.scrollTop > 0)) return;
        pulling = true;
        motion.begin(from);
      }
      if (!pulling) return;
      e.preventDefault();
      travel = Math.max(travel, Math.abs(t.clientY - from));
      motion.follow(t.clientY);
    };
    const up = () => {
      start = null;
      if (!pulling) return;
      pulling = false;
      motion.release(false);
      // A pull that ends over a button does not press it.
      if (travel <= 10) return;
      el.addEventListener("click", swallow, { capture: true, once: true });
      setTimeout(() => el.removeEventListener("click", swallow, { capture: true }), 400);
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
    };
  }, [motion, present]);

  // A mouse pressed on what the sheet holds, until it shows whether it clicks or pulls.
  const mouse = useRef<{ id: number; y: number; pulling: boolean } | null>(null);

  // Focus goes into the sheet, so the keys and a screen reader follow it there.
  useEffect(() => {
    if (open) box.current?.focus({ preventScroll: true });
  }, [open]);

  // A swipe from the left edge takes the sheet, and the map above it, off to the right, uncovering what it was
  // opened from; let go past a third of the way, or flung, it closes. It is heard before what the sheet holds,
  // which then never sees a touch that began at the edge, so the two never pull at once.
  useEffect(() => {
    const outer = layer.current;
    const targets = [box.current, edge.current].filter((el) => el !== null);
    if (!outer || !open) return;
    // Opened again while still sliding away, it comes back into place.
    outer.style.transition = outer.style.transform = "";
    let start: { x: number; y: number } | null = null;
    let active = false;
    let trail: { x: number; t: number }[] = [];
    const down = (e: TouchEvent) => {
      const t = e.touches[0];
      start = t && e.touches.length === 1 && t.clientX < EDGE ? { x: t.clientX, y: t.clientY } : null;
      active = false;
      if (start) e.stopPropagation();
    };
    const move = (e: TouchEvent) => {
      const t = e.touches[0];
      if (!start || !t) return;
      e.stopPropagation();
      const dx = t.clientX - start.x;
      const dy = t.clientY - start.y;
      if (!active) {
        if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
        if (dx < 0 || Math.abs(dy) > Math.abs(dx)) {
          start = null;
          return;
        }
        active = true;
        trail = [];
        outer.style.transition = "none";
      }
      e.preventDefault();
      const now = performance.now();
      trail.push({ x: t.clientX, t: now });
      while (trail.length > 2 && now - trail[0]!.t > 100) trail.shift();
      outer.style.transform = `translate3d(${Math.max(0, dx)}px, 0, 0)`;
    };
    const up = (e: TouchEvent) => {
      const was = start;
      start = null;
      if (!was || !active) return;
      e.stopPropagation();
      active = false;
      const t = e.changedTouches[0];
      const dx = t ? t.clientX - was.x : 0;
      const first = trail[0];
      const last = trail.at(-1);
      const v = first && last && performance.now() - last.t < 80 && last.t > first.t ? (last.x - first.x) / (last.t - first.t) : 0;
      const width = outer.clientWidth || 1;
      const go = dx > width / 3 || (dx > 24 && v > 0.5);
      outer.style.transition = reducedMotion() ? "none" : `transform ${SWIPE_MS}ms ease-out`;
      outer.style.transform = go ? `translate3d(${width}px, 0, 0)` : "";
      if (go) setTimeout(() => close.current(), reducedMotion() ? 0 : SWIPE_MS);
    };
    for (const el of targets) {
      el.addEventListener("touchstart", down, { passive: true, capture: true });
      el.addEventListener("touchmove", move, { passive: false, capture: true });
      el.addEventListener("touchend", up, { capture: true });
      el.addEventListener("touchcancel", up, { capture: true });
    }
    return () => {
      for (const el of targets) {
        el.removeEventListener("touchstart", down, { capture: true });
        el.removeEventListener("touchmove", move, { capture: true });
        el.removeEventListener("touchend", up, { capture: true });
        el.removeEventListener("touchcancel", up, { capture: true });
      }
    };
  }, [open, present]);

  if (!present) return null;

  return createPortal(
    <div ref={layer} className={["pull-layer", shown.seeThrough ? "see-through" : "", leaving ? "leaving" : ""].join(" ")}>
      {shown.backdrop ? <div className="pull-backdrop">{shown.backdrop}</div> : shown.seeThrough ? null : <div ref={scrim} className="pull-scrim" onClick={() => open && close.current()} />}
      {/* Where a swipe back starts above the sheet, rather than in the map, which would pan. */}
      <div ref={edge} className="pull-edge" aria-hidden="true" />
      <div
        ref={box}
        tabIndex={-1}
        className="pull-sheet"
        role="dialog"
        aria-label={label}
        data-detent={at}
        onTransitionEnd={(e) => {
          if (leaving && e.target === e.currentTarget && e.propertyName === "transform") setPresent(false);
        }}
      >
        <div
          className="pull-grab"
          onPointerDown={(e) => {
            // A finger at the left edge swipes the sheet away instead.
            if (!open || e.button !== 0 || (e.pointerType === "touch" && e.clientX < EDGE)) return;
            e.currentTarget.setPointerCapture(e.pointerId);
            motion.begin(e.clientY);
          }}
          onPointerMove={(e) => motion.follow(e.clientY)}
          onPointerUp={() => motion.release(true)}
          onPointerCancel={() => motion.release(false)}
        />
        <div
          ref={body}
          className="pull-body"
          onWheel={(e) => {
            // The wheel opens it the rest of the way, as a finger pulling up would.
            if (at === "half" && e.deltaY > 0) setDetent("full");
          }}
          onPointerDown={(e) => {
            // A mouse pulls it by what it holds too, as a finger does; touch has its own listeners above.
            if (!open || e.pointerType !== "mouse" || e.button !== 0 || (e.target as HTMLElement).closest("input, textarea, select")) return;
            mouse.current = { id: e.pointerId, y: e.clientY, pulling: false };
          }}
          onPointerMove={(e) => {
            const m = mouse.current;
            if (!m || m.id !== e.pointerId) return;
            if (!m.pulling) {
              const dy = e.clientY - m.y;
              if (Math.abs(dy) < 6) return;
              // All the way up, it pulls down only from the top of what it holds; up, or further down, is the wheel's.
              if (at === "full" && (dy < 0 || (body.current?.scrollTop ?? 0) > 0)) {
                mouse.current = null;
                return;
              }
              m.pulling = true;
              e.currentTarget.setPointerCapture(e.pointerId);
              window.getSelection()?.removeAllRanges();
              motion.begin(m.y);
            }
            motion.follow(e.clientY);
          }}
          onPointerUp={(e) => {
            const m = mouse.current;
            mouse.current = null;
            if (!m?.pulling) return;
            motion.release(false);
            // The button the pull began on is not pressed by its end.
            const el = e.currentTarget;
            const swallow = (ev: Event) => {
              ev.stopPropagation();
              ev.preventDefault();
            };
            el.addEventListener("click", swallow, { capture: true, once: true });
            setTimeout(() => el.removeEventListener("click", swallow, { capture: true }), 400);
          }}
          onPointerCancel={() => {
            if (mouse.current?.pulling) motion.release(false);
            mouse.current = null;
          }}
        >
          {shown.children}
        </div>
      </div>
    </div>,
    document.body,
  );
}
