import { useRef } from "react";
import type { LppReading, ReadingLine, ReadingSample } from "@meshnet/meshcore";
import { locale, t, type Key } from "../i18n/index.js";
import { batteryTypeLabel } from "../lib/batteryType.js";
import { batteryPercent, powerWatts, type BatteryType } from "../lib/format.js";
import { bearingDeg, compass, distanceKm, formatDistance, hasPosition } from "../lib/geo.js";
import { usePress } from "../lib/press.js";
import { getUnits, pressureIn, pressureUnitKey, temperatureIn, temperatureUnitKey, useUnits, type Units } from "../lib/units.js";
import { Block, InfoRow } from "../ui/List.js";
import { showMenu } from "../ui/Menu.js";
import { RefreshIcon } from "./Icons.js";
import { Sparkline } from "./node/Sparkline.js";

/** What each kind of reading measures. */
const LABELS: Record<LppReading["type"], Key> = {
  digitalIn: "radio.readings.digitalIn",
  digitalOut: "radio.readings.digitalOut",
  analogIn: "radio.readings.analogIn",
  analogOut: "radio.readings.analogOut",
  genericSensor: "radio.readings.genericSensor",
  luminosity: "radio.readings.luminosity",
  presence: "radio.readings.presence",
  temperature: "radio.readings.temperature",
  humidity: "radio.readings.humidity",
  accelerometer: "radio.readings.accelerometer",
  barometer: "radio.readings.barometer",
  voltage: "radio.readings.voltage",
  current: "radio.readings.current",
  frequency: "radio.readings.frequency",
  percentage: "radio.readings.percentage",
  altitude: "radio.readings.altitude",
  concentration: "radio.readings.concentration",
  power: "radio.readings.power",
  distance: "radio.readings.distance",
  energy: "radio.readings.energy",
  direction: "radio.readings.direction",
  unixTime: "radio.readings.unixTime",
  gyrometer: "radio.readings.gyrometer",
  colour: "radio.readings.colour",
  gps: "radio.readings.gps",
  switch: "radio.readings.switch",
  unknown: "radio.readings.unknown",
};

/** What a kind of reading measures, in the reader's language: "Temperature". */
export function readingName(type: LppReading["type"]): string {
  return t(LABELS[type]);
}

/** The channel the firmware gives the radio itself: its battery, its processor's temperature, its GPS. */
const SELF_CHANNEL = 1;
/** How far back a reading's line goes; the session trims what is older only as the next answer comes. */
const DAY_MS = 24 * 3600 * 1000;

interface Tile {
  id: string;
  label: string;
  value: string;
  unit?: string | undefined;
  sub?: React.ReactNode;
  wide?: boolean | undefined;
  line?: { values: number[]; times: number[]; unit: string; digits: number } | undefined;
  /** The line the session keeps it by, which a hold starts again. */
  kept?: ReadingLine | undefined;
}

/** What a line can be of. */
export type LineKind = "battery" | "noise" | "voltage" | "current";

const LINE_ONLY: Record<LineKind, Key> = {
  battery: "node.readings.only.battery",
  noise: "node.readings.only.noise",
  voltage: "node.readings.only.voltage",
  current: "node.readings.only.current",
};

/**
 * A tile whose line can start again: held, or clicked with the right button, it lifts over the
 * dimmed screen with the one thing to do under it. Without a `kind` the tile is left as it is.
 */
export function useLineHold(kind: LineKind | null, run: () => void) {
  const tile = useRef<HTMLElement | null>(null);
  const press = usePress((at) =>
    showMenu([{ label: t("node.readings.restartLine"), hint: kind ? t(LINE_ONLY[kind]) : undefined, icon: <RefreshIcon size={17} />, onSelect: run }], { at, lift: tile.current, hints: true }),
  );
  return kind
    ? {
        ref: (el: HTMLElement | null) => {
          tile.current = el;
        },
        ...press,
      }
    : {};
}

