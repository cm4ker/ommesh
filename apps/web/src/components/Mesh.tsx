/**
 * Everyone the radio hears, on the map and in a list, in one place. On a
 * phone the list rides in a sheet over the map, pulled up to read it and
 * down to see the map; on a desktop it is the column beside the map.
 */

import { lazy, memo, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { AdvertLocPolicy, AdvType, isFavourite, type ContactRecord, type SessionState } from "@meshnet/meshcore";
import { t, type Key } from "../i18n/index.js";
import { useBackLayer } from "../lib/back.js";
import { useBatteryTypes } from "../lib/batteryType.js";
import { ago, batteryPercent, lowCharge, type BatteryType } from "../lib/format.js";
import { bearingDeg, compass, destination, distanceKm, formatDistance, formatLatLon, hasPosition } from "../lib/geo.js";
import { useHears } from "../lib/hears.js";
import { legId, useLegVerdicts } from "../lib/legVerdicts.js";
import type { LinkRadio } from "../lib/los.js";
import { useDiscovery } from "../lib/discovery.js";
import { FOLLOW_MOVE_M, followsPhone, radioHasGps, useFollowStatus } from "../lib/followPhone.js";
import { locateOnce, locateText, phoneLocates, usePhone } from "../lib/phonePosition.js";
import { contactEnd, defaultHeight, discoveryOverlay, EMPTY_OVERLAY, editOverlay, hearsOverlay, losOverlay, neighboursOverlay, relayOf, routeOverlay, selfEnd, spanOverlay, surveyOverlay, type MapDot, type MapHandle, type MapOverlay } from "../lib/mapOverlay.js";
import { setMeshTool, useMeshTool, type LosEnd, type MeshTool, type SurveyTool } from "../lib/meshTool.js";
import { clearMeshPlace, useMeshPlace } from "../lib/meshPlace.js";
import { useSurveys, type SurveysState } from "../lib/survey.js";
import { toneFor, type Survey } from "../lib/surveyData.js";
import { focusOnMap, openProfile, takeListLowered, useNav } from "../lib/nav.js";
import { heardAt as heard, kindLabel } from "../lib/nodes.js";
import { DEFAULT_NODE_ORDER, NODE_ORDERS, nodeComparator, orderInForce, pinnedFirst, placed, setNodeOrder, useNodeOrder } from "../lib/nodeOrder.js";
import type { MenuAt } from "../lib/press.js";
import { usePing, measuredLegs, spanKey } from "../lib/ping.js";
import { routeWords } from "../lib/routes.js";
import { useSavedPasswords } from "../lib/secrets.js";
import { openCleanUp } from "../lib/cleanUp.js";
import { isYours, memoryTight, memoryUse } from "../lib/tidy.js";
import { session, useSelector, useSession } from "../lib/session.js";
import { act, toast } from "../lib/toast.js";
import { isComplete, neighbourRows, passes } from "../lib/neighbours.js";
import { closeAllTools, closeTool, dropOnRoute, lineOfSightTo, openLineOfSight, openNeighbourLink, surveyAtOnce, tapInNeighbours, tapInRoute, tapInSpan, whoHearsMe } from "../lib/toolActions.js";
import { getTextScale, subscribeTextSize } from "../theme/textSize.js";
import { IconButton } from "../ui/Button.js";
import { SearchField } from "../ui/Field.js";
import { ActionRow, Block, Group, SwitchRow } from "../ui/List.js";
import { showMenu } from "../ui/Menu.js";
import { Sheet } from "../ui/Sheet.js";
import { Avatar } from "./Avatar.js";
import { AlertIcon, ChartIcon, CloseIcon, CopyIcon, LocationIcon, SlidersIcon, StarFilledIcon } from "./Icons.js";
import { RadioTag } from "./RadioTag.js";
import { SurveyBadge } from "./tools/Survey.js";
import { ToolPanel } from "./tools/ToolPanel.js";

// MapLibre and its styles load with the map, not with the app.
const MapView = lazy(() => import("./MapView.js"));

type Kind = "all" | "yours" | "people" | "repeaters" | "rooms" | "sensors";

const KINDS: { id: Kind; label: Key }[] = [
  { id: "all", label: "mesh.filter.all" },
  { id: "yours", label: "mesh.filter.yours" },
  { id: "people", label: "mesh.filter.people" },
  { id: "repeaters", label: "mesh.filter.repeaters" },
  { id: "rooms", label: "mesh.filter.rooms" },
  { id: "sensors", label: "mesh.filter.sensors" },
];

// ---- the filter, shared by the list and the map, and kept while the app lives ----

let filter: { kind: Kind; query: string } = { kind: "all", query: "" };
const filterListeners = new Set<() => void>();
function setFilter(patch: Partial<typeof filter>): void {
  filter = { ...filter, ...patch };
  for (const listener of filterListeners) listener();
}
function useFilter() {
  return useSyncExternalStore(
    (listener) => {
      filterListeners.add(listener);
      return () => filterListeners.delete(listener);
    },
    () => filter,
  );
}

// Whether the filter's sheet is open: its button sits in the phone's sheet head, whose drag must not see the sheet's
// own touches, so the sheet is drawn elsewhere, by FilterSheetHost.
let filterOpen = false;
const filterOpenListeners = new Set<() => void>();
function setFilterOpen(open: boolean): void {
  filterOpen = open;
  for (const listener of filterOpenListeners) listener();
}
function useFilterOpen(): boolean {
  return useSyncExternalStore(
    (listener) => {
      filterOpenListeners.add(listener);
      return () => filterOpenListeners.delete(listener);
    },
    () => filterOpen,
  );
}


function matcher(state: SessionState, saved: readonly string[], kind: Kind, query: string): (c: ContactRecord) => boolean {
  const q = query.trim().toLowerCase();
  return (c) => {
    if (q && !(c.name || c.prefix).toLowerCase().includes(q) && !c.key.startsWith(q)) return false;
    switch (kind) {
      case "yours":
        return isYours(state, saved, c);
      case "people":
        return c.type === AdvType.Chat;
      case "repeaters":
        return c.type === AdvType.Repeater;
      case "rooms":
        return c.type === AdvType.Room;
      case "sensors":
        return c.type === AdvType.Sensor;
      default:
        return true;
    }
  };
}

/** A node of yours in trouble: its last status says its battery is low, by the cell picked for it. */
function lowBattery(state: SessionState, key: string, types: Readonly<Record<string, BatteryType>>): boolean {
  const last = state.statusHistory[key]?.at(-1);
  return !!last && lowCharge(last.batteryMv, types[key]);
}

/** Whether any node of yours needs a look, for the dot on the Mesh tab. */
export function useMeshAttention(): boolean {
  // The cells live outside the session, so picking one judges the nodes again at once.
  const types = useBatteryTypes();
  return useSelector((state) => Object.keys(state.statusHistory).some((key) => state.contacts[key] && lowBattery(state, key, types)));
}

function whereFrom(self: SessionState["self"], c: ContactRecord): string | null {
  if (!hasPosition(c.lat, c.lon)) return null;
  if (!self || !hasPosition(self.lat, self.lon)) return null;
  return t("mesh.whereFrom", { distance: formatDistance(distanceKm(self.lat, self.lon, c.lat, c.lon)), direction: compass(bearingDeg(self.lat, self.lon, c.lat, c.lon)) });
}

// ---- the list ----

export function MeshList({ selected, onOpen, head = true, only }: { selected: string | null; onOpen: (key: string) => void; head?: boolean | undefined; only?: string[] | undefined }) {
  return (
    <div className="list-pane">
      {head ? <MeshListHead /> : null}
      <MeshListBody selected={selected} onOpen={onOpen} only={only} hideSearch={!!only} />
      {only ? null : <FilterSheetHost />}
    </div>
  );
}

export function MeshListHead() {
  return (
    <header className="list-head">
      <h1>{t("mesh.title")}</h1>
      <RadioTag />
    </header>
  );
}

/** Whether the list shows anything but everyone, by last heard, in one list. */
function useFilterChanged(): boolean {
  const { kind } = useFilter();
  const { order, pinned } = useNodeOrder();
  return kind !== "all" || order !== DEFAULT_NODE_ORDER.order || pinned !== DEFAULT_NODE_ORDER.pinned;
}

function resetFilter(): void {
  setFilter({ kind: "all" });
  setNodeOrder(DEFAULT_NODE_ORDER);
}

/** Beside the search: what the list shows and in what order, wanted rarely. A dot says something is changed. */
function FilterButton() {
  const changed = useFilterChanged();
  return (
    <IconButton label={t("mesh.filter.title")} className={["filter-btn", changed ? "on" : ""].join(" ")} aria-haspopup="dialog" onClick={() => setFilterOpen(true)}>
      <SlidersIcon size={17} />
      {changed ? <span className="filter-dot" aria-hidden="true" /> : null}
    </IconButton>
  );
}

/** Which nodes, in what order, yours and favourites in groups of their own or not, and every contact fetched again. */
function FilterSheetHost() {
  const open = useFilterOpen();
  const onClose = () => setFilterOpen(false);
  const state = useSession();
  const { kind } = useFilter();
  const { order, pinned } = useNodeOrder();
  const changed = useFilterChanged();
  const [busy, setBusy] = useState(false);
  const lost = !placed(state.self);
  const shown = orderInForce(order, state.self);
  const all = Object.values(state.contacts);
  const unplaced = all.filter((c) => !hasPosition(c.lat, c.lon)).length;
  const count = t("mesh.list.count", { count: all.length }) + (unplaced ? ` · ${t("mesh.list.unplaced", { count: unplaced })}` : "");
  return (
    <Sheet open={open} onClose={onClose} title={t("mesh.filter.title")}>
      <Group title={t("mesh.filter.show")}>
        <Block className="filter-grid">
          {KINDS.map((k) => (
            <button key={k.id} type="button" className={["chip", kind === k.id ? "on" : ""].join(" ")} aria-pressed={kind === k.id} onClick={() => setFilter({ kind: k.id })}>
              {t(k.label)}
            </button>
          ))}
        </Block>
      </Group>
      <Group title={t("mesh.filter.order")}>
        <Block className="filter-grid pairs">
          {NODE_ORDERS.map((o) => {
            const off = o.id === "near" && lost;
            return (
              <button key={o.id} type="button" className={["chip", shown === o.id ? "on" : ""].join(" ")} aria-pressed={shown === o.id} disabled={off} title={off ? t("mesh.sort.noPosition") : undefined} onClick={() => setNodeOrder({ order: o.id })}>
                {t(o.label)}
              </button>
            );
          })}
        </Block>
      </Group>
      <Group>
        <SwitchRow label={t("mesh.sort.pinned")} hint={pinned ? t("mesh.sort.pinnedOn") : t("mesh.sort.pinnedOff")} checked={pinned} onChange={(next) => setNodeOrder({ pinned: next })} />
      </Group>
      <Group note={count}>
        <ActionRow
          label={t("mesh.fetch")}
          busy={busy}
          disabled={busy || state.status !== "ready"}
          onClick={async () => {
            setBusy(true);
            await act(() => session.refreshContacts(true), t("mesh.fetched"));
            setBusy(false);
          }}
        />
        {changed ? <ActionRow label={t("mesh.filter.reset")} onClick={resetFilter} /> : null}
      </Group>
    </Sheet>
  );
}

/** What is changed from the usual, under the search, each taken off by its cross. */
function ActiveFilters({ self }: { self: SessionState["self"] }) {
  const { kind } = useFilter();
  const { order } = useNodeOrder();
  const shown = orderInForce(order, self);
  const chips: { id: string; label: string; clear: () => void }[] = [];
  if (kind !== "all") chips.push({ id: "kind", label: t(KINDS.find((k) => k.id === kind)!.label), clear: () => setFilter({ kind: "all" }) });
  if (shown !== DEFAULT_NODE_ORDER.order) chips.push({ id: "order", label: t(NODE_ORDERS.find((o) => o.id === shown)!.label), clear: () => setNodeOrder({ order: DEFAULT_NODE_ORDER.order }) });
  if (chips.length === 0) return null;
  return (
    <div className="chips" role="group" aria-label={t("mesh.filter.active")}>
      {chips.map((c) => (
        <button key={c.id} type="button" className="chip on chip-clear" aria-label={t("mesh.filter.remove", { name: c.label })} onClick={c.clear}>
          {c.label}
          <CloseIcon size={12} />
        </button>
      ))}
    </div>
  );
}

function MeshSearch() {
  const { query } = useFilter();
  return (
    <SearchField value={query} onValue={(next) => setFilter({ query: next })} note={<MeshCount />} placeholder={t("mesh.find")} aria-label={t("mesh.find")} data-find />
  );
}

/**
 * At the end of the search field, how many nodes there are (#60): "68 nodes", or "15 of 68" in the accent while
 * a kind or a search hides some. The order hides none, so it never makes it "of".
 */
function MeshCount() {
  const state = useSession();
  const saved = useSavedPasswords();
  const { kind, query } = useFilter();
  const all = Object.values(state.contacts);
  if (all.length === 0) return null;
  if (kind === "all" && !query.trim()) return <span className="search-note">{t("mesh.list.count", { count: all.length })}</span>;
  const shown = all.filter(matcher(state, saved, kind, query)).length;
  return <span className="search-note cut">{t("mesh.list.shown", { shown, count: all.length })}</span>;
}

function MeshListBody({ selected, onOpen, hideSearch = false, only }: { selected: string | null; onOpen: (key: string) => void; hideSearch?: boolean | undefined; only?: string[] | undefined }) {
  const state = useSession();
  const saved = useSavedPasswords();
  const { kind, query } = useFilter();
  const { order, pinned } = useNodeOrder();
  const cells = useBatteryTypes();
  const all = Object.values(state.contacts);
  const rows = all.filter(only ? (c) => only.includes(c.key) : matcher(state, saved, kind, query)).sort(nodeComparator(order, state.self));
  const mine = (c: ContactRecord) => isYours(state, saved, c);
  const list = pinnedFirst(rows, mine, pinned);
  // Rows are memoised, so they get a stable opener and the minute their "5 min" is counted from.
  const openRef = useRef(onOpen);
  openRef.current = onOpen;
  const open = useCallback((key: string) => openRef.current(key), []);
  const minute = Math.floor(Date.now() / 60_000);

  return (
    <>
      {hideSearch ? null : (
        <div className="mesh-search-row">
          <MeshSearch />
          <FilterButton />
        </div>
      )}
      {only ? null : <ActiveFilters self={state.self} />}
      <div className="list mesh-list">
        {all.length === 0 ? (
          <div className="empty muted">{t("mesh.list.empty")}</div>
        ) : rows.length === 0 ? (
          <div className="empty muted">{kind === "yours" && !query ? t("mesh.list.emptyYours") : t("mesh.list.noMatch")}</div>
        ) : (
          <>
            {only ? null : <MemoryStrip state={state} />}
            <ul className="list-rows" role="list">
              {list.map((c) => (
                <NodeRow
                  key={c.key}
                  contact={c}
                  selected={selected === c.key}
                  yours={mine(c)}
                  onOpen={open}
                  login={state.logins[c.key]}
                  last={state.statusHistory[c.key]?.at(-1)}
                  cell={cells[c.key]}
                  self={state.self}
                  minute={minute}
                />
              ))}
            </ul>
          </>
        )}
      </div>
    </>
  );
}

/**
 * How full the radio's memory is, shown only when it nearly is: past nine
 * tenths, or once it said it dropped a node. While contacts are being taken
 * off, how far that has got, with a Stop.
 */
function MemoryStrip({ state }: { state: SessionState }) {
  if (state.removing) {
    const { done, total } = state.removing;
    return (
      <div className="memory-strip busy" role="status">
        <span className="grow">
          {t("mesh.memory.removing", { done, total })}
          <span className="memory-bar">
            <i style={{ width: `${(done / Math.max(1, total)) * 100}%` }} />
          </span>
        </span>
        <button type="button" className="memory-act" onClick={() => session.stopRemoving()}>
          {t("mesh.memory.stop")}
        </button>
      </div>
    );
  }
  const use = memoryUse(state);
  if (!memoryTight(state) || !use) return null;
  const full = state.contactsFull || use.used >= use.max;
  return (
    <div className={["memory-strip", full ? "full" : "warn"].join(" ")}>
      <span className="grow">
        {full ? t("mesh.memory.full") : t("mesh.memory.use", { used: use.used, max: use.max })}
        <span className="memory-bar">
          <i style={{ width: `${Math.min(100, (use.used / use.max) * 100)}%` }} />
        </span>
      </span>
      <button type="button" className="memory-act" disabled={state.status !== "ready"} onClick={openCleanUp}>
        {t("mesh.memory.cleanUp")}
      </button>
    </div>
  );
}

interface NodeRowProps {
  contact: ContactRecord;
  selected: boolean;
  yours: boolean;
  onOpen: (key: string) => void;
  login: SessionState["logins"][string] | undefined;
  last: SessionState["statusHistory"][string][number] | undefined;
  /** The cell picked for the node, which its charge is counted by. */
  cell: BatteryType | undefined;
  self: SessionState["self"];
  /** Only so the row's "5 min" moves on when the list next renders. */
  minute: number;
}

/**
 * One node in the list. Memoised: an advert changes one contact, and the other rows,
 * eighty of them in a busy mesh, have nothing new to draw.
 */
const NodeRow = memo(function NodeRow({ contact: c, selected, yours, onOpen, login, last, cell, self }: NodeRowProps) {
  // Most nodes have no route and flood, and many no position: said on every row it says nothing, so the profile says it.
  const route = yours ? null : routeWords(c);
  const bits = yours
    ? [kindLabel(c.type), login?.ok ? t("mesh.row.signedIn") : t("mesh.row.notSignedIn")]
    : [kindLabel(c.type), c.unsaved ? t("mesh.row.notOnRadio") : whereFrom(self, c)];
  // A node of yours says its charge as its readings do: by its cell, "≈" by Li-ion until one is picked.
  const percent = yours && last && last.batteryMv > 0 ? batteryPercent(last.batteryMv, cell) : null;
  const low = !!last && lowCharge(last.batteryMv, cell);
  return (
    <li>
      <button type="button" className={["row", selected ? "selected" : ""].join(" ")} onClick={() => onOpen(c.key)}>
        <Avatar name={c.name || c.prefix} type={c.type} size={40} />
        <span className="row-main">
          <span className="row-top">
            <span className="row-title">
              {c.name || c.prefix}
              {isFavourite(c) ? <StarFilledIcon size={11} className="star" /> : null}
            </span>
            <span className="row-when muted">{ago(heard(c) || null)}</span>
          </span>
          <span className="row-bottom">
            <span className="row-sub muted">
              {bits.filter(Boolean).join(" · ")}
              {percent !== null ? (
                <>
                  {" · "}
                  <span className={low ? "row-low" : undefined} title={low ? t("mesh.row.batteryLow") : undefined}>
                    {low ? <AlertIcon size={11} role="img" aria-hidden={false} aria-label={t("mesh.row.batteryLow")} /> : null}
                    {t("mesh.row.charge", { value: cell ? percent : t("radio.readings.about", { value: percent }) })}
                  </span>
                </>
              ) : null}
              {route && route.tone !== "none" ? <span className={route.tone === "pinned" ? "" : "route-known"}> · {route.text}</span> : null}
            </span>
          </span>
        </span>
      </button>
    </li>
  );
});

// ---- the map ----

/**
 * What goes over the nodes: the tool in use, or else the route to the node
 * picked or opened, coloured by its last check, or as its last search found
 * it, whichever is newer.
 */
/** The survey a survey tool shows: the one running, or one kept. */
function shownSurvey(tool: MeshTool | null, surveys: SurveysState): Survey | null {
  if (tool?.kind !== "survey" || tool.view === "list") return null;
  const id = tool.view === "run" && surveys.run ? surveys.run.id : tool.id;
  return surveys.list?.find((s) => s.id === id) ?? null;
}

/** The point whose answers are drawn: the one opened, or else, while the survey runs, its last. */
function shownPoint(tool: SurveyTool, surveys: SurveysState): number | null {
  if (tool.point !== null) return tool.point;
  const survey = tool.view === "run" && surveys.run ? shownSurvey(tool, surveys) : null;
  return survey && survey.points.length ? survey.points.length - 1 : null;
}

/** While a survey runs, what the map keeps in view with the phone: every repeater that has answered in it, where it stands now. */
function followPoints(survey: Survey, state: SessionState): [number, number][] {
  const points: [number, number][] = [];
  for (const [key, node] of Object.entries(survey.nodes)) {
    const c = state.contacts[key];
    if (c && hasPosition(c.lat, c.lon)) points.push([c.lat, c.lon]);
    else if (node.lat !== null && node.lon !== null) points.push([node.lat, node.lon]);
  }
  return points;
}

function useMeshOverlay(selected: string | null, state: SessionState): MapOverlay {
  const tool = useMeshTool();
  const surveys = useSurveys();
  const focus = tool?.kind === "route" ? tool.key : tool?.kind === "span" ? tool.from : selected;
  const ping = usePing(tool?.kind === "span" ? (tool.to ? spanKey(tool.from, tool.to) : null) : focus);
  // A link between neighbours being checked marches.
  const linkPing = usePing(tool?.kind === "neighbours" && tool.link ? spanKey(tool.key, tool.link) : null);
  const discovery = useDiscovery(focus);
  const hears = useHears();
  const place = useMeshPlace();
  const self = state.self;
  const radio: LinkRadio | null = useMemo(
    () => (self ? { frequencyKhz: self.frequencyKhz, bandwidthHz: self.bandwidthHz, spreadingFactor: self.spreadingFactor, codingRate: self.codingRate, txPowerDbm: self.txPower } : null),
    [self],
  );
  // A route being changed marks the legs the terrain closes; they are read once and kept.
  const editLegs = useMemo(() => {
    if (tool?.kind !== "route" || !tool.draft) return [];
    const target = state.contacts[tool.key];
    const ends: (LosEnd | null)[] = [selfEnd(state), ...tool.draft.map((k) => { const r = state.contacts[k] ?? relayOf(k, state.contacts, tool.key); return r ? contactEnd(r) : null; }), target ? contactEnd(target) : null];
    return ends.slice(1).flatMap((b, i) => {
      const a = ends[i];
      return a && b ? [{ a, b, ha: defaultHeight(a, state.contacts), hb: defaultHeight(b, state.contacts) }] : [];
    });
  }, [tool, state]);
  const verdicts = useLegVerdicts(editLegs, radio);
  const blockedKey = editLegs.filter((l) => verdicts.get(legId(l.a, l.b)) === "blocked").map((l) => legId(l.a, l.b)).join(";");
  const overlay =
    tool?.kind === "los"
      ? losOverlay(tool)
      : tool?.kind === "route" && tool.draft
        ? editOverlay(tool.key, tool.draft, state, new Set(blockedKey ? blockedKey.split(";") : []), ping)
        : tool?.kind === "hears"
          ? hearsOverlay(hears, state)
        : tool?.kind === "survey"
          ? surveyOverlay(shownSurvey(tool, surveys), shownPoint(tool, surveys), state)
          : tool?.kind === "span"
            ? spanOverlay(tool.from, tool.to, state, ping)
          : tool?.kind === "neighbours"
            ? neighboursOverlay(tool, state, linkPing?.running ?? false)
          : focus
            ? discovery && (discovery.running || discovery.found) && discovery.at >= (ping?.at ?? 0)
              ? discoveryOverlay(focus, state, discovery)
              : routeOverlay(focus, state, ping)
            : place
              ? { ...EMPTY_OVERLAY, pins: [{ lat: place.lat, lon: place.lon }] }
              : EMPTY_OVERLAY;
  // The state changes with every packet heard; the lines are drawn again only when they change.
  const same = JSON.stringify(overlay);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => overlay, [same]);
}

