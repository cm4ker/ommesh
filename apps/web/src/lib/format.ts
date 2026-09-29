/** Small formatters shared by the views. */

import { lppTypeName, type LppReading, type SeriesSummary } from "@meshnet/meshcore";
import { locale, t } from "../i18n/index.js";

/*
 * `toLocale*String` with options builds a new `Intl.DateTimeFormat` on every call, a tenth of
 * a millisecond or more on a phone. A list of nodes or a long chat asks for hundreds of dates
 * on each render, so the formats are made once for each language the reader picks.
 */
let formats: { locale: string; clock: Intl.DateTimeFormat; day: Intl.DateTimeFormat; dayOfYear: Intl.DateTimeFormat } | null = null;

function dates() {
  const tag = locale();
  if (formats?.locale !== tag) {
    formats = {
      locale: tag,
      clock: new Intl.DateTimeFormat(tag, { hour: "2-digit", minute: "2-digit" }),
      day: new Intl.DateTimeFormat(tag, { day: "numeric", month: "short" }),
      dayOfYear: new Intl.DateTimeFormat(tag, { day: "numeric", month: "short", year: "numeric" }),
    };
  }
  return formats;
}

export function timeOfDay(unixSeconds: number): string {
  return dates().clock.format(unixSeconds * 1000);
}

export function dayLabel(unixSeconds: number, now = Date.now()): string {
  const date = new Date(unixSeconds * 1000);
  const today = new Date(now);
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (sameDay(date, today)) return t("common.today");
  const yesterday = new Date(now - 86_400_000);
  if (sameDay(date, yesterday)) return t("common.yesterday");
  return (date.getFullYear() === today.getFullYear() ? dates().day : dates().dayOfYear).format(date);
}

/** "just now", "5 min", "3 h", "2 d", or a date for anything older. */
export function ago(ms: number | null, now = Date.now()): string {
  if (!ms) return t("common.never");
  const delta = Math.max(0, now - ms);
  if (delta < 60_000) return t("common.justNow");
  if (delta < 3_600_000) return t("common.minutes", { count: Math.floor(delta / 60_000) });
  if (delta < 86_400_000) return t("common.hours", { count: Math.floor(delta / 3_600_000) });
  if (delta < 7 * 86_400_000) return t("common.days", { count: Math.floor(delta / 86_400_000) });
  return dates().day.format(ms);
}

/** A stretch of time in seconds, either way: "40 s", "5 min", "3 h", "2 d". */
export function span(seconds: number): string {
  const s = Math.abs(Math.round(seconds));
  if (s < 60) return t("common.seconds", { count: s });
  if (s < 3600) return t("common.minutes", { count: Math.round(s / 60) });
  if (s < 86_400) return t("common.hours", { count: Math.round(s / 3600) });
  return t("common.days", { count: Math.round(s / 86_400) });
}

/** The day with its year, whatever year it is: "15 May 2024". */
export function fullDate(unixSeconds: number): string {
  return dates().dayOfYear.format(unixSeconds * 1000);
}

export function frequency(khz: number): string {
  return t("common.megahertz", { value: (khz / 1000).toFixed(3) });
}

export function bandwidth(hz: number): string {
  return t("common.kilohertz", { value: (hz / 1000).toFixed(hz % 1000 === 0 ? 0 : 2) });
}

export function shortKey(hex: string, n = 6): string {
  return hex.slice(0, n * 2);
}

export function initials(name: string): string {
  // Letters and digits only: "Bob (bike)" is BB, not "B(".
  const words = name
    .split(/\s+/)
    .map((w) => w.replace(/[^\p{L}\p{N}]/gu, ""))
    .filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return (words[0]![0]! + words[1]![0]!).toUpperCase();
}

const graphemes = typeof Intl !== "undefined" && "Segmenter" in Intl ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;

/**
 * The emoji a name ends with, "Fox 🦊" gives "🦊", for the node's circle as
 * the official app draws it; null when it ends otherwise. A symbol drawn as
 * text by default, such as "©", does not count unless it asks to be an emoji.
 */
export function trailingEmoji(name: string): string | null {
  const text = name.trimEnd();
  if (!text || !graphemes) return null;
  let last = "";
  for (const { segment } of graphemes.segment(text)) last = segment;
  return isEmoji(last) ? last : null;
}

/** One grapheme drawn as an emoji: a flag, a keycap, or a picture that is not text by default. */
function isEmoji(segment: string): boolean {
  if (/\p{Regional_Indicator}/u.test(segment) || segment.includes("\u20E3")) return true;
  return /\p{Extended_Pictographic}/u.test(segment) && (/\p{Emoji_Presentation}/u.test(segment) || segment.includes("\uFE0F"));
}

