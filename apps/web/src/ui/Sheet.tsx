import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useBackLayer } from "../lib/back.js";
import { useWide } from "../lib/layout.js";

/** Pulled down this far, or flung down faster than this many pixels a millisecond, the sheet goes. */
const CLOSE_PULL = 80;
const CLOSE_FLICK = 0.5;

function reducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * A sheet from the bottom of a phone's screen, pulled down by its handle or
 * title, or tapped past, to close; on a wide screen the same content in a
 * dialog in the middle. On a phone it slides away when it closes, showing
 * what it last held while it goes.
 */
export function Sheet({ open, onClose, title, children, className }: { open: boolean; onClose: () => void; title?: string | undefined; children: ReactNode; className?: string | undefined }) {
  const wide = useWide();
  const box = useRef<HTMLDivElement>(null);
  // Callers pass a fresh closure every render; the effect below runs once per opening.
  const close = useRef(onClose);
  close.current = onClose;
  useBackLayer(open, onClose);
  // A sheet opened by a long press appears under the finger, and the click that ends the press
  // lands on the scrim. Only a press that began on the scrim is a tap past the sheet.
  const pressedScrim = useRef(false);
  const drag = useRef<{ from: number; dy: number; trail: { y: number; t: number }[] } | null>(null);

  // Still on screen for its slide down after the caller has closed it, with what it held.
  const [present, setPresent] = useState(open);
  const kept = useRef<{ title: string | undefined; children: ReactNode }>({ title, children });
  if (open) kept.current = { title, children };
  if (open && !present) setPresent(true);
  const leaving = !open && present;
  useEffect(() => {
    if (leaving && (wide || reducedMotion())) setPresent(false);
  }, [leaving, wide]);

  useEffect(() => {
    if (!open) return;
    pressedScrim.current = false;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      close.current();
    };
    window.addEventListener("keydown", onKey, true);
    const before = document.activeElement as HTMLElement | null;
    box.current?.focus({ preventScroll: true });
    return () => {
      window.removeEventListener("keydown", onKey, true);
      // Back where the focus was, unless what was chosen has taken it somewhere of its own: a reply
      // puts it in the field, and the keyboard would go down again.
      const now = document.activeElement;
      if (!now || now === document.body || box.current?.contains(now)) before?.focus?.({ preventScroll: true });
    };
  }, [open]);

  if (!present) return null;

  const grab = {
    onPointerDown: (e: PointerEvent<HTMLDivElement>) => {
      if (!open || e.button !== 0) return;
      drag.current = { from: e.clientY, dy: 0, trail: [{ y: e.clientY, t: performance.now() }] };
      e.currentTarget.setPointerCapture(e.pointerId);
      if (box.current) box.current.style.transition = "none";
    },
    onPointerMove: (e: PointerEvent) => {
      const d = drag.current;
      if (!d || !box.current) return;
      const t = performance.now();
      d.trail.push({ y: e.clientY, t });
      while (d.trail.length > 2 && t - d.trail[0]!.t > 100) d.trail.shift();
      // Down it follows the finger; up it gives a little and no more.
      const raw = e.clientY - d.from;
      d.dy = raw >= 0 ? raw : -Math.min(12, -raw * 0.2);
      box.current.style.transform = `translate3d(0, ${d.dy}px, 0)`;
    },
    onPointerUp: () => {
      const d = drag.current;
      const el = box.current;
      drag.current = null;
      if (!d || !el) return;
      const first = d.trail[0]!;
      const last = d.trail.at(-1)!;
      const v = performance.now() - last.t < 80 && last.t > first.t ? (last.y - first.y) / (last.t - first.t) : 0;
      el.style.transition = "";
      if (d.dy > CLOSE_PULL || (d.dy > 8 && v > CLOSE_FLICK)) {
        // It goes on down from where it was let go.
        onClose();
        return;
      }
      el.style.transform = "";
    },
  };

  const shown = open ? { title, children } : kept.current;
  return createPortal(
    <div className={["sheet-layer", wide ? "wide" : "", leaving ? "leaving" : ""].join(" ")}>
      <div
        className="sheet-scrim"
        onPointerDown={() => (pressedScrim.current = true)}
        onClick={() => {
          if (pressedScrim.current && open) onClose();
          pressedScrim.current = false;
        }}
      />
      <div
        ref={box}
        tabIndex={-1}
        className={["sheet", className ?? ""].join(" ")}
        role="dialog"
        aria-modal="true"
        aria-label={shown.title}
        onAnimationEnd={(e) => {
          if (leaving && e.target === e.currentTarget) setPresent(false);
        }}
      >
        {wide ? (
          shown.title ? <h2 className="sheet-title">{shown.title}</h2> : null
        ) : (
          <div className="sheet-head" {...grab} onPointerCancel={grab.onPointerUp}>
            <div className="sheet-grab" />
            {shown.title ? <h2 className="sheet-title">{shown.title}</h2> : null}
          </div>
        )}
        <div className="sheet-body">{shown.children}</div>
      </div>
    </div>,
    document.body,
  );
}