/** A long press or a right click on the map: what can be done with that spot. */
function openSpotMenu(lat: number, lon: number, at: MenuAt): void {
  const self = session.getState().self;
  const online = session.getState().status === "ready";
  const following = followsPhone(self?.key) && radioHasGps(self?.key) !== true;
  const here = formatLatLon(lat, lon);
  showMenu(
    [
      {
        label: t("mesh.spot.lineOfSight"),
        icon: <ChartIcon size={17} />,
        disabled: !self || !hasPosition(self.lat, self.lon),
        hint: self && hasPosition(self.lat, self.lon) ? undefined : t("mesh.spot.noPosition"),
        onSelect: () => lineOfSightTo(lat, lon),
      },
      {
        label: t("mesh.spot.putHere"),
        icon: <LocationIcon size={17} />,
        // Following the phone, the radio would go back to it with the next move.
        disabled: !online || !self || following,
        hint: !online || !self ? t("mesh.spot.connectToMove") : following ? t("mesh.spot.following") : undefined,
        onSelect: () => void moveSelfTo(lat, lon),
      },
      { label: t("mesh.spot.copy"), icon: <CopyIcon size={17} />, group: true, onSelect: () => void navigator.clipboard?.writeText(here).then(() => toast(t("common.copied"), "", undefined, here)) },
    ],
    { title: here, at },
  );
}

