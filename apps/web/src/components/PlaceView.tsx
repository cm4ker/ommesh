/**
 * A place on a map of its own. Opened from a place in a chat: the map round it
 * with you and a dashed line to it, how far it is, its coordinates to copy,
 * and the ways on: the Mesh map with its tools, or another app's map, which
 * may have the area offline. And opened from the message field to put a point
 * by hand: the map moves under a pin, a tap or a node puts the point, and a
 * field takes coordinates or a link pasted from another map.
 */

import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { hasPosition } from "../lib/geo.js";
import { showPlaceOnMesh } from "../lib/meshPlace.js";
import { back } from "../lib/nav.js";
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

export function PlacePicker({ conversation, chrome }: { conversation: string; chrome: Chrome }) {
  const state = useSession();
  const radio = useSelector((s) => s.self?.key ?? "");
  const me = useWhereIAm();
  // Where the map opens: the place already in the field, where you are, the middle of the mesh, or the world.
  const [{ start, zoom }] = useState<{ start: LatLon; zoom: number }>(() => {
    const draft = getPlace(radio, conversation);
    if (draft && hasPosition(draft.lat, draft.lon)) return { start: { lat: draft.lat, lon: draft.lon }, zoom: 15 };
    if (me) return { start: me, zoom: 15 };
    const placed = Object.values(state.contacts).filter((c) => hasPosition(c.lat, c.lon));
    if (placed.length) return { start: { lat: placed.reduce((s, c) => s + c.lat, 0) / placed.length, lon: placed.reduce((s, c) => s + c.lon, 0) / placed.length }, zoom: 11 };
    return { start: { lat: 20, lon: 0 }, zoom: 1 };
  });
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

  const done = () => {
    const draft = getPlace(radio, conversation);
    setPlace(radio, conversation, { source: "point", lat: at.lat, lon: at.lon, accuracy: null, rough: draft?.rough ?? false, open: true });
    back();
  };

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
        <Button variant="primary" onClick={done}>
          {t("chats.place.done")}
        </Button>
      </div>
    </div>
  );
}
