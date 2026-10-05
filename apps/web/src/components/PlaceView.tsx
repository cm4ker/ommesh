/**
 * A place on a map of its own. Opened from a place in a chat: the map round it
 * with you and a dashed line to it, how far it is, its coordinates to copy,
 * and the ways on: the Mesh map with its tools, or another app's map, which
 * may have the area offline. And opened from the message field to put a point
 * by hand: the map moves under a pin, a tap or a node puts the point, and a
 * field takes coordinates or a link pasted from another map.
 */

import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { distanceKm, formatDistance, hasPosition } from "../lib/geo.js";
import { showPlaceOnMesh } from "../lib/meshPlace.js";
import { back } from "../lib/nav.js";
import { putPickedPlace } from "../lib/nodePlace.js";
import { findPlaces, placeMessage, pointFromText, zoomToFit } from "../lib/place.js";
import { getPlace, setPlace } from "../lib/placeDraft.js";
import { isCapacitor, nativePlatform } from "../lib/platform.js";
import { useSelector, useSession } from "../lib/session.js";
import { toast } from "../lib/toast.js";
import { openLink } from "../lib/webLinks.js";
import { Button } from "../ui/Button.js";
import { FitIcon } from "./Icons.js";
import { PlacePin, placeWords, useWhereIAm } from "./PlaceCard.js";
import { Gone, ScreenHead, type Chrome } from "./ScreenHead.js";
import type { LatLon, MapNode } from "./PlaceMap.js";
import { timeOfDay } from "../lib/format.js";
import { t } from "../i18n/index.js";

const PlaceMap = lazy(() => import("./PlaceMap.js"));

/** Coordinates as a map copies them: five decimals, two for a rough place, which has no more. */
function coordsOf(at: LatLon, rough = false): string {
  const d = rough ? 2 : 5;
  return `${at.lat.toFixed(d)}, ${at.lon.toFixed(d)}`;
}

/**
 * Another app's map at the place: on Android whichever map app takes geo:
 * (OsmAnd and Organic Maps work with no network), on an iPhone Apple Maps,
 * elsewhere OpenStreetMap in the browser.
 */
function openElsewhere(at: LatLon, label: string): void {
  const name = encodeURIComponent(label || coordsOf(at));
  if (isCapacitor()) {
    // The shell hands a page's way off its own host to the phone, which opens the app that takes it.
    window.location.href = nativePlatform() === "ios" ? `https://maps.apple.com/?ll=${at.lat},${at.lon}&q=${name}` : `geo:${at.lat},${at.lon}?q=${at.lat},${at.lon}(${name})`;
    return;
  }
  openLink(`https://www.openstreetmap.org/?mlat=${at.lat}&mlon=${at.lon}#map=16/${at.lat}/${at.lon}`);
}

function copy(text: string): void {
  void navigator.clipboard?.writeText(text).then(
    () => toast(t("common.copied"), "", undefined, text),
    () => undefined,
  );
}

