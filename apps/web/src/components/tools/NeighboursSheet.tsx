/**
 * A repeater's neighbours over the map: how many it hears and how well, the
 * list strongest first or heard last first, and the rest of it on its way. A funnel narrows the
 * map and the list by signal, distance and how lately heard. A neighbour tapped,
 * in the list or on the map, opens the link between the two: how each hears
 * the other, a check both ways from this radio, and the terrain between.
 * Back steps from the link to the list, and from the list to where it was
 * opened from.
 */

import { useEffect, useState } from "react";
import type { ContactRecord } from "@meshnet/meshcore";
import { t } from "../../i18n/index.js";
import { nameOfHash } from "../../lib/echoes.js";
import { profileBetween } from "../../lib/elevation.js";
import { agoPhrase } from "../../lib/format.js";
import { bearingDeg, compass, distanceKm, formatDistance, formatRoundDistance } from "../../lib/geo.js";
import { lineOfSight, quality, verdictWord, type LineOfSight, type LinkRadio, type Profile } from "../../lib/los.js";
import { contactEnd } from "../../lib/mapOverlay.js";
import type { LosEnd, NeighboursTool } from "../../lib/meshTool.js";
import { openProfile } from "../../lib/nav.js";
import { fetchAllNeighbours, useNeighbourFetch } from "../../lib/neighbourFetch.js";
import { heardInList, isComplete, isFiltering, kmTicks, kmToPlace, neighbourRows, NO_FILTER, PAGE, passes, placeToKm, scaleKm, withinDistance, type NeighbourFilter, type NeighbourRow } from "../../lib/neighbours.js";
import { NEIGHBOUR_SORTS, setNeighbourSort, useNeighbourSort } from "../../lib/neighbourSort.js";
import { measuredLegs, ping, ROUNDS, spanKey, stopPing, usePing } from "../../lib/ping.js";
import { useSession } from "../../lib/session.js";
import { toast } from "../../lib/toast.js";
import { closeAllTools, closeTool, fitNeighbours, openLineOfSight, openNeighbourLink, openNeighboursOf, setNeighbourFilter } from "../../lib/toolActions.js";
import { Button, IconButton } from "../../ui/Button.js";
import { Group, InfoRow, LinkRow } from "../../ui/List.js";
import { showMenu } from "../../ui/Menu.js";
import { MarkedSlider } from "../../ui/Slider.js";
import { Avatar } from "../Avatar.js";
import { AirIcon, BackIcon, ChevronDownIcon, ChevronRightIcon, CloseIcon, FilterIcon, LockIcon, RefreshIcon, SortIcon } from "../Icons.js";
import { SignIn } from "../node/SignIn.js";
import { antennaHeight } from "./LosView.js";
import { chainEnds, CheckResult, QualityChip, SheetHead } from "./RouteSheet.js";

/** The firmware keeps this many neighbours at most. */
const KEPT = 50;

export function NeighboursSheet({ tool }: { tool: NeighboursTool }) {
  return tool.link ? <LinkCard key={tool.link} tool={tool} link={tool.link} /> : <NeighbourList tool={tool} />;
}

const nameOf = (c: ContactRecord) => c.name || c.prefix;

function heardWhen(heardS: number, now: number): string {
  return t("tools.nb.heard", { time: agoPhrase(now - heardS * 1000, now) });
}

