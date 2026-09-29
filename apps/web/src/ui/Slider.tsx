/**
 * A slider with marks over it: where the things it sorts lie along the same
 * scale, each a dot in its colour, faint when the slider leaves it out. One
 * end to move, which keeps what lies above it, or two, which keep what lies
 * between them. Places run from 0 to 1 along the rail and the caller turns
 * them into its own units. `onDone` runs when a finger or a key lets go.
 */

import { useEffect, useRef } from "react";

export interface SliderMark {
  at: number;
  tone: "good" | "fair" | "weak";
  out: boolean;
}

const STEPS = 1000;
/** The ends of two thumbs never meet: the lower one would be lost under the upper. */
const GAP = 0.02;

/** A place on the rail as CSS: the thumb's middle runs half a thumb in from either edge. */
const along = (place: number) => `calc(var(--slider-thumb) / 2 + (100% - var(--slider-thumb)) * ${place.toFixed(4)})`;

export function MarkedSlider({
  values,
  onChange,
  onDone,
  marks,
  ticks = [],
  scale,
  names,
  texts,
}: {
  values: [number] | [number, number];
  onChange: (values: number[]) => void;
  onDone?: (() => void) | undefined;
  marks: SliderMark[];
  /** Short lines across the rail where something changes, such as the signal's colours. */
  ticks?: number[];
  /** The figures written under the rail. */
  scale: { at: number; text: string }[];
  /** What each end sets, and its value in words, for a screen reader. */
  names: string[];
  texts: string[];
}) {
  const pair = values.length === 2;
  const inputs = useRef<(HTMLInputElement | null)[]>([]);
  const done = useRef(onDone);
  done.current = onDone;
  // React's onChange is every step; the browser's own change event comes once, when the thumb is let go.
  useEffect(() => {
    const els = inputs.current.filter((el): el is HTMLInputElement => !!el);
    const letGo = () => done.current?.();
    for (const el of els) el.addEventListener("change", letGo);
    return () => {
      for (const el of els) el.removeEventListener("change", letGo);
    };
  }, [pair]);

  const move = (index: number, place: number) => {
    const next = [...values];
    next[index] = place;
    if (pair) {
      if (index === 0) next[0] = Math.min(place, values[1]! - GAP);
      else next[1] = Math.max(place, values[0]! + GAP);
    }
    onChange(next.map((p) => Math.min(1, Math.max(0, p))));
  };
  const lo = values[0];
  const hi = pair ? values[1]! : 1;

  return (
    <div className="slider">
      <div className="slider-marks" aria-hidden="true">
        {marks.map((m, i) => (
          <i key={i} className={[m.tone, m.out ? "out" : ""].join(" ")} style={{ left: along(m.at), top: `${(i % 3) * 5}px` }} />
        ))}
      </div>
      <div className="slider-rail">
        <span className="slider-track" aria-hidden="true" />
        <span className="slider-fill" aria-hidden="true" style={{ left: along(lo), right: `calc(100% - ${along(hi)})` }} />
        {ticks.map((at) => (
          <span key={at} className="slider-tick" aria-hidden="true" style={{ left: along(at) }} />
        ))}
        {values.map((place, i) => (
          <input
            key={i}
            ref={(el) => {
              inputs.current[i] = el;
            }}
            type="range"
            min={0}
            max={STEPS}
            step={1}
            value={Math.round(place * STEPS)}
            aria-label={names[i]}
            aria-valuetext={texts[i]}
            // The lower thumb pushed to the far end would sit under the upper one; it comes up on top.
            style={i === 0 && pair && place > 0.9 ? { zIndex: 2 } : undefined}
            onChange={(e) => move(i, Number(e.target.value) / STEPS)}
          />
        ))}
      </div>
      <div className="slider-scale" aria-hidden="true">
        {scale.map((s) => (
          <span key={s.at} style={{ left: along(s.at) }}>
            {s.text}
          </span>
        ))}
      </div>
    </div>
  );
}