/** A tile of `Readings`, its line held to start again when `onRestart` is given. */
function ReadingTile({ tile, onRestart }: { tile: Tile; onRestart: ((line: ReadingLine) => void) | undefined }) {
  const kept = tile.line && onRestart ? tile.kept : undefined;
  const hold = useLineHold(kept ? (kept.endsWith(":current") ? "current" : "voltage") : null, () => kept && onRestart?.(kept));
  return (
    <div className={["reading-tile", tile.wide ? "wide" : ""].join(" ")} {...hold}>
      <span className="reading-label">{tile.label}</span>
      <span className="reading-value">
        {tile.value}
        {tile.unit ? <small>{tile.unit}</small> : null}
      </span>
      {tile.line ? <Sparkline {...tile.line} day /> : null}
      {tile.sub ? <span className="reading-sub">{tile.sub}</span> : null}
    </div>
  );
}

/**
 * Cayenne LPP readings, a set of tiles for each channel. The radio's own channel shows its
 * battery as a charge and its processor's temperature as the board's; a channel with voltage
 * and current shows its power first, as their product. `cell` is the battery the radio runs
 * on, when known; someone else's is taken as Li-ion, and its charge said with "≈". A voltage or
 * a current kept through the day draws its line under the number (#55).
 */
export function Readings({
  readings,
  cell,
  from,
  onMap,
  onCopy,
  history,
  onRestart,
  skipBattery = false,
  titled: alwaysTitled = false,
}: {
  readings: LppReading[];
  /** The battery is shown apart, above: channel 1's voltage is left out here. */
  skipBattery?: boolean | undefined;
  /** Each channel named even when there is one. */
  titled?: boolean | undefined;
  cell?: BatteryType | undefined;
  /** Where this radio is, to say how far a GPS reading puts the node. */
  from?: { lat: number; lon: number } | null | undefined;
  /** The node's GPS position on the map. */
  onMap?: (() => void) | undefined;
  /** The GPS position copied. */
  onCopy?: ((text: string) => void) | undefined;
  /** The node's day of voltages and currents, by channel and type, as the session keeps it. */
  history?: Record<string, ReadingSample[]> | undefined;
  /** A day's line started again from its latest reading, the tile held for it. */
  onRestart?: ((line: ReadingLine) => void) | undefined;
}) {
  const units = useUnits();
  if (readings.length === 0) return <InfoRow label={t("radio.readings.none")}>—</InfoRow>;
  const channels = new Map<number, LppReading[]>();
  for (const r of readings) {
    if (skipBattery && r.channel === SELF_CHANNEL && r.type === "voltage") continue;
    channels.set(r.channel, [...(channels.get(r.channel) ?? []), r]);
  }
  const sets = [...channels.entries()].sort((a, b) => a[0] - b[0]);
  if (sets.length === 0) return null;
  const titled = alwaysTitled || sets.length > 1;
  return (
    <Block className="readings">
      {sets.map(([channel, list]) => (
        <div key={channel} className="reading-set">
          {titled ? (
            <div className="reading-set-head">
              <b>{setTitle(channel, list)}</b>
              <span>{t("radio.readings.channel", { channel })}</span>
            </div>
          ) : null}
          <div className="reading-tiles">
            {tilesOf(channel, list, { cell, from, onMap, onCopy, history, units }).map((tile) => (
              <ReadingTile key={tile.id} tile={tile} onRestart={onRestart} />
            ))}
          </div>
        </div>
      ))}
    </Block>
  );
}

/** What a channel holds, named by what it measures. */
function setTitle(channel: number, list: LppReading[]): string {
  if (channel === SELF_CHANNEL) return t("radio.readings.device");
  const has = (type: LppReading["type"]) => list.some((r) => r.type === type);
  if (has("voltage") && has("current")) return t("radio.readings.supply");
  if (has("temperature") || has("humidity") || has("barometer")) return t("radio.readings.air");
  return t("radio.readings.sensor");
}

