/**
 * The line of sight between two ends, over the map: the ground between them
 * from the elevation tiles, the straight line, the Fresnel zone around it,
 * and one sentence on whether the terrain lets the signal through. The two
 * antenna heights are the only things to set; a node's is remembered.
 */

import { useEffect, useState } from "react";
import { t } from "../../i18n/index.js";
import { tx } from "../../i18n/rich.js";
import { elevationAttribution, profileBetween } from "../../lib/elevation.js";
import { formatDistance } from "../../lib/geo.js";
import { formatDbm, formatSnr, lineOfSight, verdictWord, type LineOfSight, type LinkRadio, type Profile } from "../../lib/los.js";
import { defaultHeight } from "../../lib/mapOverlay.js";
import type { LosEnd, MeshTool } from "../../lib/meshTool.js";
import { useSession } from "../../lib/session.js";
import { antennaHeights, setAntennaHeight } from "../../lib/antennas.js";
import { IconButton } from "../../ui/Button.js";
import { AlertIcon, BackIcon, CheckIcon, CloseIcon, MinusIcon, PlusIcon } from "../Icons.js";

const HEIGHTS = [1, 1.5, 2, 3, 5, 8, 10, 12, 15, 20, 25, 30, 40, 50, 60, 80, 100];

function remembered(end: LosEnd): number | undefined {
  if (!end.key) return undefined;
  return antennaHeights()[end.key];
}

function remember(end: LosEnd, height: number): void {
  if (!end.key) return;
  setAntennaHeight(end.key, height);
}

/** The height an end's antenna is taken at: the one last set for it, or a guess by what it is. */
export function antennaHeight(end: LosEnd, contacts: Parameters<typeof defaultHeight>[1]): number {
  return remembered(end) ?? defaultHeight(end, contacts);
}

function step(height: number, by: number): number {
  const i = HEIGHTS.findIndex((h) => h >= height);
  const at = i < 0 ? HEIGHTS.length - 1 : i;
  return HEIGHTS[Math.max(0, Math.min(HEIGHTS.length - 1, at + by))]!;
}