export function PlaceView({ text, from, at, chrome }: { text: string; from: string | null; at: number; chrome: Chrome }) {
  const parsed = useMemo(() => {
    const whole = placeMessage(text);
    if (whole) return whole;
    const first = findPlaces(text)[0];
    return first ? { place: first.place, caption: "" } : null;
  }, [text]);
  const me = useWhereIAm();
  const [fit, setFit] = useState<{ key: string; points: LatLon[] } | null>(null);
  if (!parsed) return <Gone chrome={chrome} title={t("chats.place.title")} text={t("chats.place.gone")} />;
  const { place, caption } = parsed;
  const words = placeWords(place, me, from === null);
  const coords = coordsOf(place, place.rough);
  const lines = [place.label, caption].filter(Boolean);
  // MapLibre's zoom is one below the tiles' for the same scale.
  const zoom = place.rough ? zoomToFit(place.lat, place.u ?? 1000, 110) - 1 : 15;

  return (
    <div className="screen place-screen">
      <ScreenHead chrome={chrome}>
        <span className="screen-name-stack">
          <span className="screen-name">{t("chats.place.title")}</span>
          <span className="muted">{[from ?? t("chats.place.fromYou"), timeOfDay(at)].join(" · ")}</span>
        </span>
      </ScreenHead>
      <div className="place-map-box">
        <Suspense fallback={<div className="empty muted">{t("mesh.map.loading")}</div>}>
          <PlaceMap center={place} zoom={zoom} place={place} me={me} line fit={fit} />
        </Suspense>
        {me ? (
          <button type="button" className="place-float" onClick={() => setFit({ key: String(Date.now()), points: [me, place] })}>
            <FitIcon size={15} /> {t("chats.place.both")}
          </button>
        ) : null}
      </div>
      <div className="place-panel">
        <div className="place-head">
          <b>{words.head}</b>
          {words.side ? <span> · {words.side}</span> : null}
        </div>
        {lines.length ? <div className="place-caption">{lines.join("\n")}</div> : null}
        <div className="place-coords">
          <code>{coords}</code>
          <button type="button" className="link" onClick={() => copy(coords)}>
            {t("chats.place.copy")}
          </button>
        </div>
        {words.sub ? <div className="muted">{words.sub}</div> : null}
        <div className="place-actions">
          <Button onClick={() => showPlaceOnMesh(place.lat, place.lon)}>{t("chats.place.onMesh")}</Button>
          <Button onClick={() => openElsewhere(place, place.label || caption)}>{t("chats.place.elsewhere")}</Button>
        </div>
      </div>
    </div>
  );
}

/** As many nodes as a picker can show by name: the ones nearest where it opens. */
const NODES_SHOWN = 150;

/** Where a picker opens with nothing nearer to go by: the middle of the mesh, or the world. */
function meshMiddle(contacts: Record<string, { lat: number; lon: number }>): { start: LatLon; zoom: number } {
  const placed = Object.values(contacts).filter((c) => hasPosition(c.lat, c.lon));
  if (placed.length) return { start: { lat: placed.reduce((s, c) => s + c.lat, 0) / placed.length, lon: placed.reduce((s, c) => s + c.lon, 0) / placed.length }, zoom: 11 };
  return { start: { lat: 20, lon: 0 }, zoom: 1 };
}

export function PlacePicker({ conversation, chrome }: { conversation: string; chrome: Chrome }) {
  const state = useSession();
  const radio = useSelector((s) => s.self?.key ?? "");
  const me = useWhereIAm();
  // Where the map opens: the place already in the field, where you are, the middle of the mesh, or the world.
  const [{ start, zoom }] = useState<{ start: LatLon; zoom: number }>(() => {
    const draft = getPlace(radio, conversation);
    if (draft && hasPosition(draft.lat, draft.lon)) return { start: { lat: draft.lat, lon: draft.lon }, zoom: 15 };
    if (me) return { start: me, zoom: 15 };
    return meshMiddle(state.contacts);
  });
  const done = (at: LatLon) => {
    const draft = getPlace(radio, conversation);
    setPlace(radio, conversation, { source: "point", lat: at.lat, lon: at.lon, accuracy: null, rough: draft?.rough ?? false, open: true });
    back();
  };
  return <PointPicker chrome={chrome} start={start} zoom={zoom} me={me} doneLabel={t("chats.place.done")} onDone={done} />;
}

/**
 * Where a repeater, room or sensor stands, put by hand from its settings
 * (#79). The point goes back to the latitude and longitude there, and on to
 * the node with Apply. The map opens where those fields say, or where the
 * node stands now.
 */
