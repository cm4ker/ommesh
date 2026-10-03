/**
 * A place in the message field. The pin of an empty field puts one there: the
 * field opens up over the text with a picture of the map and two rows of
 * buttons, where it comes from and how exactly it goes. Typing folds it into a
 * bar above the text, as a reply sits; a tap on the bar opens it again. The
 * field's own arrow sends the place with the text, so there is one way to send.
 *
 * While a place from the phone is in the field, the phone keeps saying where
 * it is, and the place follows; from a radio with GPS, the radio is asked once.
 */

import { useEffect, useRef, useState } from "react";
import { hasPosition } from "../lib/geo.js";
import { radioHasGps } from "../lib/followPhone.js";
import { canLocate, getPhoneState, locateOnce, locateText, usePhone } from "../lib/phonePosition.js";
import { placeText, roughPoint, ROUGH_M, tileMetresPerPixel, zoomToFit } from "../lib/place.js";
import { firstSource, radioPosition, sendsRough, setPlace, startsRough, updatePlace, type PlaceDraft } from "../lib/placeDraft.js";
import { pickPlace } from "../lib/nav.js";
import { isCapacitor, touchFirst } from "../lib/platform.js";
import { session, useSelector } from "../lib/session.js";
import { toast } from "../lib/toast.js";
import { utf8Length } from "../lib/format.js";
import { CloseIcon } from "./Icons.js";
import { PlacePin } from "./PlaceCard.js";
import { TileSnap } from "./TileSnap.js";
import { t } from "../i18n/index.js";

/** This radio's position as text, so the store hands back the same value while it stays put. */
function useRadioAt(): { lat: number; lon: number } | null {
  const text = useSelector((s) => {
    const at = radioPosition(s.self, s.telemetry["self"]?.readings, radioHasGps(s.self?.key));
    return at ? `${at.lat},${at.lon}` : "";
  });
  if (!text) return null;
  const [lat, lon] = text.split(",").map(Number);
  return { lat: lat!, lon: lon! };
}

/** The text a place goes as. */
export function placeLine(place: PlaceDraft): string {
  return placeText(place.lat, place.lon, sendsRough(place), place.source === "phone" ? place.accuracy : null);
}

/** Whether the place knows where it is yet: a phone just asked may not. */
export const placeReady = (place: PlaceDraft): boolean => hasPosition(place.lat, place.lon);

/** The pin of an empty field: a place put in, from the best source there is, or the map to put one by hand. */
export function attachPlace(radio: string, conversation: string, many: boolean): void {
  const state = session.getState();
  const gps = radioHasGps(state.self?.key) === true;
  const radioAt = radioPosition(state.self, state.telemetry["self"]?.readings, gps);
  const { fix } = getPhoneState();
  const source = firstSource({ fix, canLocate: canLocate(), radio: radioAt, radioGps: gps, now: Date.now() });
  const rough = startsRough(radio, conversation, many);
  if (source === null) {
    // Nothing here knows where it is: the point goes on the map by hand.
    pickPlace(conversation);
    return;
  }
  if (source === "radio" && gps) void session.requestTelemetry().catch(() => undefined);
  const at = source === "phone" ? fix : radioAt;
  setPlace(radio, conversation, { source, lat: at?.lat ?? 0, lon: at?.lon ?? 0, accuracy: source === "phone" ? (fix?.accuracy ?? null) : null, rough, open: true });
}

