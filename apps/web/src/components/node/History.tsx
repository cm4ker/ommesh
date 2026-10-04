import { useState } from "react";
import { lppTypeName, NoReplyError, type ContactRecord, type LppReading, type SeriesSummary } from "@meshnet/meshcore";
import { errorText } from "../../i18n/errors.js";
import { t, type Key } from "../../i18n/index.js";
import { ago, powerSummary } from "../../lib/format.js";
import { session, useSession } from "../../lib/session.js";
import { Button } from "../../ui/Button.js";
import { Section } from "../../ui/Field.js";
import { RefreshIcon } from "../Icons.js";

const WINDOWS: { secs: number; label: Key }[] = [
  { secs: 3600, label: "node.history.lastHour" },
  { secs: 86_400, label: "node.history.day" },
  { secs: 7 * 86_400, label: "node.history.week" },
];

/**
 * A scale that fits the usual range of each kind of reading, in the unit shown; a value outside
 * it widens it. `per` turns the node's unit into the one shown: amperes and watts read as mA and mW.
 */
const SCALES: Record<string, { lo: number; hi: number; unit: Key; digits: number; per?: number }> = {
  temperature: { lo: -20, hi: 40, unit: "node.unit.celsius", digits: 1 },
  humidity: { lo: 0, hi: 100, unit: "node.unit.percent", digits: 0 },
  barometer: { lo: 950, hi: 1050, unit: "node.unit.hectopascal", digits: 1 },
  voltage: { lo: 3, hi: 4.3, unit: "node.unit.volt", digits: 2 },
  current: { lo: 0, hi: 1000, unit: "node.unit.milliampere", digits: 0, per: 1000 },
  power: { lo: 0, hi: 5000, unit: "node.unit.milliwatt", digits: 0, per: 1000 },
  luminosity: { lo: 0, hi: 1000, unit: "node.unit.lux", digits: 0 },
  percentage: { lo: 0, hi: 100, unit: "node.unit.percent", digits: 0 },
};

/** What each kind of reading is called. */
const KINDS: Record<Exclude<LppReading["type"], "unknown">, Key> = {
  digitalIn: "node.history.kind.digitalIn",
  digitalOut: "node.history.kind.digitalOut",
  analogIn: "node.history.kind.analogIn",
  analogOut: "node.history.kind.analogOut",
  genericSensor: "node.history.kind.genericSensor",
  luminosity: "node.history.kind.luminosity",
  presence: "node.history.kind.presence",
  temperature: "node.history.kind.temperature",
  humidity: "node.history.kind.humidity",
  accelerometer: "node.history.kind.accelerometer",
  barometer: "node.history.kind.barometer",
  voltage: "node.history.kind.voltage",
  current: "node.history.kind.current",
  frequency: "node.history.kind.frequency",
  percentage: "node.history.kind.percentage",
  altitude: "node.history.kind.altitude",
  concentration: "node.history.kind.concentration",
  power: "node.history.kind.power",
  distance: "node.history.kind.distance",
  energy: "node.history.kind.energy",
  direction: "node.history.kind.direction",
  unixTime: "node.history.kind.unixTime",
  gyrometer: "node.history.kind.gyrometer",
  colour: "node.history.kind.colour",
  gps: "node.history.kind.gps",
  switch: "node.history.kind.switch",
};