/** This radio's position set to a spot on the map; Undo puts it back where it was. */
async function moveSelfTo(lat: number, lon: number): Promise<void> {
  const self = session.getState().self;
  if (!self) return;
  const was = { lat: self.lat, lon: self.lon };
  if (!(await act(() => session.setLocation(Number(lat.toFixed(6)), Number(lon.toFixed(6)))))) return;
  const detail = self.advertLocPolicy === AdvertLocPolicy.None ? t("mesh.spot.notShared") : t("mesh.spot.othersSee");
  toast(t("mesh.spot.movedHere"), "", { label: t("common.undo"), run: () => void act(() => session.setLocation(was.lat, was.lon), t("mesh.spot.movedBack")) }, detail);
}

/** Whether "where am I" has found the phone in this run of the app: from then on the map shows it. */
let phoneAsked = false;

/**
 * The phone on the map (#34): shown once "where am I" found it, or while the
 * radio follows it, and kept coming only while the map is in sight. Under it,
 * when this radio is somewhere else, a button puts the radio there.
 */
function usePhoneOnMap(state: SessionState, active: boolean, surveying: boolean) {
  const locates = phoneLocates();
  const [asked, setAsked] = useState(phoneAsked);
  const follow = useFollowStatus(state.self?.key);
  const following = follow.on && follow.gps !== true;
  const { fix } = usePhone(locates && active && asked);
  // A survey running holds the phone's position itself, and shows where it is.
  const phone = locates && (asked || following || surveying) ? fix : null;
  const self = state.self;
  let putHere: { distance: string | null; onPut: () => void } | null = null;
  if (phone && self && state.status === "ready" && !following && follow.gps !== true && !surveying) {
    // In steps of 10 m, so a fix that wanders a metre does not redraw the button.
    const far = hasPosition(self.lat, self.lon) ? Math.round(distanceKm(phone.lat, phone.lon, self.lat, self.lon) * 100) / 100 : null;
    if (far === null || far * 1000 > FOLLOW_MOVE_M) putHere = { distance: far === null ? null : formatDistance(far), onPut: () => void moveSelfTo(phone.lat, phone.lon) };
  }
  const onLocate = locates
    ? async () => {
        try {
          const found = await locateOnce();
          phoneAsked = true;
          setAsked(true);
          return found;
        } catch (error) {
          toast(locateText(error), "error");
          return null;
        }
      }
    : undefined;
  return { phone, putHere, onLocate };
}