/** Keeps a place from the phone or the radio where they are while it is in the field. */
export function usePlaceFollow(radio: string, conversation: string, place: PlaceDraft | null): void {
  const fromPhone = place?.source === "phone";
  const { fix } = usePhone(fromPhone);
  const radioAt = useRadioAt();
  const asked = useRef(false);

  // A phone that has not said where it is lately is asked, once for each place put from it.
  useEffect(() => {
    if (!fromPhone) {
      asked.current = false;
      return;
    }
    if (asked.current) return;
    asked.current = true;
    const now = getPhoneState().fix;
    if (now && Date.now() - now.at < 60_000) return;
    locateOnce().catch((error: unknown) => {
      toast(locateText(error), "error");
      // The radio stands in when it knows where it is; else the point goes on the map by hand.
      if (radioAt) updatePlace(radio, conversation, { source: "radio", lat: radioAt.lat, lon: radioAt.lon, accuracy: null });
      else pickPlace(conversation);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fromPhone]);

  useEffect(() => {
    if (!place) return;
    if (place.source === "phone" && fix && (fix.lat !== place.lat || fix.lon !== place.lon || fix.accuracy !== place.accuracy)) updatePlace(radio, conversation, { lat: fix.lat, lon: fix.lon, accuracy: fix.accuracy });
    else if (place.source === "radio" && radioAt && (radioAt.lat !== place.lat || radioAt.lon !== place.lon)) updatePlace(radio, conversation, { lat: radioAt.lat, lon: radioAt.lon });
  }, [place, fix, radioAt, radio, conversation]);
}

/** The picture of the place in the field: a pin, or the circle a rough place goes as with a cross where you are. */
function PlaceThumb({ place, height }: { place: PlaceDraft; height: number }) {
  const { problem } = usePhone(false);
  // Still looking for the phone, or the phone would not say: a spinner, or the pin alone.
  if (!placeReady(place)) return <span className="place-wait">{problem ? <PlacePin /> : <span className="spinner" />}</span>;
  const rough = sendsRough(place);
  const centre = rough ? roughPoint(place.lat, place.lon) : place;
  const zoom = rough ? zoomToFit(centre.lat, ROUGH_M, height * 0.4) : height > 60 ? 16 : 14;
  const metresPerPx = tileMetresPerPixel(centre.lat, zoom);
  const circle = ROUGH_M / metresPerPx;
  // Where you are inside the circle, from its middle.
  const dx = rough ? ((place.lon - centre.lon) * 111_320 * Math.cos((centre.lat * Math.PI) / 180)) / metresPerPx : 0;
  const dy = rough ? (-(place.lat - centre.lat) * 110_574) / metresPerPx : 0;
  return (
    <TileSnap lat={centre.lat} lon={centre.lon} zoom={zoom}>
      {rough ? (
        <>
          <span className="place-area" style={{ width: circle * 2, height: circle * 2 }} />
          {height > 60 ? <span className="place-cross" style={{ transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))` }} /> : null}
        </>
      ) : (
        <PlacePin />
      )}
    </TileSnap>
  );
}

/** The place open over the text: the map, where it comes from, how exactly it goes. */
export function PlacePanel({ radio, conversation, place }: { radio: string; conversation: string; place: PlaceDraft }) {
  const { problem } = usePhone(false);
  const radioAt = useRadioAt();
  const phoneShut = problem === "denied" || problem === "off";
  const [height] = useState(132);
  const drop = () => setPlace(radio, conversation, null);
  const from = (source: PlaceDraft["source"]) => {
    if (source === "point") return pickPlace(conversation);
    if (source === "phone") {
      const fix = getPhoneState().fix;
      updatePlace(radio, conversation, { source, ...(fix ? { lat: fix.lat, lon: fix.lon, accuracy: fix.accuracy } : {}) });
      if (phoneShut) locateOnce().catch((error: unknown) => toast(locateText(error), "error"));
      return;
    }
    if (!radioAt) return toast(t("mesh.spot.noPosition"), "error");
    if (radioHasGps(session.getState().self?.key)) void session.requestTelemetry().catch(() => undefined);
    updatePlace(radio, conversation, { source, lat: radioAt.lat, lon: radioAt.lon, accuracy: null });
  };
  return (
    <div className="place-panel-in">
      <div className="place-snap" role="button" tabIndex={0} aria-label={t("chats.place.point")} style={{ height }} onClick={() => pickPlace(conversation)} onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && pickPlace(conversation)}>
        <PlaceThumb place={place} height={height} />
        <button
          type="button"
          className="compose-bar-close place-drop"
          aria-label={t("chats.place.remove")}
          onClick={(e) => {
            e.stopPropagation();
            drop();
          }}
        >
          <CloseIcon size={14} />
        </button>
      </div>
      <div className="segmented" role="group" aria-label={t("chats.place.from")}>
        {canLocate() ? (
          <button type="button" className={place.source === "phone" ? "on" : ""} aria-pressed={place.source === "phone"} aria-disabled={phoneShut} onClick={() => from("phone")}>
            {isCapacitor() || touchFirst() ? t("chats.place.phone") : t("chats.place.device")}
          </button>
        ) : null}
        <button type="button" className={place.source === "radio" ? "on" : ""} aria-pressed={place.source === "radio"} aria-disabled={!radioAt} onClick={() => from("radio")}>
          {t("chats.place.radio")}
        </button>
        <button type="button" className={place.source === "point" ? "on" : ""} aria-pressed={place.source === "point"} onClick={() => from("point")}>
          {t("chats.place.point")}
        </button>
      </div>
      {/* A point put by hand is a place, not the writer: it goes exactly, with nothing to choose. */}
      {place.source !== "point" ? (
        <div className="segmented" role="group" aria-label={t("chats.place.how")}>
          <button type="button" className={!place.rough ? "on" : ""} aria-pressed={!place.rough} onClick={() => updatePlace(radio, conversation, { rough: false })}>
            {t("chats.place.exact")}
          </button>
          <button type="button" className={place.rough ? "on" : ""} aria-pressed={place.rough} onClick={() => updatePlace(radio, conversation, { rough: true })}>
            {t("chats.place.rough")}
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** The place folded above the text: a thumb of the map, what it is, what it adds to the message. */
export function PlaceBar({ radio, conversation, place, onOpen }: { radio: string; conversation: string; place: PlaceDraft; onOpen: () => void }) {
  const rough = sendsRough(place);
  const sub = rough ? t("chats.place.roughShort") : place.source === "phone" && place.accuracy !== null ? t("chats.place.exactWithin", { metres: Math.round(place.accuracy) }) : t("chats.place.exactShort");
  return (
    <div className="compose-bar place-bar" role="button" tabIndex={0} aria-label={t("chats.place.open")} onClick={onOpen} onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onOpen()}>
      <span className="place-bar-thumb">
        <PlaceThumb place={place} height={40} />
      </span>
      <span className="compose-bar-text place-bar-text">
        <b>{place.source === "point" ? t("chats.place.pointed") : t("chats.place.yours")}</b>
        <small>{sub}</small>
      </span>
      <span className="compose-cost">{t("chats.composer.plusBytes", { bytes: utf8Length(placeLine(place)) })}</span>
      <button
        type="button"
        className="compose-bar-close"
        aria-label={t("chats.place.remove")}
        onMouseDown={(e) => e.preventDefault()}
        onClick={(e) => {
          e.stopPropagation();
          setPlace(radio, conversation, null);
        }}
      >
        <CloseIcon size={14} />
      </button>
    </div>
  );
}