function tilesOf(
  channel: number,
  list: LppReading[],
  how: {
    cell: BatteryType | undefined;
    from: { lat: number; lon: number } | null | undefined;
    onMap: (() => void) | undefined;
    onCopy: ((text: string) => void) | undefined;
    history: Record<string, ReadingSample[]> | undefined;
    units: Units;
  },
): Tile[] {
  const tiles: Tile[] = [];
  const volts = list.find((r) => r.type === "voltage");
  const amps = list.find((r) => r.type === "current");
  const supply = channel !== SELF_CHANNEL && volts && amps;
  if (supply) {
    const power = list.find((r) => r.type === "power");
    const watts = powerWatts(power ?? { channel, watts: 0 }, list);
    tiles.push({ id: "supply", label: t("radio.readings.power"), ...powerParts(watts), sub: `${voltsText(volts.volts)} × ${ampsText(amps.amps)}`, wide: true });
  }
  list.forEach((r, i) => {
    const id = `${r.type}:${i}`;
    if (supply && r.type === "power") return;
    // A node with no battery has plain volts on its own channel, drawn as any other channel's are.
    if (channel === SELF_CHANNEL && r.type === "voltage" && how.cell !== "none") {
      const type = how.cell ?? "liion";
      const percent = batteryPercent(Math.round(r.volts * 1000), type);
      tiles.push({
        id,
        label: t("radio.readings.battery"),
        value: how.cell ? String(percent) : t("radio.readings.about", { value: percent }),
        unit: t("node.unit.percent"),
        sub: how.cell ? `${voltsText(r.volts)} · ${batteryTypeLabel(how.cell)}` : voltsText(r.volts),
      });
      return;
    }
    if (channel === SELF_CHANNEL && r.type === "temperature") {
      tiles.push({ id, label: t("radio.readings.board"), ...temperatureParts(r.celsius, how.units), sub: t("radio.readings.boardHint") });
      return;
    }
    if (r.type === "gps") {
      tiles.push({ id, ...gpsTile(r, how), wide: true });
      return;
    }
    // The session keeps the first of each type on a channel, the one a supply is made of.
    const kept = (r.type === "voltage" || r.type === "current") && list.find((x) => x.type === r.type) === r;
    tiles.push({ id, label: t(LABELS[r.type]), ...parts(r, how.units), line: kept ? dayLine(how.history?.[`${channel}:${r.type}`], r.type) : undefined, kept: kept ? `${channel}:${r.type}` : undefined });
  });
  return tiles;
}

/** A voltage's or a current's day as a line, in milliamperes while every current in it is under an ampere. */
function dayLine(samples: ReadingSample[] | undefined, type: "voltage" | "current"): Tile["line"] {
  const since = Date.now() - DAY_MS;
  const day = (samples ?? []).filter((s) => s.at > since);
  if (day.length < 2) return undefined;
  const milli = type === "current" && day.every((s) => Math.abs(s.value) < 1);
  return {
    values: day.map((s) => (milli ? Math.round(s.value * 1000) : s.value)),
    times: day.map((s) => s.at),
    unit: t(type === "voltage" ? "node.unit.volt" : milli ? "node.unit.milliampere" : "node.unit.ampere"),
    digits: milli ? 0 : 2,
  };
}

function gpsTile(r: Extract<LppReading, { type: "gps" }>, how: { from: { lat: number; lon: number } | null | undefined; onMap: (() => void) | undefined; onCopy: ((text: string) => void) | undefined }): Omit<Tile, "id"> {
  const placed = hasPosition(r.lat, r.lon);
  const coords = `${num(r.lat, 4)}, ${num(r.lon, 4)}`;
  const away = placed && how.from && hasPosition(how.from.lat, how.from.lon) ? distanceKm(how.from.lat, how.from.lon, r.lat, r.lon) : null;
  const value = away !== null && away > 0.05 ? `${formatDistance(away)} ${compass(bearingDeg(how.from!.lat, how.from!.lon, r.lat, r.lon))}` : coords;
  const action = !placed ? null : how.onMap ? (
    <button type="button" className="link" onClick={how.onMap}>
      {t("radio.readings.onMap")}
    </button>
  ) : how.onCopy ? (
    <button type="button" className="link" onClick={() => how.onCopy!(`${r.lat.toFixed(6)}, ${r.lon.toFixed(6)}`)}>
      {t("radio.readings.copy")}
    </button>
  ) : null;
  return {
    label: t("radio.readings.place"),
    value: placed ? value : t("radio.readings.noFix"),
    sub: placed ? (
      <>
        <span>{t("radio.readings.height", { value: Math.round(r.alt) })}</span>
        {action}
      </>
    ) : undefined,
  };
}

/** A number in the reader's way of writing it: 3,38 in Russian. */
export function numberText(value: number, max: number, min = max): string {
  return num(value, max, min);
}

function num(value: number, max: number, min = max): string {
  return value.toLocaleString(locale(), { minimumFractionDigits: min, maximumFractionDigits: max, useGrouping: false });
}

function voltsText(volts: number): string {
  return `${num(volts, 2)} ${t("node.unit.volt")}`;
}