/**
 * How many emoji a message is when it is nothing else, one to three, as a
 * chat draws those large without a bubble (#41); 0 for anything with a
 * letter, a digit or a fourth emoji in it. Spaces between them do not count.
 */
export function emojiOnly(text: string): number {
  if (!graphemes) return 0;
  let count = 0;
  for (const { segment } of graphemes.segment(text)) {
    if (/^\s+$/u.test(segment)) continue;
    if (!isEmoji(segment) || ++count > 3) return 0;
  }
  return count;
}

/** A stable hue from a name, for the swatch behind its initials. */
export function hue(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return h % 360;
}

export function battery(mv: number): string {
  return t("common.volts", { value: (mv / 1000).toFixed(2) });
}

/** What a cell is made of. The radio reports only its voltage. */
export type BatteryType = "liion" | "lifepo4";

/**
 * A cell's resting voltage, mV, at 100%, 90% … 0%. Charge is not linear in
 * voltage: LiFePO4 sits near 3.3 V for most of its charge, so a straight line
 * from empty to full reads a full one as nearly empty.
 */
const BATTERY_CURVES: Record<BatteryType, readonly number[]> = {
  liion: [4190, 4050, 3990, 3890, 3800, 3720, 3650, 3580, 3530, 3420, 3100],
  lifepo4: [3400, 3350, 3320, 3290, 3270, 3260, 3250, 3230, 3200, 3120, 3000],
};

/** A cell's charge from its voltage, straight between the curve's points; rough, and honest about it. */
export function batteryPercent(mv: number, type: BatteryType = "liion"): number {
  const curve = BATTERY_CURVES[type];
  const step = 100 / (curve.length - 1);
  if (mv >= curve[0]!) return 100;
  for (let i = 1; i < curve.length; i++) {
    const low = curve[i]!;
    if (mv < low) continue;
    const high = curve[i - 1]!;
    return Math.round(100 - i * step + ((mv - low) / (high - low)) * step);
  }
  return 0;
}

/** At or below this charge a cell wants charging soon, whatever it is made of. */
export const LOW_CHARGE_PERCENT = 20;

/**
 * Whether a cell is low, judged by its charge on the curve of what it is made of (#31): a fixed
 * voltage made for Li-ion calls every LiFePO4 flat. No reading is not low.
 */
export function lowCharge(mv: number, type: BatteryType = "liion"): boolean {
  return mv > 0 && batteryPercent(mv, type) <= LOW_CHARGE_PERCENT;
}

/**
 * The share of what a radio heard that it could not make out, in percent: its receive errors
 * over everything it heard, the errors included. None when it has no error to speak of.
 */
export function errorShare(errors: number, received: number): number | null {
  return errors > 0 ? (errors / (errors + received)) * 100 : null;
}

export function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** "just now", "12 min ago", "3 h ago": `ago` as it reads after a verb. */
export function agoPhrase(ms: number | null, now = Date.now()): string {
  const text = ago(ms, now);
  return !ms || now - ms < 60_000 || now - ms >= 7 * 86_400_000 ? text : t("common.ago", { time: text });
}

/**
 * A power reading's watts. The firmware sends power in whole watts (LPP_POWER), so a sensor
 * drawing 0.4 W says 0; when its channel also carries voltage and current, their product is
 * the finer figure.
 */
export function powerWatts(reading: { channel: number; watts: number }, readings: readonly LppReading[]): number {
  let volts: number | null = null;
  let amps: number | null = null;
  for (const r of readings) {
    if (r.channel !== reading.channel) continue;
    if (r.type === "voltage") volts = r.volts;
    else if (r.type === "current") amps = r.amps;
  }
  return volts !== null && amps !== null ? volts * amps : reading.watts;
}

/**
 * A power series, which comes in whole watts too, so a sensor drawing 0.4 W reads 0 all through.
 * With voltage and current on its channel, their product stands in: the means multiplied for the
 * mean, the lows and the highs for the ends, which bound the range rather than measure it.
 */
export function powerSummary(summary: SeriesSummary, series: readonly SeriesSummary[]): SeriesSummary {
  const on = (type: LppReading["type"]) => series.find((s) => s.channel === summary.channel && lppTypeName(s.lppType) === type);
  const volts = on("voltage");
  const amps = on("current");
  if (!volts || !amps) return summary;
  return { ...summary, min: volts.min * amps.min, max: volts.max * amps.max, avg: volts.avg * amps.avg };
}