export function History({ contact }: { contact: ContactRecord }) {
  const state = useSession();
  const key = contact.key;
  const record = state.series[key];
  const online = state.status === "ready";
  const [windowSecs, setWindowSecs] = useState(record?.windowSecs ?? 86_400);
  const [busy, setBusy] = useState(false);
  // An error stands until an answer newer than it comes in: one that came late says the node heard.
  const [error, setError] = useState<{ text: string; at: number } | null>(null);

  const ask = async (secs: number) => {
    setBusy(true);
    setError(null);
    try {
      await session.requestSeries(key, secs);
    } catch (e) {
      setError({ text: e instanceof NoReplyError ? t("node.history.noReply", { seconds: /(\d+) s$/.exec(e.message)?.[1] ?? "?" }) : errorText(e), at: Date.now() });
    } finally {
      setBusy(false);
    }
  };

  const shown = record && record.windowSecs === windowSecs ? record : null;

  return (
    <div className="card-scroll">
      <div className="toolbar">
        <div className="segmented" role="group" aria-label={t("node.history.window")}>
          {WINDOWS.map((w) => (
            <button key={w.secs} type="button" className={windowSecs === w.secs ? "on" : ""} disabled={busy} onClick={() => setWindowSecs(w.secs)}>
              {t(w.label)}
            </button>
          ))}
        </div>
        <span className="row-actions">
          <span className="muted small">{shown ? t("node.history.answered", { time: ago(shown.at) }) : t("node.notAskedYet")}</span>
          <Button size="sm" busy={busy} disabled={!online} onClick={() => void ask(windowSecs)}>
            <RefreshIcon size={13} />
            {t("node.history.ask")}
          </Button>
        </span>
      </div>
      {error && (record?.at ?? 0) < error.at ? <p className="connect-error">{error.text}</p> : null}
      {shown ? (
        shown.series.length === 0 ? (
          <p className="muted">{t("node.history.nothing")}</p>
        ) : (
          <Section title={t("node.history.ranges")}>
            <div className="ranges">
              {shown.series.map((s, i) => (
                <RangeRow key={i} summary={lppTypeName(s.lppType) === "power" ? powerSummary(s, shown.series) : s} />
              ))}
            </div>
          </Section>
        )
      ) : (
        <p className="muted">{t("node.history.intro")}</p>
      )}
      <p className="field-hint">{t("node.history.hint")}</p>
    </div>
  );
}

function RangeRow({ summary: raw }: { summary: SeriesSummary }) {
  const kind = lppTypeName(raw.lppType);
  const known = SCALES[kind];
  const per = known?.per ?? 1;
  // Rounded off the float dust of the multiplication (0.029 A is 29.000000000000004 mA).
  const shown = (v: number) => Number((v * per).toFixed(6));
  const summary = { ...raw, min: shown(raw.min), max: shown(raw.max), avg: shown(raw.avg) };
  const scale = known ?? { lo: summary.min, hi: summary.max, digits: 2 };
  const unit = known ? t(known.unit) : "";
  let lo = Math.min(scale.lo, summary.min);
  let hi = Math.max(scale.hi, summary.max);
  if (hi - lo < 1e-9) {
    lo -= 1;
    hi += 1;
  }
  const p = (v: number) => ((v - lo) / (hi - lo)) * 100;
  const d = scale.digits;
  const label = kind === "unknown" ? t("node.history.unknownType", { type: summary.lppType }) : t(KINDS[kind]);
  return (
    <div className="range">
      <span className="range-name">
        <span>{label}</span>
        <span className="muted small">{unit ? t("node.history.channelUnit", { channel: summary.channel, unit }) : t("node.history.channel", { channel: summary.channel })}</span>
      </span>
      <span className="range-plot" title={t("node.history.rangeTitle", { min: summary.min, mean: summary.avg, max: summary.max, unit })}>
        <span className="range-track">
          <span className="range-band" style={{ left: `${p(summary.min)}%`, width: `${Math.max(0.8, p(summary.max) - p(summary.min))}%` }} />
          <span className="range-avg" style={{ left: `${p(summary.avg)}%` }} />
        </span>
        <span className="range-scale">
          <span>{Number(lo.toFixed(d))}</span>
          <span>{Number(hi.toFixed(d))}</span>
        </span>
      </span>
      <span className="range-values">
        <b>{summary.avg.toFixed(d)}</b> <span className="muted">{t("node.history.mean")}</span>
        <br />
        <span className="muted small">
          {summary.min.toFixed(d)} – {summary.max.toFixed(d)}
        </span>
      </span>
    </div>
  );
}
