import { useState } from "react";
import { locale, t } from "../../i18n/index.js";
import { tx } from "../../i18n/rich.js";

const W = 150;
const H = 38;
const PX = 4;
const PY = 5;

/**
 * A week of one reading, or a day when `day` says so, as a line with its area, the latest point
 * marked. Hovering shows the reading under the pointer in the caption below.
 */
export function Sparkline({ values, times, unit, digits, day = false }: { values: number[]; times: number[]; unit: string; digits: number; day?: boolean | undefined }) {
  const [hover, setHover] = useState<number | null>(null);
  if (values.length === 0) return null;
  let min = Math.min(...values);
  let max = Math.max(...values);
  if (max - min < 1e-6) {
    min -= 1;
    max += 1;
  }
  const x = (i: number) => PX + (values.length === 1 ? (W - 2 * PX) / 2 : (i * (W - 2 * PX)) / (values.length - 1));
  const y = (v: number) => PY + (1 - (v - min) / (max - min)) * (H - 2 * PY);
  const points = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`);
  const line = `M${points.join("L")}`;
  const last = values.length - 1;
  const area = `${line}L${x(last).toFixed(1)},${H}L${x(0).toFixed(1)},${H}Z`;
  const low = Math.min(...values);
  const high = Math.max(...values);
  const text = (v: number) => v.toLocaleString(locale(), { minimumFractionDigits: digits, maximumFractionDigits: digits, useGrouping: false });

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const fx = ((e.clientX - box.left) / box.width) * W;
    const i = values.length === 1 ? 0 : Math.round(((fx - PX) / (W - 2 * PX)) * last);
    setHover(Math.max(0, Math.min(last, i)));
  };

  return (
    <>
      <svg
        className="spark"
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={t("node.sparkline.label", { count: values.length, low: text(low), high: text(high), unit })}
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
      >
        <line className="spark-base" x1={0} x2={W} y1={H - 0.5} y2={H - 0.5} />
        {values.length > 1 ? <path className="spark-area" d={area} /> : null}
        {values.length > 1 ? <path className="spark-line" d={line} /> : null}
        <circle className="spark-end" cx={x(last)} cy={y(values[last]!)} r={4} />
        {hover !== null ? (
          <>
            <line className="spark-hx" x1={x(hover)} x2={x(hover)} y1={0} y2={H} />
            <circle className="spark-hd" cx={x(hover)} cy={y(values[hover]!)} r={3.5} />
          </>
        ) : null}
      </svg>
      <span className="spark-cap">
        {hover !== null ? (
          <>
            {stamp(times[hover]!)} · <b>{text(values[hover]!)} {unit}</b>
          </>
        ) : values.length === 1 ? (
          t("node.sparkline.one")
        ) : (
          tx(day ? "node.sparkline.dayRange" : "node.sparkline.range", { count: values.length, low: <b>{text(low)}</b>, high: <b>{text(high)}</b>, unit })
        )}
      </span>
    </>
  );
}

function stamp(ms: number): string {
  return new Date(ms).toLocaleString(locale(), { weekday: "short", hour: "2-digit", minute: "2-digit" });
}
