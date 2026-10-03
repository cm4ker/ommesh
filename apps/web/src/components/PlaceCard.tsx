/**
 * A place in a chat: a picture of the map round it with a pin, or a circle
 * with no pin for a rough one, and under it how far it is and which way from
 * where you are. With no tile to be had, an arrow and the distance stand in
 * for the picture: a mesh is often used with no network.
 */

import { useState, useSyncExternalStore } from "react";
import { bearingDeg, distanceKm, formatDistance, formatRoundDistance } from "../lib/geo.js";
import { getPhoneState, subscribePhone } from "../lib/phonePosition.js";
import { tileMetresPerPixel, zoomToFit, type Place } from "../lib/place.js";
import { radioPosition } from "../lib/placeDraft.js";
import { radioHasGps } from "../lib/followPhone.js";
import { useSelector } from "../lib/session.js";
import { TileSnap } from "./TileSnap.js";
import { t } from "../i18n/index.js";

/** A fix this old is still where the phone was a moment ago, near enough to measure from. */
const RECENT_FIX_MS = 10 * 60_000;

const PIC_HEIGHT = 128;

/** Where distances are measured from: the phone, if it said lately, else this radio. */
export function useWhereIAm(): { lat: number; lon: number } | null {
  const phone = useSyncExternalStore(subscribePhone, getPhoneState).fix;
  // As text, so the store hands back the same value while the radio stays put.
  const radio = useSelector((s) => {
    const at = radioPosition(s.self, s.telemetry["self"]?.readings, radioHasGps(s.self?.key));
    return at ? `${at.lat},${at.lon}` : "";
  });
  if (phone && Date.now() - phone.at <= RECENT_FIX_MS) return { lat: phone.lat, lon: phone.lon };
  if (!radio) return null;
  const [lat, lon] = radio.split(",").map(Number);
  return { lat: lat!, lon: lon! };
}

/** The side of the world a bearing points to, as a word. */
const SIDES = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"] as const;
function sideOf(deg: number): string {
  return t(`chats.place.side.${SIDES[Math.round(deg / 45) % 8]!}`);
}

/** What a place is from here, in words: "2.4 km · north-east", "Near you", "Your place". */
export function placeWords(place: Place, me: { lat: number; lon: number } | null, mine: boolean): { head: string; side: string; sub: string } {
  const sub = place.rough ? t("chats.place.roughWithin", { distance: formatRoundDistance((place.u ?? 1000) / 1000) }) : place.u !== null && place.u > 20 ? t("chats.place.accuracy", { metres: Math.round(place.u) }) : "";
  if (!me) return { head: `${place.lat.toFixed(place.rough ? 2 : 5)}, ${place.lon.toFixed(place.rough ? 2 : 5)}`, side: "", sub };
  const km = distanceKm(me.lat, me.lon, place.lat, place.lon);
  const near = Math.max(place.u ?? 0, place.rough ? 0 : 50) / 1000;
  if (km <= near) return { head: mine ? t("chats.place.yours") : t("chats.place.near"), side: "", sub };
  return { head: (place.rough ? "≈ " : "") + formatDistance(km), side: sideOf(bearingDeg(me.lat, me.lon, place.lat, place.lon)), sub };
}

/** The pin over a picture, its point on the place. */
export function PlacePin() {
  return (
    <svg className="place-pin" viewBox="-12 -31 24 31" aria-hidden="true">
      <path d="M0 0c-8-10-12-15-12-21a12 12 0 1 1 24 0c0 6-4 11-12 21z" />
      <circle cy="-21" r="4.2" />
    </svg>
  );
}

/** The map round a place, or the way to it when there is no map to be had. */
export function PlacePicture({ place, me, height = PIC_HEIGHT }: { place: Place; me: { lat: number; lon: number } | null; height?: number }) {
  const [none, setNone] = useState(false);
  const radius = place.rough ? (place.u ?? 1000) : 0;
  const zoom = place.rough ? zoomToFit(place.lat, radius, height * 0.38) : 15;
  const circle = radius / tileMetresPerPixel(place.lat, zoom);
  if (none) {
    const deg = me ? bearingDeg(me.lat, me.lon, place.lat, place.lon) : null;
    return (
      <div className="place-way" style={{ height }} aria-hidden="true">
        {deg === null ? (
          <PlacePin />
        ) : (
          <svg viewBox="0 0 56 56" width="64" height="64">
            <circle cx="28" cy="28" r="22" className="place-way-ring" />
            <path d="M28 2v6" className="place-way-north" />
            <path d="M28 10l8 23-8-6-8 6z" className="place-way-arrow" transform={`rotate(${deg.toFixed(0)} 28 28)`} />
          </svg>
        )}
      </div>
    );
  }
  return (
    <div className="place-pic" style={{ height }}>
      <TileSnap lat={place.lat} lon={place.lon} zoom={zoom} onNone={() => setNone(true)}>
        {place.rough ? <span className="place-area" style={{ width: circle * 2, height: circle * 2 }} /> : <PlacePin />}
      </TileSnap>
    </div>
  );
}

/** A place in a message's bubble: the picture, then how far it is and which way, and how sure. */
export function PlaceBody({ place, mine }: { place: Place; mine: boolean }) {
  const me = useWhereIAm();
  const words = placeWords(place, me, mine);
  return (
    <>
      <PlacePicture place={place} me={me} />
      <span className="place-line">
        <b>{words.head}</b>
        {words.side ? ` · ${words.side}` : ""}
      </span>
      {words.sub ? <span className="place-sub">{words.sub}</span> : null}
    </>
  );
}