/** The map with the filter applied, the focus and the tool drawn, and taps handed up or to the tool. */
export function MeshMap({ selected, onSelect, onGroup, coverTop, coverBottom, zoomButtons, active = true }: { selected: string | null; onSelect: (key: string | null) => void; onGroup: (keys: string[]) => void; coverTop?: number | undefined; coverBottom?: number | undefined; zoomButtons?: boolean | undefined; active?: boolean | undefined }) {
  const state = useSession();
  const surveys = useSurveys();
  const surveying = surveys.run !== null;
  const { phone, putHere, onLocate } = usePhoneOnMap(state, active, surveying);
  const saved = useSavedPasswords();
  const { kind, query } = useFilter();
  const tool = useMeshTool();
  // A survey's points, coloured by the repeater picked when one is.
  const survey = shownSurvey(tool, surveys);
  const only = tool?.kind === "survey" ? tool.only : null;
  const dots = useMemo<MapDot[] | null>(() => (survey ? survey.points.map((p) => ({ lat: p.lat, lon: p.lon, tone: toneFor(p, only) })) : null), [survey, only]);
  const onDot = tool?.kind === "survey" ? (index: number) => setMeshTool({ ...tool, point: index }) : undefined;
  const ping = usePing(tool?.kind === "span" ? (tool.to ? spanKey(tool.from, tool.to) : null) : selected);
  const overlay = useMeshOverlay(selected, state);
  // The map redraws markers when the filter function changes, so it changes only with what it filters by.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const matches = useCallback(matcher(state, saved, kind, query), [state.logins, state.statusHistory, saved, kind, query]);
  // A repeater's neighbours shown: only it and those it hears, as the filter leaves them, are drawn.
  const linked = tool?.kind === "neighbours" ? [tool.key, ...neighbourRows(state, tool.key, Date.now()).flatMap((n) => (n.contact && passes(n, tool.filter) ? [n.contact.key] : []))].join(",") : null;
  const test = useMemo(() => {
    if (linked === null) return matches;
    const keys = new Set(linked.split(","));
    return (c: ContactRecord) => keys.has(c.key);
  }, [linked, matches]);
  const pick = (key: string | null) => {
    if (tapInRoute(key, state) || tapInSpan(key, state) || tapInNeighbours(key, state)) return;
    // A tap on the empty map puts a line of sight away, as it puts away a picked node; a survey only lets go of its point.
    if (key === null && tool?.kind === "survey") {
      if (tool.point !== null) closeTool();
    } else if (key === null && tool && tool.kind !== "route") closeTool();
    // A tap anywhere puts a place from a chat away, as it puts away a picked node.
    clearMeshPlace();
    onSelect(key);
  };
  const leg = (from: LosEnd, to: LosEnd) => {
    // A line from a repeater to a neighbour opens the link between them.
    if (tool?.kind === "neighbours") {
      const other = from.key === tool.key ? to.key : from.key;
      if (other) openNeighbourLink(other);
      return;
    }
    // The legs of a pinged route carry what the ping measured on them.
    const back = tool?.kind === "los" ? tool.back : selected;
    let heard: [number, number | null] | null = null;
    const span = tool?.kind === "span";
    if ((!tool || (tool.kind === "route" && !tool.draft) || span) && (selected || span) && ping && !ping.via) {
      const relays = span || !ping.targetInChain ? ping.chain : ping.chain.slice(0, -1);
      const keys = ["self", ...relays.map((h) => relayOf(h, state.contacts)?.key ?? h), ...(span ? [] : [selected])];
      const index = keys.findIndex((k, i) => k === from.key && keys[i + 1] === to.key);
      heard = index >= 0 ? (measuredLegs(ping)[index] ?? null) : null;
    }
    openLineOfSight(from, to, tool?.kind === "hears" ? null : back, heard);
  };
  const drop = (handle: MapHandle, onto: string) => {
    const key = tool?.kind === "route" ? tool.key : selected;
    if (key) dropOnRoute(key, handle, onto);
  };
  // A repeater's neighbours are brought into view together: once when they open, again when the rest of the
  // list is in, and when the filter asks, as a finger lets go of the distance. A signal slid does not move the map.
  const hub = tool?.kind === "neighbours" ? tool.key : null;
  const whole = hub ? isComplete(state.neighbours[hub]) : false;
  const sift = tool?.kind === "neighbours" ? (tool.filter ?? null) : null;
  const siftKey = JSON.stringify(sift);
  const refit = tool?.kind === "neighbours" ? (tool.refit ?? 0) : 0;
  const fitPoints = useMemo(() => {
    if (!hub) return [];
    const c = state.contacts[hub];
    const points: [number, number][] = c && hasPosition(c.lat, c.lon) ? [[c.lat, c.lon]] : [];
    for (const n of neighbourRows(state, hub, Date.now())) if (n.placed && passes(n, sift)) points.push([n.contact!.lat, n.contact!.lon]);
    // Up to a distance, the whole ring of it comes into view: the ring says why the lines stop there.
    if (c && hasPosition(c.lat, c.lon) && sift && sift.toKm !== null) {
      for (const bearing of [0, 90, 180, 270]) {
        const edge = destination(c.lat, c.lon, sift.toKm, bearing);
        points.push([edge.lat, edge.lon]);
      }
    }
    return points;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hub, whole, hub ? state.neighbours[hub] : null, siftKey]);
  // A kept survey opened is brought into view whole, once.
  const surveyFit = useMemo(() => (survey && survey.endedAt !== null ? { id: `survey:${survey.id}`, points: survey.points.map((p) => [p.lat, p.lon] as [number, number]) } : null), [survey]);
  // A route to a node with no place has no node to bring into view: what the map knows of the route comes instead, once.
  const routeTo = tool?.kind === "route" ? state.contacts[tool.key] : undefined;
  let routeFit: { id: string; points: [number, number][] } | null = null;
  if (routeTo && !hasPosition(routeTo.lat, routeTo.lon)) {
    const points = overlay.lines.flatMap((l): [number, number][] => [[l.from.lat, l.from.lon], [l.to.lat, l.to.lon]]);
    if (overlay.tail) points.push([overlay.tail.lat, overlay.tail.lon]);
    routeFit = { id: `route:${routeTo.key}:${points.length > 0}`, points };
  }
  // A place from a chat is brought into view each time it is shown.
  const place = useMeshPlace();
  const placeFit = place ? { id: `place:${place.id}`, points: [[place.lat, place.lon]] as [number, number][] } : null;
  const fit = hub ? { id: `${hub}:${whole ? "all" : "part"}:${refit}`, points: fitPoints } : (surveyFit ?? routeFit ?? placeFit);
  // A point of it opened, the map goes on following: the answers there are read with the phone still in sight.
  const running = tool?.kind === "survey" && tool.view === "run" && surveying;
  // A new list only when a repeater answers for the first time or one of them moves, so the map is not fitted on every render.
  const followList = running && survey ? { id: survey.id, points: followPoints(survey, state) } : null;
  const followKey = followList ? JSON.stringify(followList) : null;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const follow = useMemo(() => followList, [followKey]);
  // The map's button opens "who hears me", and with it or a survey's sheet open, puts that away. Held, it starts a survey.
  const hearsOpen = tool?.kind === "hears" || tool?.kind === "survey";
  const onHears = hearsOpen ? closeAllTools : whoHearsMe;
  const onHearsHold = state.status === "ready" && !surveying ? () => void surveyAtOnce() : undefined;
  // The running survey's number stands over the map with its card put away too, but not over another tool's lines.
  const top = surveying && (!tool || (tool.kind === "survey" && tool.view === "run")) ? <SurveyBadge /> : null;
  return (
    <Suspense fallback={<div className="empty muted">{t("mesh.map.loading")}</div>}>
      <MapView selected={selected} onSelect={pick} onGroup={onGroup} filter={test} coverTop={coverTop} coverBottom={coverBottom} zoomButtons={zoomButtons} overlay={overlay} onLeg={leg} onHold={openSpotMenu} onHandleDrop={drop} onHears={onHears} hearsOn={hearsOpen} onHearsHold={onHearsHold} fit={fit} phone={phone} putHere={putHere} onLocate={onLocate} dots={dots} pickedDot={tool?.kind === "survey" ? tool.point : null} onDot={onDot} follow={follow} recording={surveying} top={top} />
    </Suspense>
  );
}

