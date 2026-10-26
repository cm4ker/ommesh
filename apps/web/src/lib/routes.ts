/** How the views talk about a contact's route and its time limit. */

import { contactHops, type ContactRecord } from "@meshnet/meshcore";
import { useEffect, useState } from "react";
import { t } from "../i18n/index.js";
import { session } from "./session.js";

/** The time limits offered for a learned route, in minutes; null keeps it. */
export const ROUTE_LIMITS: (number | null)[] = [null, 5, 15, 30, 60];

export function limitLabel(minutes: number | null): string {
  if (minutes === null) return t("tools.limit.never");
  if (minutes === 60) return t("tools.limit.hour");
  return t("common.minutes", { count: minutes });
}

/** `<select>` values: "default", "never", or minutes. */
export function limitValue(minutes: number | null | undefined): string {
  return minutes === undefined ? "default" : minutes === null ? "never" : String(minutes);
}

export function parseLimit(value: string): number | null | undefined {
  return value === "default" ? undefined : value === "never" ? null : Number(value);
}

/** "in 3 min", "in 1 h 5 min"; never less than a minute, so a countdown does not read zero. */
export function inMinutes(ms: number): string {
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  if (minutes < 60) return t("tools.in.minutes", { minutes });
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? t("tools.in.hoursMinutes", { hours: h, minutes: m }) : t("tools.in.hours", { hours: h });
}

/** The chat header's line about a contact's route. */
export function routeSubtitle(contact: ContactRecord, now: number): { text: string; tone: "" | "pinned" | "soon" } {
  if (session.routePolicy(contact.key).flood) return { text: t("tools.routeSub.pinned"), tone: "pinned" };
  if (contact.outPathLen === 0xff) return { text: t("tools.routeSub.none"), tone: "" };
  const hops = contact.outPathLen & 63;
  const lead = hops === 0 ? t("tools.routeSub.direct") : t("tools.hops", { count: hops });
  const expires = session.routeExpiresAt(contact.key);
  if (expires === null) return { text: lead, tone: "" };
  const left = expires - now;
  return { text: t("tools.routeSub.drops", { route: lead, when: inMinutes(left) }), tone: left <= 3 * 60_000 ? "soon" : "" };
}

/** The clock, ticking every `ms`, for countdowns. */
export function useNow(ms = 15_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return now;
}

/** A contact's route in a few words, for under a name: how the next message goes. */
export function routeWords(contact: ContactRecord): { text: string; tone: "" | "pinned" | "none" } {
  if (session.routePolicy(contact.key).flood) return { text: t("tools.routeWords.pinned"), tone: "pinned" };
  const hops = contactHops(contact);
  if (hops === null) return { text: t("tools.routeWords.none"), tone: "none" };
  if (hops === 0) return { text: t("tools.routeWords.direct"), tone: "" };
  return { text: t("tools.viaRelays", { count: hops }), tone: "" };
}