function NeighbourList({ tool }: { tool: NeighboursTool }) {
  const state = useSession();
  const fetch = useNeighbourFetch(tool.key);
  const [offOpen, setOffOpen] = useState(false);
  const [sifting, setSifting] = useState(false);
  const sort = useNeighbourSort();
  const hub = state.contacts[tool.key];
  const hubName = hub ? nameOf(hub) : t("tools.nb.theRepeater");
  const list = state.neighbours[tool.key];
  const now = Date.now();
  const all = neighbourRows(state, tool.key, now, sort);
  const filter = tool.filter ?? null;
  const filtering = isFiltering(filter);
  const rows = all.filter((r) => passes(r, filter));
  const placed = rows.filter((r) => r.placed);
  const off = rows.filter((r) => !r.placed);
  const online = state.status === "ready";
  const running = fetch?.running ?? false;
  const complete = isComplete(list);
  const counts = { good: 0, fair: 0, weak: 0 };
  for (const r of placed) counts[quality(r.snr)]++;
  const away = (r: NeighbourRow) => (r.km !== null ? formatDistance(r.km) : null);

  const sub = !list
    ? running
      ? t("tools.nb.asking", { name: hubName })
      : t("tools.nb.notAsked")
    : complete
      ? filtering
        ? t("tools.nb.subFiltered", { total: list.total, shown: placed.length, placed: all.filter((r) => r.placed).length, time: agoPhrase(list.at, now) })
        : t("tools.nb.subComplete", { total: list.total, placed: placed.length, time: agoPhrase(list.at, now) })
      : t("tools.nb.soFar", { count: list.neighbours.length, total: list.total });
  const funnel = all.length ? (
    <IconButton label={t("tools.nb.filter")} className={["nb-filter-button", sifting ? "on" : ""].join(" ")} aria-expanded={sifting} onClick={() => setSifting(!sifting)}>
      <FilterIcon size={18} />
      {filtering && !sifting ? <span className="nb-filter-dot" aria-hidden="true" /> : null}
    </IconButton>
  ) : null;
  const missing = list ? list.total - list.neighbours.length : 0;

  let progress: React.ReactNode = null;
  if (running && list && !complete) {
    progress = (
      <div className="nb-progress">
        <span className="nb-progress-line">
          {t("tools.nb.gettingRest", { count: list.neighbours.length, total: list.total })}
          <span className="spinner" aria-hidden="true" />
        </span>
        <span className="nb-progress-bar" aria-hidden="true">
          <i style={{ width: `${(list.neighbours.length / Math.max(1, list.total)) * 100}%` }} />
        </span>
      </div>
    );
  } else if (!running && fetch?.error) {
    progress = (
      <div className="nb-progress bad">
        <span className="nb-progress-line">
          {fetch.silent ? (missing > 0 ? t("tools.nb.noAnswerMissing", { name: hubName, missing }) : t("tools.nb.noAnswer", { name: hubName })) : fetch.error}
          <Button size="sm" disabled={!online} onClick={() => void fetchAllNeighbours(tool.key)}>
            <RefreshIcon size={13} />
            {t("common.tryAgain")}
          </Button>
        </span>
      </div>
    );
  } else if (!running && list && !complete) {
    progress = (
      <div className="nb-progress">
        <span className="nb-progress-line">
          {online ? t("tools.nb.moreToFetch", { count: missing }) : t("tools.nb.moreOffline", { count: missing })}
          {online ? (
            <Button size="sm" onClick={() => void fetchAllNeighbours(tool.key)}>
              {t("tools.nb.getRest")}
            </Button>
          ) : null}
        </span>
      </div>
    );
  }

  const pages = Math.max(1, Math.ceil((list?.total ?? PAGE) / PAGE));
  return (
    <div className="tool nb-sheet">
      <SheetHead title={t("tools.nb.title", { name: hubName })} sub={sub} onBack={closeTool} action={funnel} />
      {sifting ? <FilterPanel hubName={hubName} rows={all} filter={filter ?? NO_FILTER} onDone={() => setSifting(false)} /> : filtering ? <FilterPills filter={filter!} onOpen={() => setSifting(true)} /> : null}
      {filtering && all.length && !rows.length ? <p className="tool-note muted">{t("tools.nb.nobody")}</p> : null}
      {placed.length || rows.length > 1 ? (
        <div className="nb-summary">
          {placed.length ? (
            <>
              <span><i className="good" />{t("tools.nb.good", { count: counts.good })}</span>
              <span><i className="fair" />{t("tools.nb.fair", { count: counts.fair })}</span>
              <span><i className="weak" />{t("tools.nb.weak", { count: counts.weak })}</span>
              {off.length ? <span>· {t("tools.nb.offMap", { count: off.length })}</span> : null}
            </>
          ) : null}
          {rows.length > 1 ? <SortButton /> : null}
        </div>
      ) : null}
      {progress}
      {list && list.total === 0 ? <p className="tool-note muted">{t("tools.nb.none")}</p> : null}
      {placed.length ? (
        <ul className="list-rows nb-rows" role="list">
          {placed.map((r) => {
            const c = r.contact!;
            const far = away(r);
            return (
              <li key={r.prefix}>
                <button type="button" className="row" onClick={() => openNeighbourLink(c.key)}>
                  <Avatar name={nameOf(c)} type={c.type} size={32} />
                  <span className="row-main">
                    <span className="row-title">{nameOf(c)}</span>
                    <span className={["row-sub", r.stale ? "nb-gone" : "muted"].join(" ")}>{r.stale ? t("tools.nb.mayBeGone", { heard: heardWhen(r.heardS, now) }) : [heardWhen(r.heardS, now), far].filter(Boolean).join(" · ")}</span>
                  </span>
                  <QualityChip snr={r.snr} />
                  <ChevronRightIcon size={14} className="line-chev" />
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
      {off.length ? (
        <>
          <button type="button" className="nb-off-toggle" aria-expanded={offOpen} onClick={() => setOffOpen(!offOpen)}>
            <span className="grow">{t("tools.nb.notOnMap", { count: off.length })}</span>
            {offOpen ? <ChevronDownIcon size={14} /> : <ChevronRightIcon size={14} />}
          </button>
          {offOpen ? (
            <ul className="list-rows nb-rows" role="list">
              {off.map((r) => (
                <li key={r.prefix}>
                  {r.contact ? (
                    <button type="button" className="row" onClick={() => openNeighbourLink(r.contact!.key)}>
                      <Avatar name={nameOf(r.contact)} type={r.contact.type} size={32} />
                      <span className="row-main">
                        <span className="row-title">{nameOf(r.contact)}</span>
                        <span className="row-sub muted">{t("tools.nb.noPosition", { heard: heardWhen(r.heardS, now) })}</span>
                      </span>
                      <QualityChip snr={r.snr} />
                      <ChevronRightIcon size={14} className="line-chev" />
                    </button>
                  ) : (
                    <div className="row">
                      <Avatar name={r.prefix} type={2} size={32} />
                      <span className="row-main">
                        <span className="row-title mono">{r.prefix}</span>
                        <span className="row-sub muted">{t("tools.nb.notContact", { heard: heardWhen(r.heardS, now) })}</span>
                      </span>
                      <QualityChip snr={r.snr} />
                    </div>
                  )}
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : null}
      <Button size="lg" busy={running} disabled={!online} onClick={() => void fetchAllNeighbours(tool.key, true)}>
        <RefreshIcon size={16} />
        {running ? t("tools.nb.askingButton") : t("tools.askAgain")}
      </Button>
      <div className="check-cost">
        <AirIcon size={13} />
        {t("tools.nb.cost", { count: pages, name: hubName, max: KEPT })}
      </div>
    </div>
  );
}

/** The list's order, named at the end of the count line, and the menu that changes it. */
function SortButton() {
  const sort = useNeighbourSort();
  const current = NEIGHBOUR_SORTS.find((s) => s.id === sort)!;
  return (
    <button
      type="button"
      className={["sort-btn", "nb-sort", sort !== "signal" ? "changed" : ""].join(" ")}
      aria-label={t("tools.nb.sortLabel", { order: t(current.label).toLowerCase() })}
      onClick={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        showMenu(
          NEIGHBOUR_SORTS.map((s) => ({ label: t(s.label), checked: s.id === sort, onSelect: () => setNeighbourSort(s.id) })),
          { title: t("tools.nb.sortTitle"), at: { x: r.left, y: r.bottom + 4 } },
        );
      }}
    >
      <SortIcon size={14} />
      {t(current.short)}
      <ChevronDownIcon size={12} />
    </button>
  );
}

/** How well the repeater hears, from the bottom of the neighbours page's bars to their top, dB. */
const SNR_LOW = -20;
const SNR_HIGH = 15;
const snrPlace = (snr: number) => (Math.min(SNR_HIGH, Math.max(SNR_LOW, snr)) - SNR_LOW) / (SNR_HIGH - SNR_LOW);
/** In half-dB steps: the list counts in quarters, which a finger cannot pick. */
const snrAt = (place: number) => Math.round((SNR_LOW + place * (SNR_HIGH - SNR_LOW)) * 2) / 2;
const signed = (snr: number) => `${snr > 0 ? "+" : snr < 0 ? "−" : ""}${Math.abs(snr)}`;
const dbText = (snr: number) => t("tools.unit.db", { value: signed(snr) });

/** The distance a filter keeps, in words: from, up to, or between. */
function reachText(f: NeighbourFilter): string {
  if (f.fromKm > 0 && f.toKm !== null) return t("tools.nb.kmSpan", { from: formatRoundDistance(f.fromKm), to: formatRoundDistance(f.toKm) });
  if (f.fromKm > 0) return t("tools.nb.kmFrom", { from: formatRoundDistance(f.fromKm) });
  if (f.toKm !== null) return t("tools.nb.kmTo", { to: formatRoundDistance(f.toKm) });
  return t("tools.nb.anyDistance");
}

function clearFilter(): void {
  setNeighbourFilter(null);
  fitNeighbours();
}

/**
 * The filter, open under the sheet's head (#51): how well the repeater hears
 * a neighbour at worst, how far from it, and whether those not heard for a
 * day stay. Dots over each slider show where the neighbours are on it. The
 * map changes as a thumb moves, and comes to what is left when the distance
 * is let go.
 */
function FilterPanel({ hubName, rows, filter, onDone }: { hubName: string; rows: NeighbourRow[]; filter: NeighbourFilter; onDone: () => void }) {
  const set = (patch: Partial<NeighbourFilter>) => setNeighbourFilter({ ...filter, ...patch });
  const placed = rows.filter((r) => r.km !== null);
  const max = scaleKm(placed);
  const stale = rows.filter((r) => r.stale).length;
  const snrText = filter.minSnr === null ? t("tools.nb.anySignal") : dbText(filter.minSnr);
  const moveReach = ([a, b]: number[]) => {
    const fromKm = a! <= 0 ? 0 : placeToKm(a!, max);
    const toKm = b! >= 1 ? null : Math.max(0.1, placeToKm(b!, max));
    // Rounded to what a finger can pick, the two ends could meet; the step that makes them is not taken.
    if (toKm === null || fromKm < toKm) set({ fromKm, toKm });
  };
  return (
    <div className="nb-filter">
      <div className="nb-filter-head">
        <span>{t("tools.nb.minSnr")}</span>
        <b>{snrText}</b>
      </div>
      <MarkedSlider
        values={[snrPlace(filter.minSnr ?? SNR_LOW)]}
        onChange={([place]) => {
          const snr = snrAt(place!);
          set({ minSnr: snr <= SNR_LOW ? null : snr });
        }}
        marks={rows.map((r) => ({ at: snrPlace(r.snr), tone: quality(r.snr), out: filter.minSnr !== null && r.snr < filter.minSnr }))}
        ticks={[snrPlace(-5), snrPlace(0)]}
        scale={[SNR_LOW, -5, 0, SNR_HIGH].map((v) => ({ at: snrPlace(v), text: v === SNR_HIGH ? dbText(v) : signed(v) }))}
        names={[t("tools.nb.minSnr")]}
        texts={[snrText]}
      />
      {placed.length ? (
        <>
          <div className="nb-filter-head">
            <span>{t("tools.nb.distance", { name: hubName })}</span>
            <b>{reachText(filter)}</b>
          </div>
          <MarkedSlider
            values={[kmToPlace(filter.fromKm, max), filter.toKm === null ? 1 : kmToPlace(filter.toKm, max)]}
            onChange={moveReach}
            onDone={fitNeighbours}
            marks={placed.map((r) => ({ at: kmToPlace(r.km!, max), tone: quality(r.snr), out: !withinDistance(r, filter) }))}
            scale={kmTicks(max).map((k) => ({ at: kmToPlace(k, max), text: k === max ? formatRoundDistance(k) : String(k) }))}
            names={[t("tools.nb.noNearer"), t("tools.nb.noFarther")]}
            texts={[formatRoundDistance(filter.fromKm), filter.toKm === null ? t("tools.nb.anyDistance") : formatRoundDistance(filter.toKm)]}
          />
        </>
      ) : null}
      {stale || filter.recent ? (
        <button type="button" role="switch" aria-checked={filter.recent} className="nb-filter-switch" onClick={() => set({ recent: !filter.recent })}>
          <span className="grow">
            {t("tools.nb.hideStale")} <span className="muted">· {stale}</span>
          </span>
          <span className={["switch", filter.recent ? "on" : ""].join(" ")} aria-hidden="true" />
        </button>
      ) : null}
      <div className="nb-filter-foot">
        <Button size="sm" disabled={!isFiltering(filter)} onClick={clearFilter}>
          {t("tools.nb.reset")}
        </Button>
        <Button size="sm" variant="primary" onClick={onDone}>
          {t("common.done")}
        </Button>
      </div>
    </div>
  );
}

/** A filter at work while its panel is shut: what it keeps, which opens the panel again, and a cross that shows them all. */
function FilterPills({ filter, onOpen }: { filter: NeighbourFilter; onOpen: () => void }) {
  const pills = [filter.minSnr !== null ? t("tools.nb.noWorse", { value: dbText(filter.minSnr) }) : null, filter.fromKm > 0 || filter.toKm !== null ? reachText(filter) : null, filter.recent ? t("tools.nb.recentOnly") : null].filter((p): p is string => p !== null);
  return (
    <div className="nb-filter-pills">
      <button type="button" className="nb-filter-pill-row" onClick={onOpen}>
        {pills.map((p) => (
          <span key={p} className="nb-pill">
            {p}
          </span>
        ))}
      </button>
      <IconButton label={t("tools.nb.clearFilter")} onClick={clearFilter}>
        <CloseIcon size={14} />
      </IconButton>
    </div>
  );
}

function LinkCard({ tool, link }: { tool: NeighboursTool; link: string }) {
  const state = useSession();
  const [signing, setSigning] = useState(false);
  const key = spanKey(tool.key, link);
  const p = usePing(key);
  const hub = state.contacts[tool.key];
  const nb = state.contacts[link];
  if (!hub || !nb) {
    return (
      <div className="tool">
        <SheetHead title={t("tools.link.title")} sub={t("tools.link.gone")} onBack={() => openNeighbourLink(null)} />
      </div>
    );
  }
  const now = Date.now();
  const hubName = nameOf(hub);
  const nbName = nameOf(nb);
  const online = state.status === "ready";
  const row = neighbourRows(state, tool.key, now).find((r) => r.contact?.key === link) ?? null;
  const reverse = heardInList(state, link, tool.key, now);
  const running = p?.running ?? false;
  const legs = measuredLegs(p);
  // The leg between the two, when the check went straight from one to the other: out is how the neighbour heard it, back how the repeater did.
  const direct = p && p.from >= 0 && p.chain.length === p.from + 2 ? (legs[p.from + 1] ?? null) : null;
  const checked = direct && p ? t("tools.link.checked", { time: agoPhrase(p.at, now) }) : null;
  const a = contactEnd(hub);
  const b = contactEnd(nb);
  const where = a && b ? t("tools.link.where", { distance: formatDistance(distanceKm(a.lat, a.lon, b.lat, b.lon)), direction: compass(bearingDeg(a.lat, a.lon, b.lat, b.lon)), name: hubName }) : t("tools.link.noPosition", { name: nbName });
  const signed = !!state.logins[link]?.ok;
  const nbList = state.neighbours[link];
  const openLeg = (index: number) => {
    if (!p) return;
    const ends = chainEnds(p.chain, state);
    const x = ends[index];
    const y = ends[index + 1];
    if (x && y) openLineOfSight(x, y, null, legs[index] ?? null);
  };

  const hubHears = direct?.[1] != null ? { snr: direct[1], hint: checked! } : row ? { snr: row.snr, hint: t("tools.link.fromList", { heard: heardWhen(row.heardS, now), name: hubName }) } : null;
  const nbHears = direct ? { snr: direct[0], hint: checked! } : reverse ? { snr: reverse.snr, hint: t("tools.link.fromList", { heard: heardWhen(reverse.heardS, now), name: nbName }) } : null;

  return (
    <div className="tool nb-link">
      <div className="tool-head">
        <IconButton label={t("tools.link.backToList")} onClick={() => openNeighbourLink(null)}>
          <BackIcon size={18} />
        </IconButton>
        <span className="row-main">
          <span className="row-title">
            {hubName} — {nbName}
          </span>
          <span className="row-sub muted">{where}</span>
        </span>
        <IconButton label={t("common.close")} onClick={closeAllTools}>
          <CloseIcon size={18} />
        </IconButton>
      </div>
      <Group>
        <InfoRow label={t("tools.link.hears", { a: hubName, b: nbName })} hint={hubHears?.hint ?? t("tools.link.notInList")}>
          {hubHears ? <QualityChip snr={hubHears.snr} /> : <span className="muted">—</span>}
        </InfoRow>
        <InfoRow label={t("tools.link.hears", { a: nbName, b: hubName })} hint={nbHears?.hint ?? t("tools.link.notKnown")}>
          {nbHears ? <QualityChip snr={nbHears.snr} /> : <span className="muted">—</span>}
        </InfoRow>
      </Group>
      {row?.stale && !direct ? (
        <p className="nb-warn">{t("tools.link.stale", { hub: hubName, nb: nbName, time: agoPhrase(now - row.heardS * 1000, now) })}</p>
      ) : null}
      {p ? <CheckResult p={p} names={[t("tools.you"), ...p.chain.map((h) => nameOfHash(h, state.contacts) ?? h)]} reach={null} placed onLeg={openLeg} /> : null}
      <Button variant={running ? "default" : "primary"} size="lg" disabled={!online} onClick={() => (running ? stopPing(key) : void ping(key))}>
        {running ? null : <AirIcon size={16} />}
        {running ? t("tools.stop") : p ? t("tools.link.checkAgain") : t("tools.link.checkBoth")}
      </Button>
      <div className="check-cost">
        <AirIcon size={13} />
        {t("tools.link.cost", { count: ROUNDS, name: hubName })}
      </div>
      {a && b ? <Terrain a={a} b={b} heard={direct} /> : null}
      <Group>
        <LinkRow icon={<Avatar name={nbName} type={nb.type} size={26} />} label={nbName} hint={t("tools.link.profile")} onClick={() => openProfile(link)} />
        <LinkRow
          label={t("tools.link.neighbours", { name: nbName })}
          hint={signed ? (nbList ? t("tools.link.neighboursHint", { total: nbList.total, time: agoPhrase(nbList.at, now) }) : t("tools.nb.notAsked")) : t("tools.link.signInToSee", { name: nbName })}
          trailing={signed ? undefined : <LockIcon size={14} className="line-chev" />}
          disabled={!signed && !online}
          onClick={() => (signed ? openNeighboursOf(link) : setSigning(true))}
        />
      </Group>
      <SignIn
        open={signing}
        nodeKey={link}
        onClose={() => setSigning(false)}
        onSignedIn={() => {
          setSigning(false);
          toast(t("tools.signedIn", { name: nbName }));
          openNeighboursOf(link);
        }}
      />
    </div>
  );
}

/** The ground between the two, small, with what the line of sight makes of it; a tap opens it whole. */
function Terrain({ a, b, heard }: { a: LosEnd; b: LosEnd; heard: [number, number | null] | null }) {
  const state = useSession();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    setProfile(null);
    setFailed(false);
    profileBetween(a, b)
      .then((p) => live && setProfile(p))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
    // A new pair of ends reads the terrain again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [a.lat, a.lon, b.lat, b.lon]);
  const self = state.self;
  const radio: LinkRadio | null = self ? { frequencyKhz: self.frequencyKhz, bandwidthHz: self.bandwidthHz, spreadingFactor: self.spreadingFactor, codingRate: self.codingRate, txPowerDbm: self.txPower } : null;
  const ha = antennaHeight(a, state.contacts);
  const hb = antennaHeight(b, state.contacts);
  const los = profile && radio ? lineOfSight(profile, ha, hb, radio) : null;
  const label = los ? <span className={`nb-verdict ${los.verdict}`}>{verdictWord(los.verdict)}</span> : failed ? t("tools.los.title") : t("tools.los.reading");
  return (
    <Group>
      <LinkRow label={label} hint={t("tools.link.losHint", { a: ha, b: hb })} onClick={() => openLineOfSight(a, b, null, heard)} />
      {los ? (
        <div className="nb-terrain">
          <MiniProfile los={los} />
        </div>
      ) : null}
    </Group>
  );
}

function MiniProfile({ los }: { los: LineOfSight }) {
  const W = 300;
  const H = 56;
  const pts = los.points;
  const D = pts.at(-1)!.d || 1;
  const lo = Math.min(...pts.map((p) => p.ground)) - 4;
  const hi = Math.max(...pts.map((p) => Math.max(p.ground, p.line + p.fresnel))) + 4;
  const X = (d: number) => (d / D) * W;
  const Y = (h: number) => H - ((h - lo) / Math.max(1, hi - lo)) * H;
  const f = (v: number) => v.toFixed(1);
  const ground = pts.map((p) => `${f(X(p.d))},${f(Y(p.ground))}`).join(" ");
  const zone = [...pts.map((p) => `${f(X(p.d))},${f(Y(p.line + p.fresnel))}`), ...[...pts].reverse().map((p) => `${f(X(p.d))},${f(Y(p.line - p.fresnel))}`)].join(" ");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
      <polygon className="los-zone" points={zone} />
      <polygon className="los-ground" points={`0,${H} ${ground} ${W},${H}`} />
      <line className="los-line" x1={0} y1={f(Y(pts[0]!.line))} x2={W} y2={f(Y(pts.at(-1)!.line))} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
