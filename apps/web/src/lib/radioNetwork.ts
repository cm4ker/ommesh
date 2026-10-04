/**
 * The radio's place in the mesh, beside its frequency: whether it repeats for
 * others and how long a hash each repeater writes into the path of what it
 * floods. Both are the firmware's (`companion_radio/MyMesh.cpp`).
 */

import { MAX_PATH_SIZE } from "@meshnet/meshcore";

export interface FreqRange {
  lowerKhz: number;
  upperKhz: number;
}

/**
 * Whether the radio may repeat on `frequencyKhz`. The firmware keeps client
 * repeat to the frequencies set aside for meshes away from the public one and
 * refuses the radio settings that turn it on elsewhere. Without a list from
 * the radio, the radio is left to say.
 */
export function repeatAllowed(frequencyKhz: number, ranges: readonly FreqRange[] | null): boolean {
  if (!ranges) return true;
  return ranges.some((r) => frequencyKhz >= r.lowerKhz && frequencyKhz <= r.upperKhz);
}

/** The frequencies as the field takes them, MHz to the kHz: "433.000, 869.495", a range as "869.400–869.600". */
export function repeatFreqsText(ranges: readonly FreqRange[]): string {
  const mhz = (khz: number) => (khz / 1000).toFixed(3);
  return ranges.map((r) => (r.lowerKhz === r.upperKhz ? mhz(r.lowerKhz) : `${mhz(r.lowerKhz)}–${mhz(r.upperKhz)}`)).join(", ");
}

/** The firmware's path hash modes: 0 to 2, each a hash one byte longer than its number. */
export const HASH_MODES = [0, 1, 2] as const;

/** How many hops a path of `mode`'s hashes holds: 64, 32, 21. */
export function hashHops(mode: number): number {
  return Math.floor(MAX_PATH_SIZE / (mode + 1));
}
