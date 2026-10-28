import { useSyncExternalStore } from "react";
import { t, type Key } from "../i18n/index.js";
import type { BatteryType } from "./format.js";
import { readSetting, writeSetting } from "./storage.js";

/**
 * What each node's cell is made of (#26), by the node's public key. A node
 * reports only volts and the firmware has no setting for the cell, so the
 * app keeps it and turns the volts into a percent with it. A node nobody
 * picked a cell for reads as Li-ion, and its charge is said with "≈". A node
 * marked as having no battery (#107) shows its volts, never a charge, and is
 * never called low.
 */

const KEY = "meshnet.batteryTypes";

/**
 * The chemistries by their names, which read the same in every language; the straight count and
 * no battery at all are words, so their names are keys, as the hints are.
 */
export const BATTERY_TYPES: { value: BatteryType; label?: string; name?: Key; hint: Key }[] = [
  { value: "liion", label: "Li-ion / LiPo", hint: "radio.battery.liionHint" },
  { value: "linear", name: "radio.battery.linear", hint: "radio.battery.linearHint" },
  { value: "lifepo4", label: "LiFePO4", hint: "radio.battery.lifepo4Hint" },
  { value: "naion", label: "Na-ion", hint: "radio.battery.naionHint" },
  { value: "lto2s", label: "LTO 2S", hint: "radio.battery.lto2sHint" },
  { value: "none", name: "radio.battery.none", hint: "radio.battery.noneHint" },
];

function restore(saved: unknown): Record<string, BatteryType> {
  if (!saved || typeof saved !== "object") return {};
  const types: Record<string, BatteryType> = {};
  for (const [key, type] of Object.entries(saved)) {
    const known = BATTERY_TYPES.find((t) => t.value === type);
    if (known) types[key] = known.value;
  }
  return types;
}

let types = restore(readSetting<unknown>(KEY, null));
const listeners = new Set<() => void>();

export function batteryType(radioKey: string | undefined): BatteryType {
  return (radioKey && types[radioKey]) || "liion";
}

export function batteryTypeLabel(type: BatteryType): string {
  const known = BATTERY_TYPES.find((b) => b.value === type);
  return known?.name ? t(known.name) : (known?.label ?? type);
}

/** A node's cell; null forgets it, and the node reads as Li-ion again. */
export function setBatteryType(radioKey: string, type: BatteryType | null): void {
  const next = { ...types };
  if (type) next[radioKey] = type;
  else delete next[radioKey];
  types = next;
  writeSetting(KEY, types);
  for (const listener of listeners) listener();
}

/** Every cell picked so far, by node key. */
export function batteryTypes(): Readonly<Record<string, BatteryType>> {
  return types;
}

export function useBatteryType(radioKey: string | undefined): BatteryType {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => batteryType(radioKey),
  );
}

/** Every cell picked so far, by node key, for a list that judges many nodes' batteries at once. */
export function useBatteryTypes(): Readonly<Record<string, BatteryType>> {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => types,
  );
}

/** The cell someone picked for this node, or null when nobody has. */
export function useChosenBatteryType(radioKey: string | undefined): BatteryType | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => (radioKey && types[radioKey]) || null,
  );
}