/** Nodes at one spot, which no zoom separates. */
function GroupList({ keys, onPick, onClose }: { keys: string[]; onPick: (key: string) => void; onClose: () => void }) {
  const state = useSession();
  const members = keys.map((k) => state.contacts[k]).filter((c): c is ContactRecord => !!c);
  return (
    <div className="node-card">
      <div className="node-card-head">
        <span className="row-main">
          <span className="row-title">{t("mesh.atOneSpot", { count: members.length })}</span>
          <span className="row-sub muted">{members[0] ? whereFrom(state.self, members[0]) ?? "" : ""}</span>
        </span>
        <IconButton label={t("common.close")} onClick={onClose}>
          <CloseIcon size={18} />
        </IconButton>
      </div>
      <ul className="list-rows" role="list">
        {members.map((c) => (
          <li key={c.key}>
            <button type="button" className="row" onClick={() => onPick(c.key)}>
              <Avatar name={c.name || c.prefix} type={c.type} size={32} />
              <span className="row-main">
                <span className="row-title">{c.name || c.prefix}</span>
                <span className="row-sub muted">{kindLabel(c.type)}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---- the phone ----

type Detent = "peek" | "half" | "full";
const DETENTS: Detent[] = ["peek", "half", "full"];
let lastDetent: Detent = "half";

/** A release faster than this, in pixels a millisecond, carries the sheet on to the next position that way. */
const FLICK = 0.4;
/** Below its lowest position the sheet still follows the finger, but only this share of the way. */
const OVERPULL = 0.3;

/**
 * The Mesh tab on a phone: the map, and the list in a sheet with three
 * positions. The sheet keeps its full height and slides, so following a
 * finger moves one layer instead of laying the list out again every frame.
 * It is pulled by its handle, or by the list itself wherever the list is not
 * scrolling: anywhere below the top position, and down from the list's top.
 */
export function MeshPhone({ hidden = false }: { hidden?: boolean | undefined }) {
  const nav = useNav();
  const state = useSession();
  const box = useRef<HTMLDivElement>(null);
  const inset = useRef<HTMLDivElement>(null);
  const sheet = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const head = useRef<HTMLDivElement>(null);
  // The box's height, how much of its top the notch or the status bar takes, where the chips end in
  // the sheet, and how tall the tool or the list of nodes at one spot is.
  const [space, setSpace] = useState({ height: 0, top: 0, peek: 0, card: 0 });
  const [detent, setDetentState] = useState<Detent>(() => (Object.values(state.contacts).some((c) => hasPosition(c.lat, c.lon)) ? lastDetent : "full"));
  const [group, setGroup] = useState<string[] | null>(null);
  const tool = useMeshTool();
  const focus = nav.meshFocus && state.contacts[nav.meshFocus] ? nav.meshFocus : null;
  const listed = !group && !tool;
  const setDetent = (d: Detent) => {
    lastDetent = d;
    setDetentState(d);
  };

  // Back puts away what covers the map: the list of nodes at one spot, or the list pulled all the way up.
  const mapped = Object.values(state.contacts).some((c) => hasPosition(c.lat, c.lon));
  useBackLayer(!hidden && group !== null, () => setGroup(null));
  useBackLayer(!hidden && listed && mapped && detent === "full", () => setDetent("half"));
  useBackLayer(!hidden && tool !== null, closeTool);

  // A pick leaves some map in view, ringed with its route, when the list was pulled all the way up: back from
  // its profile, or "On map" in a profile. Decided while rendering, so the map learns in the same pass how much
  // the sheet covers.
  const [picked, setPicked] = useState(focus);
  if (picked !== focus) {
    setPicked(focus);
    if (focus && detent === "full") setDetent("half");
  }
  if (!hidden && takeListLowered() && detent !== "peek") setDetent("peek");
  // A tool opens over the map at its own height; so does a link between neighbours.
  // A survey's own sheets (running, after, a point, its files) each open at their height too.
  const toolId = tool ? (tool.kind === "neighbours" ? `neighbours:${tool.key}:${tool.link ?? ""}` : tool.kind === "survey" ? `survey:${tool.view}:${tool.point ?? ""}` : tool.kind) : null;
  const [shownTool, setShownTool] = useState(toolId);
  if (shownTool !== toolId) {
    const opened = !!tool && (shownTool?.split(":")[0] !== tool.kind || (tool.kind === "neighbours" && tool.link !== null) || tool.kind === "survey");
    setShownTool(toolId);
    if (opened && detent !== "half") setDetent("half");
  }

  useLayoutEffect(() => {
    const el = box.current;
    const probe = inset.current;
    if (!el || !probe) return;
    const measure = () => {
      const height = el.clientHeight;
      const top = probe.offsetHeight;
      // Hidden under a profile the box has no height; what it had is what it will have again.
      if (height === 0) return;
      setSpace((s) => (s.height === height && s.top === top ? s : { ...s, height, top }));
    };
    const resize = new ResizeObserver(measure);
    resize.observe(el);
    resize.observe(probe);
    measure();
    return () => resize.disconnect();
  }, []);

  // The lowest position shows the search, and the chips of a changed filter when there are some, and stops
  // before the first line of the list. A new text size moves where they end; hidden, the sheet has nowhere to measure.
  const textScale = useSyncExternalStore(subscribeTextSize, getTextScale);
  const filtered = useFilterChanged();
  useLayoutEffect(() => {
    const el = sheet.current;
    const scroller = body.current;
    const top = head.current;
    if (!el || !scroller || !top || !listed || space.height === 0 || hidden) return;
    const chips = scroller.querySelector<HTMLElement>(".chips");
    const edge = chips ? chips.getBoundingClientRect().bottom + scroller.scrollTop : top.getBoundingClientRect().bottom;
    const peek = Math.round(edge - el.getBoundingClientRect().top);
    setSpace((s) => (s.peek === peek ? s : { ...s, peek }));
  }, [listed, space.height, hidden, textScale, filtered]);

  // A tool or the list of nodes at one spot sits at its own height instead of the list's middle one, so more
  // of the map shows around it.
  useLayoutEffect(() => {
    const el = sheet.current;
    const card = listed ? null : body.current?.firstElementChild;
    if (!el || !card) return;
    const measure = () => {
      const h = Math.round(card.getBoundingClientRect().bottom - el.getBoundingClientRect().top + (body.current?.scrollTop ?? 0));
      setSpace((s) => (s.card === h ? s : { ...s, card: h }));
    };
    const resize = new ResizeObserver(measure);
    resize.observe(card);
    measure();
    return () => resize.disconnect();
  }, [listed, group, toolId]);

  const full = Math.max(0, space.height - space.top - 8);
  const middle = Math.max(0, Math.min(full - 48, Math.max(240, Math.round(space.height * 0.46))));
  const peek = Math.max(0, Math.min(middle - 48, space.peek || 104));
  const half = !listed && space.card ? Math.max(peek + 48, Math.min(middle, space.card)) : middle;
  const heights: Record<Detent, number> = { peek, half, full };

  // What the handlers read, so the listeners on the list are set once.
  const live = useRef({ detent, heights, setDetent });
  live.current = { detent, heights, setDetent };

  const motion = useMemo(() => {
    let drag: { from: number; h: number; now: number; moved: boolean; trail: { y: number; t: number }[] } | null = null;
    const place = (el: HTMLElement, h: number) => {
      el.style.transform = `translate3d(0, ${live.current.heights.full - h}px, 0)`;
    };
    const begin = (y: number) => {
      const el = sheet.current;
      if (!el) return;
      const { detent, heights } = live.current;
      // Caught while it is still settling, the sheet is taken from where it is.
      const shift = new DOMMatrixReadOnly(getComputedStyle(el).transform).m42;
      const h = Number.isFinite(shift) ? heights.full - shift : heights[detent];
      drag = { from: y, h, now: h, moved: false, trail: [{ y, t: performance.now() }] };
      el.style.transition = "none";
      place(el, h);
    };
    const follow = (y: number) => {
      const el = sheet.current;
      if (!drag || !el) return;
      const { heights } = live.current;
      const t = performance.now();
      drag.trail.push({ y, t });
      while (drag.trail.length > 2 && t - drag.trail[0]!.t > 100) drag.trail.shift();
      if (Math.abs(y - drag.from) > 4) drag.moved = true;
      let h = Math.min(heights.full, drag.h - (y - drag.from));
      if (h < heights.peek) h = heights.peek - (heights.peek - h) * OVERPULL;
      drag.now = h;
      place(el, h);
    };
    /**
     * Lets go at the position the sheet was flung towards, or else the nearest; a tap on the handle
     * steps on to the next.
     */
    const release = (tap: boolean) => {
      const d = drag;
      const el = sheet.current;
      drag = null;
      if (!d || !el) return;
      const { detent, heights, setDetent } = live.current;
      let target: Detent = detent;
      if (!d.moved) {
        if (tap) target = detent === "peek" ? "half" : detent === "half" ? "full" : "peek";
      } else {
        const first = d.trail[0]!;
        const last = d.trail.at(-1)!;
        // A finger that stopped before it lifted flings nothing.
        const v = performance.now() - last.t < 80 && last.t > first.t ? (last.y - first.y) / (last.t - first.t) : 0;
        if (v < -FLICK) target = DETENTS.find((k) => heights[k] > d.now + 2) ?? "full";
        else if (v > FLICK) target = [...DETENTS].reverse().find((k) => heights[k] < d.now - 2) ?? "peek";
        else target = DETENTS.reduce((a, b) => (Math.abs(heights[b] - d.now) < Math.abs(heights[a] - d.now) ? b : a));
      }
      el.style.transition = "";
      place(el, heights[target]);
      setDetent(target);
    };
    return { begin, follow, release };
  }, []);

  // The list pulls the sheet by touch; a mouse has the handle and the wheel.
  useEffect(() => {
    const el = body.current;
    if (!el) return;
    let start: { x: number; y: number } | null = null;
    let dragging = false;
    // How far the finger went, from where it came down.
    let from = 0;
    let travel = 0;
    const swallow = (e: Event) => {
      e.stopPropagation();
      e.preventDefault();
    };
    const down = (e: TouchEvent) => {
      const t = e.touches[0];
      start = e.touches.length === 1 && t ? { x: t.clientX, y: t.clientY } : null;
      if (e.touches.length > 1 && dragging) {
        dragging = false;
        motion.release(false);
      }
    };
    const move = (e: TouchEvent) => {
      const t = e.touches[0];
      if (!t) return;
      if (start) {
        const dx = t.clientX - start.x;
        const dy = t.clientY - start.y;
        if (!dx && !dy) return;
        from = start.y;
        travel = 0;
        start = null;
        // Decided on the first move, while the page can still be told not to scroll. Sideways scrolls
        // the chips; at the top position the list scrolls, unless it is pulled down from its top.
        if (Math.abs(dx) > Math.abs(dy)) return;
        if (live.current.detent === "full" && (dy < 0 || el.scrollTop > 0)) return;
        dragging = true;
        motion.begin(from);
      }
      if (!dragging) return;
      e.preventDefault();
      travel = Math.max(travel, Math.abs(t.clientY - from));
      motion.follow(t.clientY);
    };
    const up = () => {
      start = null;
      if (!dragging) return;
      dragging = false;
      motion.release(false);
      // A pull that ends over a row does not open it; a tap whose finger shook a little still does.
      if (travel <= 10) return;
      el.addEventListener("click", swallow, { capture: true, once: true });
      setTimeout(() => el.removeEventListener("click", swallow, { capture: true }), 400);
    };
    el.addEventListener("touchstart", down, { passive: true });
    el.addEventListener("touchmove", move, { passive: false });
    el.addEventListener("touchend", up);
    el.addEventListener("touchcancel", up);
    return () => {
      el.removeEventListener("touchstart", down);
      el.removeEventListener("touchmove", move);
      el.removeEventListener("touchend", up);
      el.removeEventListener("touchcancel", up);
    };
  }, [motion]);

  // A node tapped in the list or on the map opens its profile, as on a desktop; Back comes to the map with the
  // node still ringed.
  const pick = (key: string | null) => {
    setGroup(null);
    if (key) openProfile(key, true);
    else focusOnMap(null);
  };

  return (
    <div className="mesh-phone" ref={box} hidden={hidden} data-detent={detent}>
      <div className="mesh-inset" ref={inset} aria-hidden="true" />
      {/* Not before the sheet is measured, so the map's first view is fitted to the part left uncovered. */}
      {space.height ? (
        <MeshMap
          selected={focus}
          onSelect={pick}
          onGroup={(keys) => {
            setGroup(keys);
            focusOnMap(null);
            if (detent !== "half") setDetent("half");
          }}
          coverTop={space.top}
          coverBottom={heights[detent]}
          active={!hidden}
        />
      ) : null}
      <div ref={sheet} className="mesh-sheet" style={{ height: full, transform: `translate3d(0, ${full - heights[detent]}px, 0)` }}>
        <div
          ref={head}
          className="mesh-sheet-head"
          onPointerDown={(e) => {
            if (e.button !== 0 || (e.target as HTMLElement).closest("input, button, label")) return;
            e.currentTarget.setPointerCapture(e.pointerId);
            motion.begin(e.clientY);
          }}
          onPointerMove={(e) => motion.follow(e.clientY)}
          onPointerUp={() => motion.release(true)}
          onPointerCancel={() => motion.release(false)}
        >
          <div className="sheet-grab" />
          {listed ? (
            <div className="mesh-sheet-tools">
              <MeshSearchInline onFocus={() => detent !== "full" && setDetent("full")} />
              <FilterButton />
            </div>
          ) : null}
        </div>
        <div className="mesh-sheet-body" ref={body}>
          {tool ? (
            <ToolPanel tool={tool} />
          ) : group ? (
            <GroupList keys={group} onPick={pick} onClose={() => setGroup(null)} />
          ) : (
            <MeshListBodyNoSearch selected={focus} onOpen={pick} />
          )}
          {/* The part of the sheet below the screen's edge, so the end of the list can be scrolled into view. */}
          <div aria-hidden="true" style={{ height: full - heights[detent] }} />
        </div>
      </div>
      <FilterSheetHost />
    </div>
  );
}

function MeshSearchInline({ onFocus }: { onFocus: () => void }) {
  const { query } = useFilter();
  return (
    <SearchField value={query} onFocus={onFocus} onValue={(next) => setFilter({ query: next })} note={<MeshCount />} placeholder={t("mesh.find")} aria-label={t("mesh.find")} enterKeyHint="search" />
  );
}

/** The list without its own search field: in the sheet, the field sits in the handle. */
function MeshListBodyNoSearch({ selected, onOpen }: { selected: string | null; onOpen: (key: string) => void }) {
  return (
    <div className="mesh-sheet-list">
      <MeshListBody selected={selected} onOpen={onOpen} hideSearch />
    </div>
  );
}