function ampsText(amps: number): string {
  return Math.abs(amps) < 1 ? `${Math.round(amps * 1000)} ${t("node.unit.milliampere")}` : `${num(amps, 2)} ${t("node.unit.ampere")}`;
}

function powerParts(watts: number): { value: string; unit: string } {
  return Math.abs(watts) < 1 ? { value: String(Math.round(watts * 1000)), unit: t("node.unit.milliwatt") } : { value: num(watts, 2), unit: t("node.unit.watt") };
}

/** A temperature a sensor sent in °C, in the reader's unit (#108). */
function temperatureParts(celsius: number, units: Units): { value: string; unit: string } {
  return { value: num(temperatureIn(celsius, units.temperature), 1, 0), unit: t(temperatureUnitKey(units.temperature)) };
}

/** A reading's number and its unit apart, for a tile; what has no unit of its own reads whole. */
function parts(r: LppReading, units: Units): { value: string; unit?: string } {
  switch (r.type) {
    case "voltage":
      return { value: num(r.volts, 2), unit: t("node.unit.volt") };
    case "current":
      return Math.abs(r.amps) < 1 ? { value: String(Math.round(r.amps * 1000)), unit: t("node.unit.milliampere") } : { value: num(r.amps, 2), unit: t("node.unit.ampere") };
    case "power":
      return powerParts(powerWatts(r, [r]));
    case "temperature":
      return temperatureParts(r.celsius, units);
    case "humidity":
      return { value: num(r.percent, 1, 0), unit: t("node.unit.percent") };
    case "barometer":
      return { value: num(pressureIn(r.hpa, units.pressure), 1), unit: t(pressureUnitKey(units.pressure)) };
    case "luminosity":
      return { value: String(r.lux), unit: t("node.unit.lux") };
    case "percentage":
      return { value: String(r.percent), unit: t("node.unit.percent") };
    case "energy":
      return { value: t("radio.readings.kwh", { value: num(r.kwh, 3) }) };
    case "altitude":
      return { value: t("common.meters", { value: r.meters }) };
    case "distance":
      return { value: t("common.meters", { value: num(r.meters, 3) }) };
    case "concentration":
      return { value: String(r.ppm), unit: "ppm" };
    case "direction":
      return { value: `${r.degrees}°` };
    case "frequency":
      return { value: t("radio.readings.hz", { value: r.hz }) };
    case "gps":
      return { value: `${num(r.lat, 4)}, ${num(r.lon, 4)}` };
    case "accelerometer":
    case "gyrometer":
      return { value: `${r.x}, ${r.y}, ${r.z}` };
    case "colour":
      return { value: `rgb(${r.r}, ${r.g}, ${r.b})` };
    case "unixTime":
      return { value: new Date(r.seconds * 1000).toLocaleString(locale()) };
    case "unknown":
      return { value: t("radio.readings.unknownType", { code: r.code }) };
    default:
      return { value: String((r as { value: number }).value) };
  }
}

/** The readings in a line, for the value of a row that opens them: the power a sensor draws, else the air, else the board. */
export function readingsSummary(readings: LppReading[], units: Units = getUnits()): string | undefined {
  const byChannel = (channel: number) => readings.filter((r) => r.channel === channel);
  const outside = [...new Set(readings.map((r) => r.channel))].filter((c) => c !== SELF_CHANNEL).sort((a, b) => a - b);
  const bits: string[] = [];
  for (const channel of outside) {
    const list = byChannel(channel);
    const volts = list.find((r) => r.type === "voltage");
    const amps = list.find((r) => r.type === "current");
    const temp = list.find((r) => r.type === "temperature");
    if (volts && amps) {
      const p = powerParts(powerWatts({ channel, watts: 0 }, list));
      bits.push(`${p.value} ${p.unit}`);
    } else if (temp?.type === "temperature") {
      const p = temperatureParts(temp.celsius, units);
      bits.push(`${p.value} ${p.unit}`);
    }
  }
  if (bits.length === 0) {
    const board = byChannel(SELF_CHANNEL).find((r) => r.type === "temperature");
    if (board?.type === "temperature") {
      const p = temperatureParts(board.celsius, units);
      bits.push(`${p.value} ${p.unit}`);
    }
  }
  return bits.length ? bits.slice(0, 2).join(" · ") : undefined;
}
