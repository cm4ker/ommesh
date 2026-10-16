import { readSetting, writeSetting } from "./storage.js";

/**
 * The antenna height a node was given in a line of sight, by its key, so the
 * next one between it and anything starts from it.
 */

const KEY = "meshnet.antennas";

export function antennaHeights(): Record<string, number> {
  return readSetting<Record<string, number>>(KEY, {});
}

/** A node's height in metres; null forgets it. */
export function setAntennaHeight(key: string, metres: number | null): void {
  const heights = { ...antennaHeights() };
  if (metres === null) delete heights[key];
  else heights[key] = metres;
  writeSetting(KEY, heights);
}
