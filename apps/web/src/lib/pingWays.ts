/**
 * What the ping beside a route can do with a node, in words: the ways it can
 * go and why one cannot, the route in a word or two, and which of the
 * answers is the newest. Pure, for components/tools/RoutePing.tsx.
 *
 * The firmware decides most of it. A trace is passed on only by a repeater
 * (rooms and sensors have forwarding off, and a person's radio relays only
 * with "Repeat" on), so a trace to anyone else turns at the last relay. A
 * flood is answered by a repeater or a room only once this radio has signed
 * in, and by a person only when they let it read their readings. A message
 * a person's radio always acknowledges.
 */

import { AdvType, type ContactRecord } from "@meshnet/meshcore";
import { t } from "../i18n/index.js";

export type PingWay = "route" | "direct" | "flood" | "message";

export interface WayChoice {
  way: PingWay;
  label: string;
  /** What it does, or why it cannot. */
  hint: string;
  disabled: boolean;
}

/**
 * The ways `contact` can be pinged. `relays` names the relays of the route
 * the radio holds, nearest first; null when it holds none. `signedIn` is
 * whether a repeater or a room has let this radio in.
 */
export function wayChoices(contact: ContactRecord, relays: string[] | null, signedIn: boolean): WayChoice[] {
  const repeater = contact.type === AdvType.Repeater;
  const person = contact.type === AdvType.Chat;
  const choices: WayChoice[] = [];

  const last = relays?.at(-1);
  const along =
    relays === null
      ? { hint: t("tools.quick.hint.routeUnknown"), disabled: false }
      : relays.length === 0
        ? repeater
          ? { hint: t("tools.quick.hint.routeDirect"), disabled: false }
          : { hint: t("tools.quick.nothingBetween"), disabled: true }
        : repeater || !last
          ? { hint: t("tools.quick.hint.routeVia", { count: relays.length }), disabled: false }
          : { hint: t("tools.quick.hint.routeUpTo", { name: last }), disabled: false };
  choices.push({ way: "route", label: t("tools.quick.way.route"), ...along });

  choices.push({
    way: "direct",
    label: t("tools.quick.way.direct"),
    hint: repeater ? t("tools.quick.hint.direct") : person ? t("tools.quick.hint.directPerson") : t("tools.quick.hint.directOnlyRepeaters"),
    disabled: !repeater,
  });

  const needsSignIn = (repeater || contact.type === AdvType.Room) && !signedIn;
  choices.push({
    way: "flood",
    label: t("tools.quick.way.flood"),
    hint: needsSignIn ? t("tools.quick.hint.floodSignIn") : person ? t("tools.quick.hint.floodPerson") : t("tools.quick.hint.flood"),
    disabled: needsSignIn,
  });

  if (person) choices.push({ way: "message", label: t("tools.quick.way.message"), hint: t("tools.quick.hint.message"), disabled: false });
  return choices;
}

/** The route in a word or two, for its row: how many relays, or straight, or the whole mesh. */
export function routeShort(hops: number | null, flood: boolean): string {
  if (flood || hops === null) return t("tools.quick.short.flood");
  if (hops === 0) return t("tools.quick.short.direct");
  return t("tools.quick.short.relays", { count: hops });
}

/** Which way's answer to show: the one asked last. `at` is when each was asked, absent or null when never. */
export function newestWay(at: Partial<Record<PingWay, number | null>>): PingWay | null {
  let best: PingWay | null = null;
  for (const way of ["route", "direct", "flood", "message"] as const) {
    const when = at[way];
    if (when !== undefined && when !== null && (best === null || when > at[best]!)) best = way;
  }
  return best;
}

/** How many pings at the end of the row stayed silent. */
export function lostInARow(runs: readonly { ok: boolean }[]): number {
  let n = 0;
  for (let i = runs.length - 1; i >= 0 && !runs[i]!.ok; i--) n++;
  return n;
}

/** A time an answer took: in milliseconds under a second, in seconds after. */
export function tookText(ms: number): string {
  return ms < 1000 ? t("tools.unit.ms", { value: Math.round(ms) }) : t("tools.unit.s", { value: (ms / 1000).toFixed(1) });
}