export function NodePlacePicker({ contactKey, at, chrome }: { contactKey: string; at: LatLon | null; chrome: Chrome }) {
  const state = useSession();
  const me = useWhereIAm();
  const contact = state.contacts[contactKey];
  // Where it stands now: the position it gave when last asked, or the one its last advert carried.
  const [was] = useState<LatLon | null>(() => {
    const values = state.nodeSettings[contactKey];
    const lat = Number(values?.["lat"]?.value);
    const lon = Number(values?.["lon"]?.value);
    if (Number.isFinite(lat) && Number.isFinite(lon) && hasPosition(lat, lon)) return { lat, lon };
    return contact && hasPosition(contact.lat, contact.lon) ? { lat: contact.lat, lon: contact.lon } : null;
  });
  const [{ start, zoom }] = useState<{ start: LatLon; zoom: number }>(() => {
    const from = at ?? was ?? me;
    return from ? { start: from, zoom: 15 } : meshMiddle(state.contacts);
  });
  if (!contact) return <Gone chrome={chrome} title={t("node.place.title")} text={t("node.page.gone")} />;
  const done = (to: LatLon) => {
    putPickedPlace({ key: contactKey, lat: to.lat, lon: to.lon });
    back();
  };
  const side = (to: LatLon) => {
    if (!was) return t("node.place.none");
    const km = distanceKm(was.lat, was.lon, to.lat, to.lon);
    // Within a few metres it is where it was: the middle of a map that was moved never lands on it exactly.
    return km < 0.005 ? t("node.place.same") : t("node.place.moved", { distance: formatDistance(km) });
  };
  return (
    <PointPicker chrome={chrome} start={start} zoom={zoom} me={me} doneLabel={t("node.place.put")} onDone={done}>
      {(to) => (
        <div className="place-head">
          <b>{contact.name || contact.prefix}</b>
          <span> · {side(to)}</span>
        </div>
      )}
    </PointPicker>
  );
}

/**
 * A point put by hand: the map moves under a pin, a tap or a node puts the
 * point, and the field in the header takes coordinates or a link pasted
 * from another map. `children` say, over the button, what the point is for.
 */
function PointPicker({
  chrome,
  start,
  zoom,
  me,
  doneLabel,
  onDone,
  children,
}: {
  chrome: Chrome;
  start: LatLon;
  zoom: number;
  me: LatLon | null;
  doneLabel: string;
  onDone: (at: LatLon) => void;
  children?: (at: LatLon) => ReactNode;
}) {
  const state = useSession();
  const [at, setAt] = useState<LatLon>(start);
  const [typed, setTyped] = useState<string | null>(null);
  const [goTo, setGoTo] = useState<{ key: string; at: LatLon } | null>(null);
  const field = useRef<HTMLInputElement>(null);

  const nodes = useMemo<MapNode[]>(() => {
    const placed = Object.values(state.contacts).filter((c) => hasPosition(c.lat, c.lon));
    const far = (c: { lat: number; lon: number }) => (c.lat - start.lat) ** 2 + ((c.lon - start.lon) * Math.cos((start.lat * Math.PI) / 180)) ** 2;
    return placed
      .sort((a, b) => far(a) - far(b))
      .slice(0, NODES_SHOWN)
      .map((c) => ({ key: c.key, name: c.name, lat: c.lat, lon: c.lon }));
    // The nodes are placed once, where the map opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [start]);

  const jump = (to: LatLon) => {
    setAt(to);
    setGoTo({ key: String(Date.now()), at: to });
  };

  // Coordinates or a map's link pasted anywhere on the screen, as a desktop's Ctrl+V does.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (e.target === field.current) return;
      const to = pointFromText(e.clipboardData?.getData("text") ?? "");
      if (to) jump(to);
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, []);

  const bad = typed !== null && typed.trim() !== "" && pointFromText(typed) === null;
  return (
    <div className="screen place-screen">
      <ScreenHead chrome={chrome}>
        <input
          ref={field}
          className={["input", "place-field", bad ? "bad" : ""].join(" ")}
          value={typed ?? coordsOf(at)}
          placeholder={t("chats.place.fieldHint")}
          aria-label={t("chats.place.fieldHint")}
          inputMode="text"
          autoComplete="off"
          spellCheck={false}
          onFocus={(e) => {
            setTyped(coordsOf(at));
            e.currentTarget.select();
          }}
          onBlur={() => setTyped(null)}
          onChange={(e) => {
            setTyped(e.target.value);
            const to = pointFromText(e.target.value);
            if (to) jump(to);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
          }}
        />
      </ScreenHead>
      <div className="place-map-box">
        <Suspense fallback={<div className="empty muted">{t("mesh.map.loading")}</div>}>
          <PlaceMap center={start} zoom={zoom} me={me} nodes={nodes} onCentre={setAt} goTo={goTo} />
        </Suspense>
        <span className="place-centre" aria-hidden="true">
          <PlacePin />
        </span>
      </div>
      <div className="place-panel">
        {children?.(at)}
        <Button variant="primary" onClick={() => onDone(at)}>
          {doneLabel}
        </Button>
      </div>
    </div>
  );
}
