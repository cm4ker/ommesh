/**
 * What a sensor is asked to send by itself (MeshCore 1.18): which of its
 * readings, and how far each must move first. The sensor keeps fourteen
 * bytes of thresholds, so three readings at most, usually.
 */

import { PUSH_THRESHOLD_BYTES, thresholdBytes, type LppReading, type PushableType, type PushThreshold } from "@meshnet/meshcore";
import { locale, t, type Key } from "../i18n/index.js";

/** The thresholds offered per kind of reading, the default second, and the unit they are said in. */
const STEPS: Partial<Record<PushableType, { values: number[]; unit: Key | null }>> = {
  temperature: { values: [0.2, 0.5, 1, 2], unit: "node.unit.celsius" },
  humidity: { values: [1, 2, 5, 10], unit: "node.unit.percent" },
  barometer: { values: [0.5, 1, 2, 5], unit: "node.unit.hectopascal" },
  luminosity: { values: [10, 50, 100, 500], unit: "node.unit.lux" },
  power: { values: [1, 5, 10, 50], unit: "node.unit.watt" },
  current: { values: [0.01, 0.05, 0.1, 0.5], unit: "node.unit.ampere" },
  voltage: { values: [0.02, 0.05, 0.1, 0.2], unit: "node.unit.volt" },
  percentage: { values: [1, 5, 10, 20], unit: "node.unit.percent" },
  analogIn: { values: [0.1, 0.5, 1, 5], unit: null },
};

/** The order readings are offered and chosen in: the air's first, the sensor's own battery last. */
const ORDER = Object.keys(STEPS) as PushableType[];

/** The channel the firmware gives the node itself: its battery, and its processor's temperature. */
const SELF_CHANNEL = 1;

export interface PushTarget {
  channel: number;
  type: PushableType;
}

const same = (a: PushTarget, b: PushTarget) => a.channel === b.channel && a.type === b.type;

/**
 * The readings a threshold can go on, from the sensor's last telemetry, in
 * the order they are offered: the sensor's own channel only for its battery,
 * since its processor's temperature says nothing about the air.
 */
export function pushTargets(readings: LppReading[]): PushTarget[] {
  const found: PushTarget[] = [];
  for (const r of readings) {
    if (!(r.type in STEPS)) continue;
    const target = { channel: r.channel, type: r.type as PushableType };
    if (r.channel === SELF_CHANNEL && target.type !== "voltage") continue;
    if (!found.some((f) => same(f, target))) found.push(target);
  }
  const rank = (p: PushTarget) => (p.channel === SELF_CHANNEL ? 100 : 0) + ORDER.indexOf(p.type);
  return found.sort((a, b) => rank(a) - rank(b) || a.channel - b.channel);
}

export function thresholdSteps(type: PushableType): number[] {
  return STEPS[type]?.values ?? [];
}

/** "0.5 °C", in the reader's number format. */
export function deltaLabel(type: PushableType, value: number): string {
  const unit = STEPS[type]?.unit;
  const n = value.toLocaleString(locale(), { maximumFractionDigits: 2 });
  return unit ? `${n} ${t(unit)}` : n;
}

/** Whether one more threshold on `target` still fits beside `chosen` in what the sensor keeps. */
export function fits(chosen: PushThreshold[], target: PushTarget): boolean {
  const used = chosen.filter((c) => !same(c, target)).reduce((sum, c) => sum + thresholdBytes(c.type), 0);
  return used + thresholdBytes(target.type) <= PUSH_THRESHOLD_BYTES;
}

/** The thresholds a sensor starts with: each reading in order, at its second step, while they fit. */
export function defaultThresholds(readings: LppReading[]): PushThreshold[] {
  const chosen: PushThreshold[] = [];
  for (const target of pushTargets(readings)) {
    if (!fits(chosen, target)) continue;
    chosen.push({ ...target, delta: thresholdSteps(target.type)[1]! });
  }
  return chosen;
}

/** `chosen` with the threshold on `target` set to `delta`, or taken off with null; the order kept. */
export function withThreshold(chosen: PushThreshold[], target: PushTarget, delta: number | null): PushThreshold[] {
  const at = chosen.findIndex((c) => same(c, target));
  if (delta === null) return chosen.filter((_, i) => i !== at);
  if (at >= 0) return chosen.map((c, i) => (i === at ? { ...c, delta } : c));
  return [...chosen, { ...target, delta }];
}
