import { useSyncExternalStore } from "react";
import { language, locale, subscribeLanguage, type Key } from "../i18n/index.js";
import { readSetting, writeSetting } from "./storage.js";

/**
 * The units the air is shown in (#108): pressure in hectopascals or millimetres
 * of mercury, temperature in degrees Celsius or Fahrenheit. A sensor always
 * sends hPa and °C; only what is drawn changes. Until the reader picks one
 * under Appearance, each follows the language: Russian reads pressure in mm Hg,
 * as its weather forecasts do, and a region that writes °F, the United States
 * first, reads temperature in it.
 */

export type PressureUnit = "hpa" | "mmhg";
export type TemperatureUnit = "c" | "f";

export interface Units {
  pressure: PressureUnit;
  temperature: TemperatureUnit;
}

const PRESSURE_KEY = "meshnet.units.pressure";
const TEMPERATURE_KEY = "meshnet.units.temperature";

/** Millimetres of mercury in a hectopascal: 100 Pa over the 133.322387415 Pa of one. */
export const MMHG_PER_HPA = 100 / 133.322387415;
/** Degrees Fahrenheit in a degree Celsius, for a change of temperature rather than a temperature. */
export const F_PER_C = 1.8;

/** The languages whose weather forecasts give pressure in mm Hg. */
const MMHG_LANGUAGES = new Set(["ru", "uk", "be", "kk"]);
/** Where thermometers read in Fahrenheit: the United States, its territories, and a few beside. */
const FAHRENHEIT_REGIONS = new Set(["US", "PR", "GU", "VI", "AS", "MP", "UM", "BS", "BZ", "KY", "LR", "PW", "FM", "MH"]);

let picked = {
  pressure: oneOf<PressureUnit>(readSetting<unknown>(PRESSURE_KEY, null), ["hpa", "mmhg"]),
  temperature: oneOf<TemperatureUnit>(readSetting<unknown>(TEMPERATURE_KEY, null), ["c", "f"]),
};
let current = resolve();
const listeners = new Set<() => void>();

// What is not picked follows the language, which is known only after the first render's start.
subscribeLanguage(changed);

/** The units drawn now: the ones picked, else the language's. */
export function getUnits(): Units {
  return current;
}

export function useUnits(): Units {
  return useSyncExternalStore(subscribe, getUnits);
}

export function setPressureUnit(unit: PressureUnit): void {
  picked = { ...picked, pressure: unit };
  writeSetting(PRESSURE_KEY, unit);
  changed();
}

export function setTemperatureUnit(unit: TemperatureUnit): void {
  picked = { ...picked, temperature: unit };
  writeSetting(TEMPERATURE_KEY, unit);
  changed();
}

/** A pressure a sensor sent in hPa, in `unit`. */
export function pressureIn(hpa: number, unit: PressureUnit): number {
  return unit === "mmhg" ? hpa * MMHG_PER_HPA : hpa;
}

/** A temperature a sensor sent in °C, in `unit`. */
export function temperatureIn(celsius: number, unit: TemperatureUnit): number {
  return unit === "f" ? celsius * F_PER_C + 32 : celsius;
}

export function pressureUnitKey(unit: PressureUnit): Key {
  return unit === "mmhg" ? "node.unit.mmHg" : "node.unit.hectopascal";
}

export function temperatureUnitKey(unit: TemperatureUnit): Key {
  return unit === "f" ? "node.unit.fahrenheit" : "node.unit.celsius";
}

function resolve(): Units {
  return {
    pressure: picked.pressure ?? (MMHG_LANGUAGES.has(language().split("-")[0]!) ? "mmhg" : "hpa"),
    temperature: picked.temperature ?? (FAHRENHEIT_REGIONS.has(region(locale())) ? "f" : "c"),
  };
}

function changed(): void {
  const next = resolve();
  if (next.pressure === current.pressure && next.temperature === current.temperature) return;
  current = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The region a locale names, "US" for en-US; none for a bare language. */
function region(tag: string): string {
  try {
    return new Intl.Locale(tag).region ?? "";
  } catch {
    return "";
  }
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return allowed.includes(value as T) ? (value as T) : null;
}