export function LosView({ tool, onBack, onClose }: { tool: Extract<MeshTool, { kind: "los" }>; onBack?: (() => void) | undefined; onClose: () => void }) {
  const state = useSession();
  const { from, to } = tool;
  const [profile, setProfile] = useState<Profile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [heights, setHeights] = useState<[number, number]>(() => [remembered(from) ?? defaultHeight(from, state.contacts), remembered(to) ?? defaultHeight(to, state.contacts)]);

  useEffect(() => {
    let live = true;
    setProfile(null);
    setError(null);
    setHeights([remembered(from) ?? defaultHeight(from, state.contacts), remembered(to) ?? defaultHeight(to, state.contacts)]);
    profileBetween(from, to)
      .then((p) => live && setProfile(p))
      .catch(() => live && setError(t("tools.los.noTerrain")));
    return () => {
      live = false;
    };
    // A new pair of ends, not a new state, reads the terrain again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from.lat, from.lon, to.lat, to.lon]);

  const self = state.self;
  const radio: LinkRadio | null = self ? { frequencyKhz: self.frequencyKhz, bandwidthHz: self.bandwidthHz, spreadingFactor: self.spreadingFactor, codingRate: self.codingRate, txPowerDbm: self.txPower } : null;
  const los = profile && radio ? lineOfSight(profile, heights[0], heights[1], radio) : null;
  const km = profile ? profile.distanceM / 1000 : null;

  const setHeight = (side: 0 | 1, by: number) => {
    const next: [number, number] = [...heights];
    next[side] = step(heights[side], by);
    remember(side === 0 ? from : to, next[side]);
    setHeights(next);
  };

  return (
    <div className="tool">
      <div className="tool-head">
        {onBack ? (
          <IconButton label={t("common.back")} onClick={onBack}>
            <BackIcon size={18} />
          </IconButton>
        ) : null}
        <span className="row-main">
          <span className="row-title">
            {from.name} → {to.name}
          </span>
          <span className="row-sub muted">{km !== null ? t("tools.los.sub", { distance: formatDistance(km) }) : t("tools.los.title")}</span>
        </span>
        <IconButton label={t("common.close")} onClick={onClose}>
          <CloseIcon size={18} />
        </IconButton>
      </div>
      {error ? <p className="tool-note">{error}</p> : null}
      {!error && !los ? <p className="tool-note muted">{radio ? t("tools.los.reading") : t("tools.los.connect")}</p> : null}
      {los ? (
        <>
          <Verdict los={los} />
          <div className="los-chart">
            <ProfileChart los={los} from={from.name} to={to.name} heights={heights} />
          </div>
          <div className="los-heights">
            <Stepper label={from.key === "self" ? t("tools.los.yourAntenna") : from.name} value={heights[0]} onStep={(by) => setHeight(0, by)} />
            <Stepper label={to.key === null ? t("tools.los.mastHere") : to.name} value={heights[1]} onStep={(by) => setHeight(1, by)} />
          </div>
          <p className="tool-line">{tx("tools.los.budget", { power: <b>{formatDbm(los.arrivesDbm)}</b>, margin: Math.round(los.marginDb), sf: radio!.spreadingFactor })}</p>
          {tool.heard ? (
            <p className="tool-line">
              {tool.heard[1] === null
                ? tx("tools.los.pingedOneWay", { out: <b>{t("tools.unit.db", { value: formatSnr(tool.heard[0]) })}</b> })
                : tx("tools.los.pinged", { out: <b>{t("tools.unit.db", { value: formatSnr(tool.heard[0]) })}</b>, back: <b>{t("tools.unit.db", { value: formatSnr(tool.heard[1]) })}</b> })}
            </p>
          ) : null}
          <p className="tool-credit muted">{t("tools.los.credit", { source: elevationAttribution() })}</p>
        </>
      ) : null}
    </div>
  );
}

function Verdict({ los }: { los: LineOfSight }) {
  const w = los.worst;
  const at = formatDistance(w.d / 1000);
  const text =
    los.verdict === "clear"
      ? Number.isFinite(w.clearanceM)
        ? t("tools.los.clear", { spare: Math.round(w.clearanceM) })
        : t("tools.los.tooShort")
      : los.verdict === "grazed"
        ? t("tools.los.grazed", { at, loss: Math.round(los.terrainDb) })
        : t("tools.los.blocked", { rise: Math.round(-w.clearanceM), at, loss: Math.round(los.terrainDb) });
  const tone = los.verdict === "clear" ? "good" : los.verdict === "grazed" ? "warn" : "bad";
  return (
    <p className={`los-verdict ${tone}`}>
      {los.verdict === "clear" ? <CheckIcon size={18} /> : <AlertIcon size={18} />}
      <span>
        <b>{verdictWord(los.verdict)}:</b> {text}
      </span>
    </p>
  );
}

function Stepper({ label, value, onStep }: { label: string; value: number; onStep: (by: number) => void }) {
  return (
    <div className="stepper">
      <span className="row-main">
        <span className="row-sub muted">{label}</span>
        <b className="mono">{t("common.meters", { value })}</b>
      </span>
      <IconButton label={t("tools.los.lower", { name: label })} disabled={value <= HEIGHTS[0]!} onClick={() => onStep(-1)}>
        <MinusIcon size={16} />
      </IconButton>
      <IconButton label={t("tools.los.raise", { name: label })} disabled={value >= HEIGHTS.at(-1)!} onClick={() => onStep(1)}>
        <PlusIcon size={16} />
      </IconButton>
    </div>
  );
}

/** The ground, the line, and the Fresnel zone, to one scale; the worst point marked. */
function ProfileChart({ los, from, to, heights }: { los: LineOfSight; from: string; to: string; heights: [number, number] }) {
  const W = 340;
  const H = 180;
  const x0 = 32;
  const x1 = 332;
  const y0 = 16;
  const y1 = 158;
  const pts = los.points;
  const D = pts.at(-1)!.d || 1;
  let lo = Math.min(...pts.map((p) => p.ground)) - 6;
  let hi = Math.max(...pts.map((p) => Math.max(p.ground, p.line + p.fresnel))) + 6;
  const span = hi - lo;
  const tick = span > 400 ? 100 : span > 200 ? 50 : span > 80 ? 25 : 10;
  lo = Math.floor(lo / tick) * tick;
  hi = Math.ceil(hi / tick) * tick;
  const X = (d: number) => x0 + (d / D) * (x1 - x0);
  const Y = (h: number) => y1 - ((h - lo) / (hi - lo)) * (y1 - y0);
  const f = (v: number) => v.toFixed(1);
  const ground = pts.map((p) => `${f(X(p.d))},${f(Y(p.ground))}`);
  const zone = [...pts.map((p) => `${f(X(p.d))},${f(Y(p.line + p.fresnel))}`), ...[...pts].reverse().map((p) => `${f(X(p.d))},${f(Y(p.line - p.fresnel))}`)];
  const sixty = pts.map((p) => `${f(X(p.d))},${f(Y(p.line - 0.6 * p.fresnel))}`);
  // Stretches of ground inside 60 % of the zone, and those above the line itself.
  const runs = (test: (p: (typeof pts)[number]) => boolean) => {
    const out: string[][] = [];
    let run: string[] = [];
    pts.forEach((p, i) => {
      if (!p.near && test(p)) run.push(ground[i]!);
      else if (run.length) {
        out.push(run.length === 1 ? [run[0]!, run[0]!] : run);
        run = [];
      }
    });
    if (run.length) out.push(run.length === 1 ? [run[0]!, run[0]!] : run);
    return out;
  };
  const grazing = runs((p) => p.ground > p.line - 0.6 * p.fresnel && p.ground <= p.line);
  const cutting = runs((p) => p.ground > p.line);
  const ticks: number[] = [];
  for (let h = lo; h <= hi; h += tick) ticks.push(h);
  const km = D / 1000;
  const kmStep = km > 40 ? 20 : km > 16 ? 10 : km > 6 ? 5 : km > 2 ? 1 : 0.5;
  const kms: number[] = [];
  // The end is labelled with the whole distance; a tick too close to it would sit under the label.
  for (let k = 0; k <= km + 1e-6; k += kmStep) if (X(k * 1000) < x1 - 30) kms.push(k);
  const w = los.worst;
  const wp = pts[w.index]!;
  const label = w.clearanceM < 0 ? t("tools.los.aboveLine", { value: Math.round(-w.clearanceM) }) : Number.isFinite(w.ratio) ? t("tools.los.zoneClear", { value: Math.round(Math.min(w.ratio, 9.99) * 100) }) : "";
  const lw = label.length * 5.4 + 8;
  const lx = Math.min(Math.max(X(wp.d) - lw / 2, x0 + 2), x1 - lw);
  const ly = Math.max(y0 + 2, Math.min(Y(wp.ground), Y(wp.line)) - 22);
  return (
    <svg className="los-svg" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={t("tools.los.profile", { km: km.toFixed(1) })}>
      {ticks.map((h) => (
        <g key={h}>
          <line className="los-grid" x1={x0} x2={x1} y1={f(Y(h))} y2={f(Y(h))} />
          <text className="los-tick" x={x0 - 4} y={f(Y(h) + 3)} textAnchor="end">
            {h}
          </text>
        </g>
      ))}
      <polygon className="los-zone" points={zone.join(" ")} />
      <polyline className="los-sixty" points={sixty.join(" ")} />
      <polygon className="los-ground" points={`${f(X(0))},${y1} ${ground.join(" ")} ${f(X(D))},${y1}`} />
      <polyline className="los-edge" points={ground.join(" ")} />
      {grazing.map((r, i) => (
        <polyline key={`g${i}`} className="los-graze" points={r.join(" ")} />
      ))}
      {cutting.map((r, i) => (
        <polyline key={`c${i}`} className="los-cut" points={r.join(" ")} />
      ))}
      <line className="los-line" x1={f(X(0))} y1={f(Y(pts[0]!.line))} x2={f(X(D))} y2={f(Y(pts.at(-1)!.line))} />
      <line className="los-mast" x1={f(X(0))} y1={f(Y(pts[0]!.ground))} x2={f(X(0))} y2={f(Y(pts[0]!.line))} />
      <line className="los-mast" x1={f(X(D))} y1={f(Y(pts.at(-1)!.ground))} x2={f(X(D))} y2={f(Y(pts.at(-1)!.line))} />
      <circle className="los-antenna" cx={f(X(0))} cy={f(Y(pts[0]!.line))} r={3.5} />
      <circle className="los-antenna" cx={f(X(D))} cy={f(Y(pts.at(-1)!.line))} r={3.5} />
      {label ? (
        <>
          <line className="los-worst-line" x1={f(X(wp.d))} x2={f(X(wp.d))} y1={f(Math.min(Y(wp.ground), Y(wp.line)))} y2={f(Math.max(Y(wp.ground), Y(wp.line)))} />
          <circle className="los-worst" cx={f(X(wp.d))} cy={f(Y(wp.ground))} r={3.5} />
          <rect className="los-label-bg" x={f(lx)} y={f(ly)} width={f(lw)} height={15} rx={3} />
          <text className="los-label" x={f(lx + 4)} y={f(ly + 11)}>
            {label}
          </text>
        </>
      ) : null}
      {kms.map((k) => (
        <text key={k} className="los-tick" x={f(X(k * 1000))} y={H - 6} textAnchor="middle">
          {Number.isInteger(k) ? k : k.toFixed(1)}
        </text>
      ))}
      <text className="los-tick" x={x1} y={H - 6} textAnchor="end">
        {t("common.kilometers", { value: km.toFixed(1) })}
      </text>
      <text className="los-tick" x={x0 + 2} y={y0 - 5}>
        {from} · {t("common.meters", { value: heights[0] })}
      </text>
      <text className="los-tick" x={x1} y={y0 - 5} textAnchor="end">
        {to} · {t("common.meters", { value: heights[1] })}
      </text>
    </svg>
  );
}
